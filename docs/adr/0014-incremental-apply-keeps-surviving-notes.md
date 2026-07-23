# ADR 0014: Incremental apply — resolve the applied note, keep the rest

Status: accepted  
Superseded-in-part: [ADR 0016](0016-drifted-review-stays-visible.md) — the frontend no longer HIDES the version-drifted whole-CV verdict behind the freshness gate; a drifted review stays visible, stale-marked. Resolve-in-place, `resolved_anchor_ids`, and the guard move stand.  
Date: 2026-07-02

## Context

ADR 0013 persisted the latest review run and, at apply, **deleted the whole `cv_reviews` row** and
bumped the CV version in one commit — a *batch* model built for the rail's "Apply corrections (N)"
button. DevPR17 then added an in-paper single-marker **Accept & fix**, which reused that same
teardown. The result the candidate sees: clicking one bullet's fix **wipes every advisory badge on
the paper** (and the frontend independently `setReview(null)`s), so working through notes one at a
time is impossible — you lose all the others the moment you apply one. It is also **slow** (a
whole-CV Corrector round-trip), addressed separately in the fast-apply slice.

The intent: applying one advisory should resolve **only** that bullet (its badge flips to a "done ✓"
chip that clears on the next review run) and leave every other advisory live.

Forces:

1. **The row-delete was load-bearing for resurrection protection — but not the way it looked.** A
   slow/cross-tab review run that reviewed version N and settles *after* an apply must not resurrect
   the notes the apply consumed. Under ADR 0013 the delete forced that late settle onto
   `save_review`'s guarded-INSERT arm (the only arm with a live-CV guard `stored_cvs.version <=
   reviewed`), which then selected 0 rows. If we simply KEEP the row at N, the settle instead takes
   the `cond_update` arm (`cv_version <= N` → `N <= N` true) and **overwrites the row + resets
   decisions** — resurrection. So keeping the row requires moving the guard, not relying on the CV
   bump alone.
2. **`resolved` must never be model-authored.** The four adjudicators (Editor/Fact-Check/Spotter/
   Gatekeeper) emit `Thread` via provider-enforced structured output. A per-thread `resolved` on
   `Thread` would land in every adjudicator schema and a hallucinated `resolved:true` would render a
   never-applied note as done (invariant 5). It must be server-controlled.
3. **No schema migration of `cv_reviews`** (ADR 0006 — `create_all` adds tables, never columns).
4. **The provenance gate stays server-side (invariant 2); tenancy per-request (invariant 8).**

## Decision

- **Apply RESOLVES the review in place; it no longer deletes it.** `cv_store.apply_corrections`
  calls `review_store.resolve_threads(bullet_ids)` instead of `delete_review`: it appends the applied
  bullet ids to the bundle, **keeps `cv_version` at N**, and **preserves `decisions`**. It rides the
  caller's transaction and is **0-row-safe** (a no-op when no row exists, so apply still works against
  a `save_failed` in-memory-only review). The `bundle` JSON column is not `MutableDict`, so the blob
  is **reassigned**, not mutated in place.

- **`resolved_anchor_ids: list[str]` lives on `ReviewBundle`, not `Thread`.** It is assembled
  server-side (never a model `output_format`), rides the existing `bundle` JSON column
  (migration-free; old bundles default `[]`), and a fresh run assembles it empty (so ✓ chips clear on
  re-run). The client tags each thread on one of these bullets `resolved` in `collectThreads` and
  renders it as a non-actionable ✓ chip, with **precedence over `stale`**.

- **Resurrection protection moves to the guard, not the delete** (shipped as a precursor). The
  live-CV guard `EXISTS(stored_cvs WHERE version <= reviewed)` is hoisted onto `save_review`'s
  `cond_update` arm too (it was already on the INSERT arm). A stale settle at N against a kept N row
  now sees the live CV at N+1 → 0 rows → `ReviewSuperseded`. It also refuses a run that raced a
  concurrent edit during its own fan-out — strictly safer than persisting an already-superseded run.

- **Whole-bullet resolution granularity (v1).** Resolution is keyed by `bulletId`, so applying one
  note marks the whole bullet resolved, including any sibling notes on it (e.g. an Editor edit + a
  Spotter flag). Accepted because an apply rewrites the bullet's text, so sibling critiques of the
  *old* text are superseded; the ✓ card reads **"Applied — re-run Review to re-check"** (honest, not
  "perfect"). The `AcceptedThread` apply payload carries only `anchorId` (no server-stable per-thread
  id), so per-thread resolution is a deferred follow-up.

- **The frontend keeps the review, not tears it down.** `applyFeedback` marks the applied bullets
  resolved in the in-memory bundle and leaves the review, its version (N), the persisted-gate refs,
  and decisions untouched — so the two-level freshness gate hides the now-stale whole-CV Gatekeeper
  verdict (version drift) while the candidate's other inline notes stay live. A resolved bullet is
  non-actionable via `isAcceptableThread`, so a leftover accept decision is inert (no pruning needed),
  and staged accepts on other bullets survive for a later batch Apply.

## Options considered

- **A: Keep ADR 0013's delete-at-apply.** Simplest, but wipes every advisory on a single apply — the
  thing being fixed.
- **B (chosen): Resolve-in-place + bundle-level `resolved_anchor_ids` + move the guard.** Keeps the
  other notes, no model-authored flag, no migration; the cost is the precursor guard + re-specced
  resurrection tests.
- **C: Per-thread resolution (stable thread id through apply).** More faithful for a bullet with
  multiple notes, but needs a server-stable thread identity on `AcceptedThread` — deferred.

## Consequences

- Easier: apply one advisory, keep the rest; the applied one shows ✓ and clears on re-run; the review
  survives reload (version-drifted whole-CV verdict hidden, per-bullet notes shown).
- Harder/constrained: `resolve_threads` must reassign the JSON blob (a plain-column deep-mutation
  trap) and no-op on a missing row; the resurrection guarantee now depends on the `save_review`
  live-CV guard rather than a delete — proven by the re-specced `test_review.py` tests.
- Unchanged: the sign-off gate (invariant 2) is the only export block; whole-bullet granularity is a
  documented v1 limit; the fast-apply (per-bullet Corrector + optimistic paint) is a separate slice.

## Links

`backend/app/persistence/{review_store.py, cv_store.py, models.py}`, `backend/app/schema/reviews.py`,
`backend/app/routes/cv.py`, `frontend/src/app/(app)/workspace/{logic.ts, page.tsx, PreviewPanel.tsx,
ReviewNote.tsx, ReviewInlineBadge.tsx}`, ADR 0013 (persisted reviews — superseded in part), ADR 0006
(additive `create_all`), `docs/invariants.md` (2, 5, 7, 8), `docs/architecture/{data-model,security}.md`.
