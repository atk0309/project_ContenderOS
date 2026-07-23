"""CV store: persist + read + sign off tailored CVs, scoped by workspace (invariant 8).

Routes stay thin (AGENTS §8) — this holds the data logic. Every read/write filters on BOTH
`workspace_id` and `cv_id`, so a CV id guessed across tenants simply isn't found (404), not merely
denied after the fact. Lightweight exceptions distinguish the not-found / unknown-bullet paths so
the route maps clean status codes without leaking a raw 500.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import CursorResult, delete, select, update
from sqlalchemy.orm import load_only

from app.ai.provenance import (
    StructureViolation,
    reground_bullet,
    validate_stable_ids,
)
from app.persistence import review_store
from app.persistence.locks import lock_cv
from app.persistence.models import StoredApplication, StoredCV, StoredCvJobSpec, StoredCvLabel
from app.schema import JobSpec, MasterProfile, TailoredCV
from app.schema.common import MAX_BULLET_LEN, Origin

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class CVNotFound(Exception):
    """No CV with this id in this workspace (→ 404). Covers the cross-tenant guess too."""

    def __init__(self, cv_id: str) -> None:
        self.cv_id = cv_id
        super().__init__(f"no CV {cv_id!r} in this workspace")


class BulletNotFound(Exception):
    """Sign-off or edit named a bullet id that isn't in the CV (→ 422)."""

    def __init__(self, bullet_id: str) -> None:
        self.bullet_id = bullet_id
        super().__init__(f"bullet {bullet_id!r} is not in this CV")


class StaleCV(Exception):
    """The CV changed between our read and our write — an optimistic-lock conflict (→ 409). The
    caller should re-read the latest bundle and retry. Guards against a concurrent edit/sign-off
    silently losing an update (both writers reassign the whole `cv` blob)."""

    def __init__(self, cv_id: str) -> None:
        self.cv_id = cv_id
        super().__init__(f"CV {cv_id!r} was modified concurrently; reload and retry")


class CVLocked(Exception):
    """The CV is applied and locked (a `stored_applications` row references it) → 409, distinct from
    `StaleCV`. Its `{master, cv}` snapshot is immutable (invariant 2 / ADR 0009), so edit/sign-off/
    delete are refused — the candidate views/exports it from the tracker instead."""

    def __init__(self, cv_id: str) -> None:
        self.cv_id = cv_id
        super().__init__(f"CV {cv_id!r} is applied and locked; view it in Applications")


