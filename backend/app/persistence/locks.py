"""Per-workspace advisory locks (Postgres only).

`StoredMaster` is a version-less, one-row-per-workspace JSON blob (no optimistic-lock token, and
ADR 0006's additive-only `create_all` can't add one to the existing table). So the writers that do a
read-modify-write of that blob — `PUT /master` and, from PR-B1, the ingest *apply* — serialize on a
**transaction-scoped** Postgres advisory lock instead of last-write-wins clobbering each other.

The lock is held until the surrounding transaction commits or rolls back (`pg_advisory_xact_lock`),
so a caller must do its whole read-modify-write and commit within one transaction. Off Postgres
(the offline SQLite test suite) advisory locks don't exist and this is a no-op — true cross-writer
concurrency is only a Postgres guarantee and is exercised against Postgres, never claimed from the
SQLite gate (AGENTS §4).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

# Namespace key for master-profile writes — the first arg of the two-int `pg_advisory_xact_lock`
# form, so this lock can never collide with another subsystem locking the same workspace hash. The
# second arg is `hashtext(workspace_id)` (int4); two different namespaces hashing to the same
# workspace are independent locks.
_MASTER_LOCK_NS = 0x4D53  # "MS"

# Namespace key for per-CV writes — apply-vs-edit/sign-off/delete serialization (ADR 0009). The
# second arg is `hashtext(cv_id)`; a different namespace than master writes, so they never collide.
_CV_LOCK_NS = 0x4356  # "CV"


async def lock_workspace_master(session: AsyncSession, workspace_id: str) -> None:
    """Take the per-workspace master-write advisory lock for the rest of THIS transaction.

    No-op off Postgres. On Postgres this blocks until any other holder of the same (namespace,
    workspace) lock commits/rolls back, then is held until this transaction ends — so the caller
    must read, modify, write, and commit the master within the same transaction for the lock to be
    meaningful."""
    if session.get_bind().dialect.name != "postgresql":
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:ns, hashtext(:ws))"),
        {"ns": _MASTER_LOCK_NS, "ws": workspace_id},
    )


async def lock_cv(session: AsyncSession, cv_id: str) -> None:
    """Take the per-CV write advisory lock for the rest of THIS transaction (ADR 0009).

    Applying a CV (insert a `stored_applications` row) and mutating it (`edit_bullet` / `sign_off` /
    `delete_cv`) both serialize on this lock so the "lock" — derived from the application row's
    existence — is checked and acted on atomically: a writer can't pass `is_applied == False` and
    then mutate a CV that a concurrent apply just froze. Same caveat as `lock_workspace_master`:
    Postgres-only (no-op on SQLite, where whole-DB single-writer serializes); the caller must read,
    decide, write, and commit within one transaction for the lock to mean anything."""
    if session.get_bind().dialect.name != "postgresql":
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:ns, hashtext(:cv))"),
        {"ns": _CV_LOCK_NS, "cv": cv_id},
    )
