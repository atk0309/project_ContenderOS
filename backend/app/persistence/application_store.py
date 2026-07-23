"""Application store: lock a finished CV against a job, list/read tracked applications, advance the
status pipeline, remove. Scoped by workspace (invariant 8); routes stay thin (AGENTS §8).

The "lock" that makes an applied CV immutable is *derived* from the row this store creates (ADR
0009): apply inserts a `stored_applications` row referencing the CV, and `cv_store`'s mutation
guards refuse any CV a row points at. Apply and those mutations serialize on `lock_cv` so the
gate-check and the insert are atomic — a concurrent edit can't slip in and leave a locked-but-
unsigned CV. The unique `(workspace_id, cv_id)` constraint is the final backstop for a double-apply
(→ `AlreadyApplied`, never a 500).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.persistence import cv_store, review_store
from app.persistence.cv_store import CVNotFound, StaleCV
from app.persistence.locks import lock_cv
from app.persistence.models import StoredApplication, StoredCV, StoredCvJobSpec, StoredCvLabel
from app.schema import DEFAULT_STAGES, Application, StageEvent
from app.schema.tailored import TailoredCV

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("contender.applications")

# Re-exported so callers can map the whole apply taxonomy from one module.
__all__ = [
    "AlreadyApplied",
    "ApplicationNotFound",
    "CVNotFound",
    "InvalidStage",
    "NeedsSignoff",
    "StaleCV",
    "TitleRequired",
    "apply",
    "delete_application",
    "get_application",
    "get_by_cv",
    "list_applications",
    "update_stage",
]


class ApplicationNotFound(Exception):
    """No application with this id in this workspace (→ 404). Covers the cross-tenant guess too."""

    def __init__(self, application_id: str) -> None:
        self.application_id = application_id
        super().__init__(f"no application {application_id!r} in this workspace")


class AlreadyApplied(Exception):
    """This CV is already tracked — the unique `(workspace_id, cv_id)` lock (409 alreadyApplied)."""

    def __init__(self, cv_id: str) -> None:
        self.cv_id = cv_id
        super().__init__(f"CV {cv_id!r} has already been applied")


class TitleRequired(Exception):
    """Apply couldn't resolve a non-blank job title (none supplied, CV has no label) → 422."""


class InvalidStage(Exception):
    """A stage update named a stage not in the application's `stages` list (→ 422)."""

    def __init__(self, stage: str) -> None:
        self.stage = stage
        super().__init__(f"stage {stage!r} is not one of this application's stages")


class NeedsSignoff(Exception):
    """Apply hit the provenance gate: the CV still has unsigned net-new bullets (→ 409
    ExportBlocked). Carries the blocking bullet ids so the route returns the same body as
    `export_cv`."""

    def __init__(self, blocked_bullet_ids: list[str]) -> None:
        self.blocked_bullet_ids = blocked_bullet_ids
        super().__init__("CV has net-new bullets awaiting sign-off")


def _blocked_bullet_ids(cv: TailoredCV) -> list[str]:
    return [
        bullet.bullet_id
        for section in cv.sections
        for item in section.items
        for bullet in item.highlights
        if bullet.needs_signoff
    ]


