"""Workspace-scoped application-tracking routes — apply (lock a CV to a job), list, read, advance
the status pipeline, delete.

Every path is scoped by `{workspace_id}` so the auth dep re-derives the caller's membership per
request (invariant 8). Every verb rides the workspace gate; the
`by-cv` lookup (which the workspace uses to redirect a locked deep-link) is gated too — a
non-member still 403s — but it answers an unapplied CV with 200 `null` rather than 404, so the
workspace's on-every-load probe stops logging a red console error. A cross-tenant miss reads the
same 200 `null` (the caller owns the queried workspace, but the CV isn't applied there); `null`
carries no foreign data, so this is information-equivalent to the old 404 and isolation is intact.
Apply enforces the SAME provenance gate as export (invariant 2): it refuses (409) while any net-new
bullet is unsigned. The store filters on `(workspace_id, …)`, so a cross-tenant id on the id-keyed
reads/mutations is a 404, never a leak.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_workspace_owner
from app.persistence import application_store
from app.persistence.application_store import (
    AlreadyApplied,
    ApplicationNotFound,
    CVNotFound,
    InvalidStage,
    NeedsSignoff,
    StaleCV,
    TitleRequired,
)
from app.persistence.engine import get_session
from app.persistence.models import StoredApplication
from app.schema import (
    Application,
    ApplicationConflict,
    ApplicationSummary,
    ApplyRequest,
    ConflictCode,
    ExportBlocked,
    OkResponse,
    RecruiterUpdateRequest,
    StageUpdateRequest,
)

router = APIRouter(prefix="/workspaces", tags=["applications"])


def _conflict(code: ConflictCode, detail: str) -> JSONResponse:
    """A 409 carrying the machine-readable `code` discriminator so the client branches on a code,
    not prose (the needs-sign-off case uses `ExportBlocked` instead)."""
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content=ApplicationConflict(code=code, detail=detail).model_dump(by_alias=True),
    )


def _summary(row: StoredApplication) -> ApplicationSummary:
    """Project a stored application to a tracker list row (no timeline)."""
    application = Application.model_validate(row.application)
    return ApplicationSummary(
        id=application.id,
        job_title=application.job_title,
        company=application.company,
        stage=application.stage,
        applied_at=application.applied_at,
        cv_id=row.cv_id,
    )


@router.post(
    "/{workspace_id}/applications",
    response_model=Application,
    # 409 carries one of TWO bodies: `ExportBlocked{blockedBulletIds}` for the sign-off gate, or
    # `ApplicationConflict{code}` for stale/already-applied. Document both so typed clients know the
    # `blockedBulletIds` shape on the gate-blocked path, not just `ApplicationConflict` (Codex P2).
    responses={
        status.HTTP_409_CONFLICT: {"model": ApplicationConflict | ExportBlocked},
    },
    dependencies=[Depends(require_workspace_owner)],
)
async def apply(
    workspace_id: str,
    body: ApplyRequest,
    session: AsyncSession = Depends(get_session),
) -> Application | JSONResponse:
    """Lock a finished CV against a job and move it to the tracker (owner-only). Enforces the export
    gate (invariant 2): 409 `ExportBlocked` while any net-new bullet is unsigned. 409 `stale` if the
    CV moved since the client read it; 409 `alreadyApplied` if it's already tracked; 422 if no job
    title can be resolved; 404 if the CV doesn't exist in this workspace."""
    try:
        return await application_store.apply(
            session,
            workspace_id=workspace_id,
            cv_id=body.cv_id,
            job_title=body.job_title,
            company=body.company,
            job_url=body.job_url,
            note=body.note,
            base_version=body.base_version,
        )
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except NeedsSignoff as exc:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=ExportBlocked(blocked_bullet_ids=exc.blocked_bullet_ids).model_dump(
                by_alias=True
            ),
        )
    except StaleCV as exc:
        return _conflict(ConflictCode.stale, str(exc))
    except AlreadyApplied as exc:
        return _conflict(ConflictCode.already_applied, str(exc))
    except TitleRequired as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Add a job title to track this application.",
        ) from exc


