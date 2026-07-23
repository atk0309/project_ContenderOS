# ADR 0009: Application tracking — derived CV lock + immutable applied snapshot

Status: accepted  
Date: 2026-06-26

## Context

Application tracking adds an **"Applied"** action: a finished tailored CV is locked against a specific
job, removed from the active workspace, and surfaced on an Applications page that stores the exact CV
that was sent. Three forces shape how the lock + immutability are implemented:

1. **No schema migration of an existing table (ADR 0006).** There is no Alembic. Tables are created
   by `Base.metadata.create_all` on startup, which creates **missing tables only** — it will NOT add
   a column to the already-deployed `stored_cvs` table on Railway. So an `applied`/`locked` column on
   `stored_cvs` would silently never exist in production.

2. **Immutability must be real and server-enforced (invariant 2).** "The CV you sent" must not change
   after you apply. Each `StoredCV` row *already* snapshots both `master` and `cv` at tailor-time, and
   `cv_store` is the **only** writer of `StoredCV.cv`, so freezing it is a matter of refusing further
   mutations — not copying bytes.

3. **The lock check and the apply must be atomic (concurrency).** A naive "check `is_applied`, then
   mutate" (or "gate-check in the route, then insert the application") races: a concurrent edit between
   the check and the write can leave a CV that is locked *and* un-signed — uneditable AND unexportable.

## Decision

- **Lock-state is derived, not stored.** A CV is "applied/locked" **iff** a `stored_applications` row
  references it. A new `stored_applications` table is created by `create_all` (no migration of
  `stored_cvs`); the lock has one source of truth and nothing to keep in sync. A unique
  `(workspace_id, cv_id)` constraint makes it 1:1 (a CV is applied to exactly one job) and is the
  atomic backstop for a double-apply (`IntegrityError` → `AlreadyApplied`, never a 500).

- **Immutability = refuse mutations on a referenced CV.** `cv_store.edit_bullet` / `sign_off` /
  `apply_corrections` / `delete_cv` raise `CVLocked` (409, distinct from `StaleCV`) when a row
  references the CV. The frozen
  `{master, cv}` snapshot keeps rendering/exporting through the unchanged `/cv/{id}/export` gate, which
  passes because **apply requires full sign-off** — no separate gate to maintain.

- **"Moves out of the work area" = a list exclusion.** `list_cvs` excludes applied CVs (`NOT EXISTS`),
  so the Home dashboard shows only CVs still in the work area; the Applications page lists the rest.

- **Atomicity via the repo's advisory-lock idiom (ADR 0008 / `locks.py`), not a clever predicate.**
  Apply and the CV mutations (`edit_bullet` / `sign_off` / `apply_corrections` / `delete_cv`) serialize
  on a per-CV `lock_cv` advisory lock. Apply, in one
  transaction under the lock: re-reads the CV; rejects a stale `base_version` (`StaleCV`); rejects an
  unsigned net-new bullet (`NeedsSignoff`); inserts the application. The mutations take the same lock
  and re-check `is_applied` before writing. Cross-process serialization is **Postgres-only** (the lock
  is a no-op on SQLite, where whole-DB single-writer serializes); the unique constraint is the
  backend-portable backstop.

- **Delete cascades; the CV is gone, not unlocked.** `delete_application` removes the application AND
  its locked `StoredCV` (+ `cv_labels`) in one transaction under `lock_cv`, deleting the CV directly
  (not via the now lock-guarded `delete_cv`). An "unapply" (return the CV to the workspace) is a
  possible future affordance, deliberately out of scope.

- **The tracker is owner-only.** Every applications route (including the `by-cv` lock lookup the
  workspace uses to redirect a locked deep-link) is owner-scoped, so an application's existence and
  metadata never leak to a non-member (invariant 8).

## Options considered

- **Add an `applied_at` column to `stored_cvs`** — simplest to query, but `create_all` can't add it to
  the deployed table (ADR 0006), and it duplicates state the application row already implies. Rejected.
- **Copy the CV into the application row (snapshot-and-delete the original)** — a true "move," but it
  needs a parallel render path keyed on application id (the whole render stack is `cvId`-keyed) for no
  benefit: the `StoredCV` row is already a self-contained, lockable snapshot. Rejected.
- **`NOT EXISTS` predicate folded into the guarded UPDATE for atomicity** — looks atomic but is **not**
  race-free under Postgres READ COMMITTED (a waiting writer can re-qualify against a snapshot that
  still doesn't see the freshly inserted row). Rejected for the advisory lock, which the repo already
  trusts for master-vs-ingest.
- **Derived lock + advisory-lock atomicity (chosen)** — migration-safe, one source of truth, real
  server-side immutability, provably serial on Postgres, portable backstop via the unique constraint.

## Consequences

- Zero new render plumbing: re-rendering/re-exporting the applied CV reuses `read_cv` / `export` /
  `/print/[cvId]` / `/api/render` unchanged, because they already serve the frozen row by `cvId`.
- A locked deep-link to `/workspace?cv=<applied>` must be handled in the UI: the workspace reads
  `GET /applications/by-cv/{cvId}` on load and redirects to the tracker rather than mounting an
  editable editor; the write-time `CVLocked` 409 is the server-side backstop. The probe answers an
  **unapplied** CV with **200 JSON `null`** (not 404) — the workspace calls it on every load/refocus,
  so a 404-per-unapplied-CV logged a red console error each time; `null` is information-equivalent
  and keeps isolation intact (a non-member still 403s; a cross-tenant miss reads the same `null`).
- True cross-process apply-vs-edit serialization is a Postgres-only guarantee (the advisory lock is a
  no-op on SQLite). The SQLite gate proves the gate/validation logic and the unique-constraint
  double-apply backstop, but NOT the apply-vs-edit serialization — that rests on the lock and is
  currently verified by **inspection** (lock-then-read ordering, single transaction). A
  `TEST_POSTGRES_URL`-gated concurrency test + a CI Postgres service is an **owed** follow-up; until it
  lands, run the suite against Postgres manually before trusting the concurrency guarantee (AGENTS §4 —
  a gap, not a pass).
- The only correction for a mis-apply today is `delete_application` (destructive); the confirm dialog
  states the CV is removed too.

## Links

`backend/app/persistence/application_store.py`, `backend/app/persistence/cv_store.py`,
`backend/app/persistence/locks.py`, `backend/app/persistence/models.py` (`StoredApplication`),
`backend/app/routes/applications.py`, `backend/app/schema/application.py`. Related: ADR 0006
(create_all / no Alembic), ADR 0008 (advisory-lock idiom), invariant 2 (provenance gate), invariant 8
(tenant isolation).