async def is_applied(session: AsyncSession, workspace_id: str, cv_id: str) -> bool:
    """True if a `stored_applications` row in this workspace references this CV — i.e. it's locked.
    Lives here (not in application_store) so the mutation guards can call it without a circular
    import; callers that mutate must hold `lock_cv` first so the check and the write are atomic."""
    stmt = (
        select(StoredApplication.id)
        .where(
            StoredApplication.cv_id == cv_id,
            StoredApplication.workspace_id == workspace_id,
        )
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


def _dump(model: MasterProfile | TailoredCV) -> dict[str, object]:
    return model.model_dump(mode="json", by_alias=True)


async def _row(session: AsyncSession, workspace_id: str, cv_id: str) -> StoredCV:
    stmt = select(StoredCV).where(StoredCV.id == cv_id, StoredCV.workspace_id == workspace_id)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise CVNotFound(cv_id)
    return row


async def create_cv(
    session: AsyncSession,
    *,
    workspace_id: str,
    master: MasterProfile,
    cv: TailoredCV,
    job_spec: JobSpec | None = None,
) -> StoredCV:
    """Persist a freshly tailored CV with a server-generated id. The persisted `version` is
    **server-owned**, normalized to 1 (the model emits an unconstrained `int` we don't trust): it's
    the optimistic-lock token the client echoes as `baseVersion` (≥ 1), so a CV can never land on a
    version the lock validation would reject. `version` stays mirrored with `cv.version`.

    `job_spec` is the owner's parsed posting this CV targets (the Parser output the create request
    carries). From it the server writes, in the SAME commit, two SEPARATE rows kept off the Tailor's
    `TailoredCV` schema: a `cv_labels` row (title/company for the dashboard) and a `cv_job_specs`
    row (the full JobSpec the review panel's Gatekeeper/Editor read server-side as the review
    target). A keyless draft passes no `job_spec`, so it gets neither row."""
    cv.version = 1
    cv.parent_version = None
    row = StoredCV(
        id=uuid.uuid4().hex,
        workspace_id=workspace_id,
        master=_dump(master),
        cv=_dump(cv),
        version=cv.version,
    )
    session.add(row)
    if job_spec is not None:
        session.add(
            StoredCvLabel(
                cv_id=row.id,
                workspace_id=workspace_id,
                job_title=job_spec.title,
                company=job_spec.company,
            )
        )
        session.add(
            StoredCvJobSpec(
                cv_id=row.id,
                workspace_id=workspace_id,
                job_spec=job_spec.model_dump(mode="json", by_alias=True),
            )
        )
    await session.commit()
    return row


async def get_job_spec(session: AsyncSession, workspace_id: str, cv_id: str) -> JobSpec | None:
    """The owner-supplied `JobSpec` this CV was tailored to, or None for a keyless draft.
    Workspace-scoped (invariant 8). The review route loads it server-side so the Gatekeeper/Editor
    judge against the SAME stored posting the CV targeted — the review target, not a CV-grounding
    source."""
    stmt = select(StoredCvJobSpec.job_spec).where(
        StoredCvJobSpec.cv_id == cv_id, StoredCvJobSpec.workspace_id == workspace_id
    )
    blob = (await session.execute(stmt)).scalar_one_or_none()
    return JobSpec.model_validate(blob) if blob is not None else None


async def get_cv(session: AsyncSession, workspace_id: str, cv_id: str) -> StoredCV:
    return await _row(session, workspace_id, cv_id)


async def cv_exists(session: AsyncSession, workspace_id: str, cv_id: str) -> bool:
    """Ownership-scoped existence probe (invariant 8) that keeps the heavy JSON blobs off the
    query — the review routes call this on every workspace mount to refuse orphan `cv_reviews`
    rows (a lockless settle can outlive a concurrent CV delete; ADR 0013)."""
    stmt = select(StoredCV.id).where(StoredCV.id == cv_id, StoredCV.workspace_id == workspace_id)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def list_cvs(
    session: AsyncSession, workspace_id: str
) -> Sequence[tuple[StoredCV, StoredCvLabel | None]]:
    """Every **active** CV in the workspace (invariant 8) with its optional label, newest first.
    Applied/locked CVs are excluded (a `stored_applications` row references them) — they've moved to
    the tracker, so the Home dashboard only lists CVs still in the work area (ADR 0009). LEFT-JOINs
    `cv_labels` so the dashboard can show the job; `load_only` keeps the heavy `master` blob off a
    list query (do NOT touch `row.master` on the result — it's deferred). Returns
    `(StoredCV, StoredCvLabel | None)` pairs; the route projects each to a `CvSummary`."""
    applied = select(StoredApplication.id).where(
        StoredApplication.cv_id == StoredCV.id,
        StoredApplication.workspace_id == StoredCV.workspace_id,
    )
    stmt = (
        select(StoredCV, StoredCvLabel)
        .outerjoin(
            StoredCvLabel,
            (StoredCvLabel.cv_id == StoredCV.id)
            & (StoredCvLabel.workspace_id == StoredCV.workspace_id),
        )
        .where(StoredCV.workspace_id == workspace_id, ~applied.exists())
        .order_by(StoredCV.created_at.desc())
        .options(
            load_only(
                StoredCV.id,
                StoredCV.version,
                StoredCV.cv,
                StoredCV.created_at,
                StoredCV.updated_at,
            )
        )
    )
    return (await session.execute(stmt)).tuples().all()


async def _guarded_save(
    session: AsyncSession, row: StoredCV, cv: TailoredCV, *, expected: int
) -> StoredCV:
    """Persist the mutated `cv` blob onto `row` under an optimistic lock on the `version` column.

    `expected` is the version the **client** was viewing (its `baseVersion`), not whatever the row
    currently holds — so a stale browser tab is caught, not just two requests racing inside the
    backend. Both `sign_off` and `edit_bullet` reassign the *whole* `cv` blob (JSON columns don't
    detect deep mutation), so a writer with a stale view would silently lose-update. The conditional
    UPDATE matches only when `version` still equals `expected` — atomic at the DB — so a stale
    writer gets `rowcount == 0` and a `StaleCV` (→ 409, "reload and retry") rather than clobbering
    the newer state. `version` is bumped and kept in sync with `cv.version` (the model invariant);
    `parentVersion` records the version this change was derived from. `refresh` reloads the row (the
    Core UPDATE bypasses the ORM identity map) so the caller sees the persisted state."""
    cv.parent_version = expected
    cv.version = expected + 1
    result = await session.execute(
        update(StoredCV)
        .where(
            StoredCV.id == row.id,
            StoredCV.workspace_id == row.workspace_id,
            StoredCV.version == expected,
        )
        .values(cv=_dump(cv), version=cv.version)
    )
    if cast("CursorResult[Any]", result).rowcount == 0:
        raise StaleCV(row.id)
    await session.commit()
    await session.refresh(row)
    return row


async def sign_off(
    session: AsyncSession,
    workspace_id: str,
    cv_id: str,
    bullet_ids: list[str],
    *,
    base_version: int,
) -> StoredCV:
    """Clear `needsSignoff` on the named net-new bullets. A bullet already signed off is a no-op;
    an id not present in the CV raises `BulletNotFound`. Persisted under the optimistic lock against
    the client's `base_version`, so a stale tab can't approve text it never saw (→ `StaleCV`).
    Refused on a locked CV (→ `CVLocked`), checked under `lock_cv` so it can't race an apply."""
    await lock_cv(session, cv_id)
    if await is_applied(session, workspace_id, cv_id):
        raise CVLocked(cv_id)
    row = await _row(session, workspace_id, cv_id)
    cv = TailoredCV.model_validate(row.cv)
    by_id = {
        bullet.bullet_id: bullet
        for section in cv.sections
        for item in section.items
        for bullet in item.highlights
    }
    for bullet_id in bullet_ids:
        bullet = by_id.get(bullet_id)
        if bullet is None:
            raise BulletNotFound(bullet_id)
        bullet.needs_signoff = False  # no-op if it was already signed off
    return await _guarded_save(session, row, cv, expected=base_version)


async def edit_bullet(
    session: AsyncSession,
    workspace_id: str,
    cv_id: str,
    bullet_id: str,
    text: str,
    *,
    base_version: int,
) -> StoredCV:
    """Apply a manual text edit to one bullet, re-ground just that bullet (invariant 2), and persist
    under the optimistic lock. A grounded bullet edited from `verbatim` becomes
    `reworded` (it is no longer a verbatim copy); a net-new bullet stays gated, so editing a
    signed-off net-new bullet re-requires sign-off. Other bullets' state is untouched."""
    await lock_cv(session, cv_id)
    if await is_applied(session, workspace_id, cv_id):
        raise CVLocked(cv_id)
    row = await _row(session, workspace_id, cv_id)
    cv = TailoredCV.model_validate(row.cv)
    master = MasterProfile.model_validate(row.master)
    located = next(
        (
            (item, bullet)
            for section in cv.sections
            for item in section.items
            for bullet in item.highlights
            if bullet.bullet_id == bullet_id
        ),
        None,
    )
    if located is None:
        raise BulletNotFound(bullet_id)
    item, bullet = located
    bullet.text = text
    if bullet.origin is Origin.verbatim:
        bullet.origin = Origin.reworded
    reground_bullet(master, item, bullet)
    return await _guarded_save(session, row, cv, expected=base_version)


def _validate_bullet_text(text: str) -> str:
    """Trim + bound a Corrector-supplied bullet text to the SAME 1..MAX_BULLET_LEN contract a manual
    edit enforces (`EditBulletRequest`); return the trimmed value (so the apply path stores the
    stripped text `edit_bullet` would). A blank or oversized model output is a `StructureViolation`
    (→ 422), never an unconstrained write — a bare `ValidationError` here is an unmapped 500."""
    trimmed = text.strip()
    if not 1 <= len(trimmed) <= MAX_BULLET_LEN:
        raise StructureViolation(
            f"corrected bullet text must be 1..{MAX_BULLET_LEN} chars (trimmed)"
        )
    return trimmed


async def apply_corrections(
    session: AsyncSession,
    workspace_id: str,
    cv_id: str,
    revisions: dict[str, str],
    accepted_ids: set[str],
    *,
    base_version: int,
) -> StoredCV:
    """Persist a per-bullet Corrector pass server-authoritatively (dec #7 / invariant 2). The model
    returns only `{bulletId -> text}` for the accepted bullets (DevPR29) — never structure — so
    there is nothing to add/drop/re-parent, and the old whole-CV `assert_structure_preserved`
    tripwire is unnecessary: structure is preserved BY CONSTRUCTION — we splice onto the STORED CV.
    For each accepted bullet we take ONLY its revised text (reword-in-place, like `edit_bullet`)
    and PRESERVE the stored `sourceId`/`origin`, then re-ground from that stored `sourceId` (NEVER
    cv-wide `derive_provenance`, which would clobber prior sign-offs). Because the revision carries
    no `sourceId`, a net-new bullet cannot be silently grounded past sign-off (invariant 2).

    A **missing** revision for an accepted bullet → `StructureViolation` (422, never a bare KeyError
    → 500); a blank/oversized text → `StructureViolation` via `_validate_bullet_text`; an
    extra/unknown revision id is simply ignored (never spliced). Refused on an applied CV
    (`CVLocked` → 409); a
    concurrent change → `StaleCV` (409). Mirrors `edit_bullet`, fanned out to N bullets."""
    await lock_cv(session, cv_id)
    if await is_applied(session, workspace_id, cv_id):
        raise CVLocked(cv_id)
    row = await _row(session, workspace_id, cv_id)
    # expire_on_commit=False: the route's preflight read left this row identity-mapped with stale
    # attributes after its commit — force a fresh read UNDER the lock before we guard against it.
    await session.refresh(row)
    if row.version != base_version:
        raise StaleCV(cv_id)
    stored = TailoredCV.model_validate(row.cv)
    master = MasterProfile.model_validate(row.master)
    for section in stored.sections:
        for item in section.items:
            for bullet in item.highlights:
                if bullet.bullet_id not in accepted_ids:
                    continue
                # Reword-in-place = a TEXT edit, exactly like `edit_bullet`: take only the model's
                # new text and PRESERVE the stored `sourceId`/`origin`. A grounded bullet stays
                # grounded (overstatement on a real source is the Fact-Checker's advisory job); a
                # net-new bullet stays net-new + gated (the revision has no `sourceId` to abuse).
                new_text = revisions.get(bullet.bullet_id)
                if new_text is None:  # the model dropped an accepted bullet → 422, never a KeyError
                    raise StructureViolation(
                        f"no correction returned for accepted bullet {bullet.bullet_id!r}"
                    )
                bullet.text = _validate_bullet_text(new_text)
                if bullet.origin is Origin.verbatim:
                    bullet.origin = Origin.reworded  # a corrected bullet is not a verbatim copy
                reground_bullet(master, item, bullet)
    validate_stable_ids(stored)  # cheap defense — the splice never touches ids, but pin it
    # Resolve — don't delete — the persisted review in the SAME guarded transaction (ADR 0014): mark
    # the applied bullets so their notes flip to a "✓" chip while the candidate's OTHER notes stay.
    # Resurrection of consumed notes is now blocked by `save_review`'s live-CV guard (a stale
    # post-apply settle at version N is refused because the CV is now N+1), not by a delete. The
    # review row stays at N: the verdict stays visible, stale-marked (ADR 0016); the stored
    # review version is unchanged.
    # `_guarded_save` owns the commit; if its optimistic lock trips (StaleCV) nothing here persists.
    await review_store.resolve_threads(session, workspace_id, cv_id, accepted_ids)
    return await _guarded_save(session, row, stored, expected=base_version)


async def delete_cv(session: AsyncSession, workspace_id: str, cv_id: str) -> None:
    """Delete a CV and its optional `cv_labels` + `cv_job_specs` rows, all scoped to the workspace
    (invariant 8). A cross-tenant or unknown id raises `CVNotFound` (→ 404) via `_row` and deletes
    nothing — no other tenant's row is touched. All deletes land in **one commit**. Refused on a
    locked CV (→ `CVLocked`): an applied CV is removed via `delete_application` (which cascades the
    same rows), not here."""
    await lock_cv(session, cv_id)
    if await is_applied(session, workspace_id, cv_id):
        raise CVLocked(cv_id)
    row = await _row(session, workspace_id, cv_id)
    await session.delete(row)
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
    # Drop any persisted review run for this CV in the SAME commit (ADR 0013) — delete_review rides
    # this transaction (no inner commit), so a reload can't resurrect a consumed review.
    await review_store.delete_review(session, workspace_id, cv_id)
    await session.commit()
