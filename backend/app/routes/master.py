"""Workspace-scoped master-profile routes — the owner's canonical CV (invariant 8).

Both verbs are owner-gated (`require_workspace_owner` — every allowlisted account is an owner):
a non-member fails closed at the dependency with **403** before any handler runs, so an absence
answer is only ever AUTHORIZED absence — the GET's **200-null** means "this owner has no stored
master yet", never a masked cross-tenant read (the store's `workspace_id` filter is defense in
depth behind that 403). `MasterIdError` (a blank / duplicate / unsafe stable id) maps to 422 —
these ids are the provenance anchors, so a malformed master must fail loud before storage,
never a 500.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_workspace_owner
from app.persistence import master_store
from app.persistence.engine import get_session
from app.persistence.master_store import MasterIdError, MasterNotFound
from app.schema import MasterProfile

router = APIRouter(prefix="/workspaces", tags=["master"])


@router.get(
    "/{workspace_id}/master",
    response_model=MasterProfile | None,
    dependencies=[Depends(require_workspace_owner)],
)
async def read_master(
    workspace_id: str, session: AsyncSession = Depends(get_session)
) -> MasterProfile | None:
    """The workspace's stored master (owner-gated), or **200-null** when none has been saved.
    Deliberately NOT 404 (probe parity with the review-latest GET): the workspace mount and the
    /master editor both probe this on load, and a first-run 404 was console noise for an
    expected state, not a fault."""
    try:
        return await master_store.get_master(session, workspace_id)
    except MasterNotFound:
        return None


@router.put(
    "/{workspace_id}/master",
    response_model=MasterProfile,
    dependencies=[Depends(require_workspace_owner)],
)
async def put_master(
    workspace_id: str,
    body: MasterProfile,
    session: AsyncSession = Depends(get_session),
) -> MasterProfile:
    """Owner upserts the workspace's master. 422 on a blank / duplicate / unsafe stable id —
    these are the provenance anchors and must be valid before storage."""
    try:
        return await master_store.upsert_master(session, workspace_id, body)
    except MasterIdError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