@router.get(
    "/{workspace_id}/applications",
    response_model=list[ApplicationSummary],
    dependencies=[Depends(require_workspace_owner)],
)
async def list_applications(
    workspace_id: str, session: AsyncSession = Depends(get_session)
) -> list[ApplicationSummary]:
    """Every tracked application in the workspace, newest first (owner-only; invariant 8)."""
    rows = await application_store.list_applications(session, workspace_id)
    return [_summary(row) for row in rows]


@router.get(
    "/{workspace_id}/applications/by-cv/{cv_id}",
    response_model=ApplicationSummary | None,
    dependencies=[Depends(require_workspace_owner)],
)
async def get_by_cv(
    workspace_id: str, cv_id: str, session: AsyncSession = Depends(get_session)
) -> ApplicationSummary | None:
    """The application tracking this CV as `ApplicationSummary`, or JSON `null` when the CV isn't
    applied (owner-gated) — the workspace calls this on every load/refocus to redirect a locked
    deep-link to the tracker. Returns 200 `null` (not 404) so the probe never logs a red console
    error; a non-member still 403s (invariant 8), and a cross-tenant miss is the same
    information-free `null`."""
    row = await application_store.get_by_cv(session, workspace_id, cv_id)
    return _summary(row) if row is not None else None


@router.get(
    "/{workspace_id}/applications/{application_id}",
    response_model=Application,
    dependencies=[Depends(require_workspace_owner)],
)
async def get_application(
    workspace_id: str, application_id: str, session: AsyncSession = Depends(get_session)
) -> Application:
    """The full application (job metadata + status timeline) for the owner. 404 if unknown."""
    try:
        return await application_store.get_application(session, workspace_id, application_id)
    except ApplicationNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc


@router.patch(
    "/{workspace_id}/applications/{application_id}/stage",
    response_model=Application,
    dependencies=[Depends(require_workspace_owner)],
)
async def update_stage(
    workspace_id: str,
    application_id: str,
    body: StageUpdateRequest,
    session: AsyncSession = Depends(get_session),
) -> Application:
    """Advance the status pipeline + append a timeline note (owner-only). 422 for a stage not in the
    application's `stages`; 404 if unknown."""
    try:
        return await application_store.update_stage(
            session, workspace_id, application_id, stage=body.stage, note=body.note
        )
    except ApplicationNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except InvalidStage as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


@router.patch(
    "/{workspace_id}/applications/{application_id}/recruiter",
    response_model=Application,
    dependencies=[Depends(require_workspace_owner)],
)
async def update_recruiter(
    workspace_id: str,
    application_id: str,
    body: RecruiterUpdateRequest,
    session: AsyncSession = Depends(get_session),
) -> Application:
    """Set the whole recruiter contact (name + email) on an application (owner-only). Both keys are
    required (an omitted key → 422); a non-empty invalid email → 422 (request validation). 404 if
    unknown. Full-replace, last-write-wins (invariant 7)."""
    try:
        return await application_store.update_recruiter(
            session,
            workspace_id,
            application_id,
            recruiter_name=body.recruiter_name,
            recruiter_email=body.recruiter_email,
        )
    except ApplicationNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc


@router.delete(
    "/{workspace_id}/applications/{application_id}",
    response_model=OkResponse,
    dependencies=[Depends(require_workspace_owner)],
)
async def delete_application(
    workspace_id: str, application_id: str, session: AsyncSession = Depends(get_session)
) -> OkResponse:
    """Remove a tracked application AND the locked CV it froze (owner-only). Unknown/cross-tenant id
    → 404. Returns `200 {ok}` (not 204) so the shared `api()` client, which parses every body,
    doesn't throw."""
    try:
        await application_store.delete_application(session, workspace_id, application_id)
    except ApplicationNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return OkResponse()
