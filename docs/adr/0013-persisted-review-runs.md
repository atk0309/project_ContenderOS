# ADR 0013: Persisted review runs (latest-only snapshot), decoupled from history

Status: accepted  
Superseded-in-part: [ADR 0014](0014-incremental-apply-keeps-surviving-notes.md) — apply now RESOLVES
the applied threads in place and keeps the review row (marking `resolvedAnchorIds`) instead of
deleting it; resurrection protection moved from the delete to a live-CV guard on `save_review`.  
Superseded-in-part: [ADR 0015](0015-durable-derived-diff.md) — the Diff is now durable **by
derivation** from the persisted `reviewedText` baseline; the "no durable Diff / Diff stays transient"
premise below no longer holds for the Diff (the `cv_reviews` latest-only-snapshot decision and the
Gatekeeper's transience stand).  
Date: 2026-07-02

## Context

ADR 0010 made AI reviews **transient**: the fan-out streamed `AgentReport`s over SSE, the client
held the `ReviewBundle`, and nothing was persisted. ADR 0011 §2 built the design surfaces
(Gatekeeper verdict, Diff) as **same-session, per-CV subviews** on that transient premise. In use
this loses work the candidate cares about: navigating away from the workspace, or reloading, throws
away a (billed) review run and every accept/reject decision the owner had made against its findings.
The owner reversed the transient-reviews decision — a review run and its per-finding decisions must
now survive navigation.

Forces:

1. **No history is wanted, only the latest run.** There is no CV snapshot/version history (still
   deferred, `data-model.md`), no `gkList` cross-application grid, and no durable Diff. Persisting a
   run log would pull all of that in. Only the *latest* run per CV needs to survive.
2. **No schema migration of an existing table (ADR 0006).** `create_all` adds missing *tables*, never
   a column to the deployed `stored_cvs`. Anything persisted must be a new table.
3. **The billed fan-out streams, then the relay closes the session.** `sse_stream.py` breaks the
   relay on the terminal `RunDone` and its `finally:` cancels the execute task and closes the stream
   session. A naive "persist after RunDone" or a bare `asyncio.shield` can orphan the commit on a
   session the relay is about to close.
4. **A completed run must never turn a save hiccup into a 500.** The provider work already happened
   (and was billed); a persistence failure is not a reason to fail the response — but the client
   must still be able to tell the review isn't restorable (invariant 5: surface, don't lie).
5. **The provenance gate stays server-side (invariant 2) and tenancy per-request (invariant 8).**

## Decision

- **A `cv_reviews` snapshot table — latest-run-only, one row per CV** (`cv_id` PK, workspace-scoped;
  additive `create_all`, mirrors the `cv_job_specs` satellite precedent). It stores the camelCase
  `bundle` (the `ReviewBundle` as reviewed), a promoted `cv_version`, `reviewed_text`
  (`bulletId -> text` at review time, server-derived), and `decisions`
  (`threadKey -> accepted|rejected`). It is **explicitly DECOUPLED from history**: no run history, no
  `gkList`, and **no durable Diff** — the Diff stays a client-derived, transient pre-vs-post-apply
  view (ADR 0011 §2 holds for Diff).

- **Persist at settle on BOTH arms, in the route layer** (`run_review` stays session-free; keeping
  persistence out of `app/ai/agents/` also avoids the `ai-agent-change` doc rule). The blocking arm
  saves after `run_review` returns; the SSE arm **persists BEFORE emitting `RunDone`**.

- **SSE persist-before-emit + await-on-cancel.** The save is an `asyncio.ensure_future` awaited under
  `asyncio.shield`; on `CancelledError` (client disconnect mid-save) the arm `await`s the save to
  completion on the still-open session before propagating the cancel, so the commit is never orphaned
  on a session the relay then closes.