async def _label(session: AsyncSession, workspace_id: str, cv_id: str) -> StoredCvLabel | None:
    stmt = select(StoredCvLabel).where(
        StoredCvLabel.cv_id == cv_id, StoredCvLabel.workspace_id == workspace_id
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def apply(
    session: AsyncSession,
    *,
    workspace_id: str,
    cv_id: str,
    job_title: str | None,
    company: str | None,
    job_url: str | None,
    note: str | None,
    base_version: int,
) -> Application:
    """Lock a finished CV against a job, in ONE transaction under `lock_cv` (ADR 0009).

    Re-reads the CV server-side and enforces the SAME gate as export (invariant 2): a stale
    `base_version` → `StaleCV`; an unsigned net-new bullet → `NeedsSignoff`. Resolves the display
    title from the request, else the CV's `cv_labels` title — a keyless draft has no label, so it
    must supply one (`TitleRequired` → 422). The unique constraint catches a concurrent double-apply
    (`IntegrityError` → `AlreadyApplied`); the session is rolled back so it stays usable."""
    await lock_cv(session, cv_id)
    # CVNotFound → 404 (covers the cross-tenant guess).
    row = await cv_store.get_cv(session, workspace_id, cv_id)
    if row.version != base_version:
        raise StaleCV(cv_id)
    cv = TailoredCV.model_validate(row.cv)
    if cv.needs_signoff():
        raise NeedsSignoff(_blocked_bullet_ids(cv))

    label = await _label(session, workspace_id, cv_id)
    label_title = label.job_title.strip() if label and label.job_title else ""
    title = (job_title or "").strip() or label_title
    if not title:
        raise TitleRequired
    resolved_company = company if company is not None else (label.company if label else None)

    now = datetime.now(UTC)
    application = Application(
        id=uuid.uuid4().hex,
        job_title=title,
        company=resolved_company,
        job_url=job_url,
        tailored_cv_ref=cv_id,
        applied_at=now,
        stage=DEFAULT_STAGES[0],
        stages=list(DEFAULT_STAGES),
        events=[StageEvent(at=now, stage=DEFAULT_STAGES[0], note=note)],
    )
    session.add(
        StoredApplication(
            id=application.id,
            workspace_id=workspace_id,
            cv_id=cv_id,
            application=application.model_dump(mode="json", by_alias=True),
        )
    )
    try:
        await session.commit()
    except IntegrityError as exc:
        # The unique (workspace_id, cv_id) constraint fired — a concurrent apply won. Roll back so
        # the session is usable, then report the conflict rather than a 500. (On Postgres `lock_cv`
        # serializes the two, so this is the SQLite/no-advisory-lock backstop.)
        await session.rollback()
        raise AlreadyApplied(cv_id) from exc
    log.info(
        "application created: %s cv=%s ws=%s",
        application.id.replace("\r", "").replace("\n", ""),
        cv_id.replace("\r", "").replace("\n", ""),
        workspace_id.replace("\r", "").replace("\n", ""),
    )
    return application


async def list_applications(
    session: AsyncSession, workspace_id: str
) -> Sequence[StoredApplication]:
    """Every tracked application in the workspace, newest first (invariant 8). The route projects
    each blob to an `ApplicationSummary`."""
    stmt = (
        select(StoredApplication)
        .where(StoredApplication.workspace_id == workspace_id)
        .order_by(StoredApplication.created_at.desc())
    )
    return (await session.execute(stmt)).scalars().all()


async def _row(session: AsyncSession, workspace_id: str, application_id: str) -> StoredApplication:
    stmt = select(StoredApplication).where(
        StoredApplication.id == application_id,
        StoredApplication.workspace_id == workspace_id,
    )
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise ApplicationNotFound(application_id)
    return row


async def get_application(
    session: AsyncSession, workspace_id: str, application_id: str
) -> Application:
    """The full application (job metadata + timeline) for a member. `ApplicationNotFound` → 404."""
    row = await _row(session, workspace_id, application_id)
    return Application.model_validate(row.application)


async def get_by_cv(
    session: AsyncSession, workspace_id: str, cv_id: str
) -> StoredApplication | None:
    """The application tracking this CV, or None — powers the workspace's locked-deep-link guard."""
    stmt = select(StoredApplication).where(
        StoredApplication.cv_id == cv_id, StoredApplication.workspace_id == workspace_id
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def update_stage(
    session: AsyncSession,
    workspace_id: str,
    application_id: str,
    *,
    stage: str,
    note: str | None,
) -> Application:
    """Advance the status pipeline: set the current stage and append a timeline event. The stage
    must be one of the application's `stages` (→ `InvalidStage`). The WHOLE `application` blob is
    reassigned — SQLAlchemy doesn't track deep mutation of a JSON column (mirrors `cv_store`).
    Last-write-wins (invariant 7; owner-only, low-concurrency)."""
    row = await _row(session, workspace_id, application_id)
    application = Application.model_validate(row.application)
    if stage not in application.stages:
        raise InvalidStage(stage)
    prev = application.stage
    application.stage = stage
    application.events.append(StageEvent(at=datetime.now(UTC), stage=stage, note=note))
    row.application = application.model_dump(mode="json", by_alias=True)
    await session.commit()
    log.info(
        "application stage change: %s %s -> %s ws=%s",
        application_id.replace("\r", "").replace("\n", ""),
        prev.replace("\r", "").replace("\n", ""),
        stage.replace("\r", "").replace("\n", ""),
        workspace_id.replace("\r", "").replace("\n", ""),
    )
    return application


async def update_recruiter(
    session: AsyncSession,
    workspace_id: str,
    application_id: str,
    *,
    recruiter_name: str | None,
    recruiter_email: str | None,
) -> Application:
    """Set the recruiter contact (a full replace of both fields). The WHOLE `application` blob is
    reassigned (JSON columns don't track deep mutation; mirrors `update_stage`). Last-write-wins
    (invariant 7; owner-only, low-concurrency). `ApplicationNotFound` → 404."""
    row = await _row(session, workspace_id, application_id)
    application = Application.model_validate(row.application)
    application.recruiter_name = recruiter_name
    application.recruiter_email = recruiter_email
    row.application = application.model_dump(mode="json", by_alias=True)
    await session.commit()
    log.info(
        "application recruiter updated: %s ws=%s",
        application_id.replace("\r", "").replace("\n", ""),
        workspace_id.replace("\r", "").replace("\n", ""),
    )
    return application


async def delete_application(session: AsyncSession, workspace_id: str, application_id: str) -> None:
    """Remove a tracked application AND the locked CV it froze (its `cv_labels` + `cv_job_specs`
    rows too), in one commit under `lock_cv` so it can't race a CV mutation. The CV is deleted
    directly (not via the lock-guarded `cv_store.delete_cv`, which refuses a still-applied CV)."""
    cv_id = (await _row(session, workspace_id, application_id)).cv_id  # 404 if absent
    await lock_cv(session, cv_id)
    # Re-read UNDER the lock so a concurrent double-delete is a clean 404, not a 0-row ORM delete.
    row = await _row(session, workspace_id, application_id)
    await session.delete(row)
    await session.execute(
        delete(StoredCV).where(StoredCV.id == cv_id, StoredCV.workspace_id == workspace_id)
    )
    await session.execute(
        delete(StoredCvLabel).where(
            StoredCvLabel.cv_id == cv_id, StoredCvLabel.workspace_id == workspace_id
        )
    )
    await session.execute(
        delete(StoredCvJobSpec).where(
            StoredCvJobSpec.cv_id == cv_id, StoredCvJobSpec.workspace_id == workspace_id
        )
    )
    # This path bypasses `cv_store.delete_cv`, so drop the persisted review run here too (ADR 0013),
    # in the SAME commit under the lock. delete_review rides this transaction (no inner commit).
    await review_store.delete_review(session, workspace_id, cv_id)
    await session.commit()
    log.info(
        "application deleted: %s cv=%s ws=%s",
        application_id.replace("\r", "").replace("\n", ""),
        cv_id.replace("\r", "").replace("\n", ""),
        workspace_id.replace("\r", "").replace("\n", ""),
    )
