"""Master-profile store: persist + read the owner's canonical master, scoped by workspace (inv 8).

Routes stay thin (AGENTS §8); the id rules live here. One row per workspace, every query filtered on
`workspace_id`, so a master is never visible across tenants. `validate_master_ids` enforces the
rules the provenance + verbatim-draft pipeline depend on: a master's stable ids are the `sourceId`
anchors a tailored CV (and the deterministic draft) point back to, so a blank / duplicate /
delimiter-bearing id must fail loud (422) before it is stored — never surfacing later as a broken
draft or a raw 500.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.persistence.locks import lock_workspace_master
from app.persistence.models import StoredMaster
from app.schema import MasterProfile

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

# Stable ids become parts of namespaced tailored-CV ids (the draft composes
# f"{work.id}:{highlight.id}" and f"work:{work.id}"); ':' is the delimiter and tailored ids must be
# unique, so restrict master ids to a safe charset (no ':' / whitespace) to keep it unambiguous.
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


class MasterNotFound(Exception):
    """No master stored for this workspace yet. Transport-neutral: the caller picks the mapping —
    the master GET returns 200-null (authorized absence), CV routes that REQUIRE a stored master
    map it to 404, and ingest treats it as None. A cross-workspace guess never reaches the store:
    it 403s at the `require_workspace_owner` dependency first (invariant 8)."""

    def __init__(self, workspace_id: str) -> None:
        self.workspace_id = workspace_id
        super().__init__(f"no master profile in workspace {workspace_id!r}")


class MasterIdError(Exception):
    """A master carries a blank, unsafe, or duplicate stable id (→ 422). These ids are the
    provenance anchors (and the verbatim draft's id parts), so they must be present, charset-safe,
    and unique within scope before the master is stored."""


def _check_id(kind: str, value: str, seen: set[str]) -> None:
    if not value.strip():
        raise MasterIdError(f"blank {kind} id in master profile")
    if not _SAFE_ID.match(value):
        raise MasterIdError(f"{kind} id {value!r} must match [A-Za-z0-9_-] (no ':' or whitespace)")
    if value in seen:
        raise MasterIdError(f"duplicate {kind} id {value!r} in master profile")
    seen.add(value)


def validate_master_ids(master: MasterProfile) -> None:
    """Reject blank / unsafe / duplicate ids before storing.

    Work ids are unique among work entries; education ids unique among education entries; highlight
    ids unique *within their own work entry* (they may repeat across entries — the draft namespaces
    bullet ids as f"{work.id}:{highlight.id}", so cross-entry repeats stay globally unique). Work
    and education ids need not be globally disjoint, because the draft namespaces item ids
    ("work:"/"education:")."""
    work_ids: set[str] = set()
    for work in master.work:
        _check_id("work", work.id, work_ids)
        highlight_ids: set[str] = set()
        for highlight in work.highlights:
            _check_id("highlight", highlight.id, highlight_ids)
    education_ids: set[str] = set()
    for edu in master.education:
        _check_id("education", edu.id, education_ids)


def _dump(master: MasterProfile) -> dict[str, object]:
    return master.model_dump(mode="json", by_alias=True)


async def get_master(session: AsyncSession, workspace_id: str) -> MasterProfile:
    """The stored master for this workspace, validated to Pydantic. `MasterNotFound` if unset."""
    stmt = select(StoredMaster).where(StoredMaster.workspace_id == workspace_id)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise MasterNotFound(workspace_id)
    return MasterProfile.model_validate(row.master)


async def write_master(
    session: AsyncSession, workspace_id: str, master: MasterProfile
) -> MasterProfile:
    """Validate + upsert the master **without committing** — the caller owns the transaction so the
    advisory lock it holds spans the whole read-modify-write (PR-B1's ingest apply reads the current
    master, merges accepted proposals, then writes here, all under one `lock_workspace_master`).

    The caller MUST hold `lock_workspace_master` across its read of the current master AND this
    write, so the whole read-modify-write is atomic; this call re-asserts the lock as a second line
    of defense (a transaction-scoped advisory lock is reentrant — re-taking it in the same
    transaction is a no-op, released once at commit). Because writers serialize under that lock, the
    first-save unique-constraint race can't happen here, so there is no `IntegrityError` fallback
    (that lives in `upsert_master`, the lock-less-safe `PUT` path on SQLite). Returns the master as
    it will persist (validated from the exact JSON written)."""
    await lock_workspace_master(session, workspace_id)
    validate_master_ids(master)
    dumped = _dump(master)
    stmt = select(StoredMaster).where(StoredMaster.workspace_id == workspace_id)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is not None:
        row.master = dumped
    else:
        session.add(StoredMaster(workspace_id=workspace_id, master=dumped))
    return MasterProfile.model_validate(dumped)


async def upsert_master(
    session: AsyncSession, workspace_id: str, master: MasterProfile
) -> MasterProfile:
    """Create or replace this workspace's master after validating its ids (→ `MasterIdError`).

    Serialized under the per-workspace advisory lock (`lock_workspace_master`) so a `PUT /master`
    can't interleave with an ingest apply's read-modify-write of the same version-less blob — on
    Postgres the two writers take the same lock and run sequentially. The lock is a no-op on SQLite,
    where the first-save race is still made safe by the `IntegrityError` fallback below: two
    concurrent inserts for the same `workspace_id` (the PK) can both pass the SELECT, so the loser's
    INSERT trips the unique constraint — we catch it, roll back, and update instead, rather than a
    500. Returns the master as persisted (validated from the exact JSON written)."""
    await lock_workspace_master(session, workspace_id)
    validate_master_ids(master)
    dumped = _dump(master)
    stmt = select(StoredMaster).where(StoredMaster.workspace_id == workspace_id)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is not None:
        row.master = dumped
        await session.commit()
    else:
        session.add(StoredMaster(workspace_id=workspace_id, master=dumped))
        try:
            await session.commit()
        except IntegrityError:
            # A concurrent first-save won the insert. On Postgres this is unreachable: the advisory
            # lock is taken *before* the SELECT above, so racing first-saves serialize and the loser
            # sees the row and UPDATEs — the INSERT branch never collides. It can only fire on
            # SQLite (lock is a no-op there). `rollback()` ends the transaction (releasing the lock
            # on Postgres), so reacquire it before the fallback update — the write is then
            # lock-covered on every backend (last-write-wins).
            await session.rollback()
            await lock_workspace_master(session, workspace_id)
            existing = (await session.execute(stmt)).scalar_one()
            existing.master = dumped
            await session.commit()
    return MasterProfile.model_validate(dumped)