- **Aborted runs persist nothing.** A client disconnect still cancels the billed provider work (the
  spine's `finally: task.cancel()`); a fan-out that fails or is aborted before it produces a bundle
  writes no row.

- **Save failure never 500s.** On the blocking arm a save failure returns **200 + the bundle** with a
  **`X-Review-Saved: false`** response header. On the SSE arm it emits **`RunDone(ok=True,
  detail="save_failed")`** (the run *did* succeed — invariant 5 surfaces the save fault via the
  `detail`, without lying that the run failed; the S4 client renders it and suppresses decision PUTs).

- **The conditional save-failure tombstone.** A save failure that follows an *older* stored run would
  otherwise leave that stale run to be silently "restored" on the next load. So on a save failure the
  route, after an ordered `log → rollback → …`, best-effort deletes the pre-save row **conditional on
  its captured `updated_at`** — deleting only the run that was there before the failed save, never a
  NEWER run a concurrent tab may have written mid-failure. The rollback must precede the delete: a
  commit-time failure leaves a `PendingRollback` session on a real DB error.

- **`save_review` is lockless; the orphan row is accepted.** Unlike `master_store`, `save_review`
  takes no advisory lock (it keeps the `IntegrityError` first-save backstop's shape, without the lock
  reacquire). The insert path is a guarded `INSERT … FROM SELECT` against the CV row itself
  (`stored_cvs.version <= reviewed version`), so a settle racing a CV delete inserts nothing and
  a run settling after `apply_corrections` (which since **ADR 0014** RESOLVES the review in place and
  bumps the CV version in one commit — it no longer deletes it) cannot resurrect consumed notes. The
  **same live-CV guard now also rides the `cond_update` arm** (ADR 0014), so a stale settle at the
  kept row's version is refused (`ReviewSuperseded`) rather than overwriting it — both refusals
  surface as `save_failed`. The read paths keep the orphan self-heal as defense-in-depth for legacy
  rows (GET deletes + reads null; the decisions PUT 404s), so orphan content is never served. Two
  later hardenings ride the same review: `save_review` refuses to REGRESS a row to an older
  `cv_version` (`ReviewSuperseded` → the route surfaces `save_failed`; a slow stale-tab run can't
  clobber a fresh re-run), and the tombstone's `updated_at` capture happens BEFORE the fan-out, so a
  row saved by a concurrent tab during the run can never be tombstoned.

- **Decisions are client-synced LWW snapshots (invariant 7).** `PUT .../review/decisions` reassigns
  the whole `decisions` blob (last-write-wins at the same review version — invariant 7's designated
  snapshot write; a small set of owner sessions, no CRDT). The keys are
  opaque to the server. The settle upsert **resets `decisions` on every re-run** (a fresh run
  invalidates prior verdicts); a decisions PUT whose `cvVersion` no longer matches the stored run is a
  **409** (server-side defense), while the same-version cross-tab residual is accepted LWW. The row is
  deleted alongside the CV (`cv_store.delete_cv`, `application_store.delete_application`); at apply it
  is **RESOLVED in place, not deleted** (ADR 0014 — `apply_corrections` marks `resolvedAnchorIds` and
  keeps the row), so a reload can't resurrect consumed notes yet the candidate's other notes survive.

- **`/apply` keeps the client `AcceptedThread` echo.** The Corrector apply path still takes the
  client's accepted threads as INPUT; the server re-grounds them against stored truth, so the
  provenance gate (invariant 2) is intact. ADR 0014 resolves the applied bullets on the stored review
  row (marking `resolvedAnchorIds`); per-thread resolution from a stored thread id remains deferred.

## Options considered

- **A: Keep reviews transient (ADR 0010).** Simplest, but loses billed runs + owner decisions on
  navigation — the thing the owner rejected.
- **B (chosen): Latest-only snapshot, decoupled from history.** Survives navigation with one additive
  table and no speculative history/versioning; the persist-before-emit + tombstone machinery is the
  cost.
- **C: Persist a full run history (+ `gkList`, durable Diff, CV snapshots).** Largest scope; pulls in
  versioning work (and reviewer collaboration, since removed outright — DevPR41) — deferred to a
  future ADR.

## Consequences

- Easier: a review run and its accept/reject decisions survive reload/navigation; the rehydrate probe
  reads `GET .../review` (200-null when absent, so no console noise) and self-heals a schema-skewed
  stored bundle to "no review".
- Harder/constrained: a billed run that fails to save is surfaced (`X-Review-Saved: false` /
  `RunDone.detail="save_failed"`) rather than hidden or 500'd; a rare settle-vs-delete race can leave
  an accepted (unreachable) orphan row.
- Unchanged: the sign-off gate (invariant 2) is still the only export block — reviews remain advisory;
  the Diff stays transient; run history, `gkList`, and CV versioning remain deferred.

## Links

`backend/app/persistence/{models.py, review_store.py}`, `backend/app/routes/cv.py`,
`backend/app/schema/reviews.py`, ADR 0010 (transient reviews — superseded in part), ADR 0011
(transient Gatekeeper/Diff — superseded in part), ADR 0006 (additive `create_all`),
`docs/invariants.md` (2, 5, 7, 8), `docs/architecture/data-model.md`.
