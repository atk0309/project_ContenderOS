"""Workspace-scoped CV routes — tailor + persist, read for preview, sign off, gate-checked export.

Every path is scoped by `{workspace_id}` so the auth dep binds it from the route and re-derives the
caller's membership per request (invariant 8) — every allowlisted account is an owner, so one gate
(`require_workspace_owner`) covers every verb. Export is the provenance gate (invariant 2): it
refuses with 409 while any net-new bullet is unsigned. The CV store filters on
`(workspace_id, cv_id)`, so a cross-tenant id is a 404, never a leak.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.ai.agents.corrector import BulletCorrection, CorrectedBullets, run_correct
from app.ai.agents.registry import (
    AuthoringRunnerBuilder,
    ModelResolver,
    PanelRunnerBuilder,
    get_authoring_runner_builder,
    get_model_resolver,
    get_panel_runner_builder,
    get_runner,
)
from app.ai.agents.review import run_review
from app.ai.agents.tailor import run_tailor
from app.ai.draft import build_verbatim_draft
from app.ai.provenance import StructureViolation, ground_thread_anchors
from app.ai.providers.base import ProviderRunner
from app.auth.deps import require_workspace_owner
from app.persistence import cv_store, master_store, review_store
from app.persistence.cv_store import BulletNotFound, CVLocked, CVNotFound, StaleCV
from app.persistence.engine import get_session, get_stream_sessionmaker
from app.persistence.master_store import MasterNotFound
from app.persistence.models import StoredCV, StoredCvLabel
from app.persistence.review_store import ReviewNotFound, ReviewSuperseded, ReviewVersionConflict
from app.schema import (
    ApplyFeedbackRequest,
    CreatedCV,
    CvSummary,
    EditBulletRequest,
    ExportBlocked,
    JobSpec,
    MasterProfile,
    OkResponse,
    RenderBundle,
    ReviewBundle,
    ReviewDecisionsRequest,
    ReviewRequest,
    SavedReview,
    SignoffRequest,
    TailoredCV,
    Thread,
    WorkspaceTailorRequest,
)
from app.schema.common import AnchorKind, Provider, Tier
from app.schema.sse import RunDone
from app.sse_stream import ExecuteCoro, ProgressEmit, stream_sse, wants_stream

log = logging.getLogger("contender.cv")

router = APIRouter(prefix="/workspaces", tags=["cv"])


async def _bundle(session: AsyncSession, workspace_id: str, row: StoredCV) -> RenderBundle:
    """The render bundle for a CV, including the stored `jobSpec` it was tailored to (None for a
    keyless draft) — so the client's posting drawer + Gatekeeper present/met derivation are
    self-contained on any read. Not a render/provenance input (invariant 2)."""
    job = await cv_store.get_job_spec(session, workspace_id, row.id)
    return RenderBundle(
        master=MasterProfile.model_validate(row.master),
        cv=TailoredCV.model_validate(row.cv),
        job_spec=job,
    )


def _summary(cv_row: StoredCV, label: StoredCvLabel | None) -> CvSummary:
    """Project a (CV row, optional label) pair to a dashboard summary. `master` is NOT loaded here
    (list_cvs defers it); only `cv` is validated, for `summary` + the sign-off badge."""
    cv = TailoredCV.model_validate(cv_row.cv)
    return CvSummary(
        id=cv_row.id,
        version=cv_row.version,
        needs_signoff=cv.needs_signoff(),
        summary=cv.summary,
        job_title=label.job_title if label else None,
        company=label.company if label else None,
        created_at=cv_row.created_at,
        updated_at=cv_row.updated_at,
    )


@router.post(
    "/{workspace_id}/cv",
    response_model=CreatedCV,
    dependencies=[Depends(require_workspace_owner)],
)
async def create_cv(
    workspace_id: str,
    body: WorkspaceTailorRequest,
    session: AsyncSession = Depends(get_session),
    runner: ProviderRunner = Depends(get_runner),
    resolve: ModelResolver = Depends(get_model_resolver),
) -> CreatedCV:
    """Tailor the workspace's STORED master to the job, run the provenance gate, then persist
    (owner-only). The master is loaded server-side (invariant 2): provenance is grounded in stored
    truth, never client-supplied JSON. 404 if the owner hasn't saved a master yet."""
    try:
        master = await master_store.get_master(session, workspace_id)
    except MasterNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    cv = await run_tailor(master, body.job_spec, runner=runner, resolve=resolve)
    # The parsed job (owner-supplied in the request body) is persisted server-side: its
    # title/company as the dashboard `cv_labels` row — kept off the Tailor's `TailoredCV` so the
    # model never authors the label (invariant 5) — and the full JobSpec as a `cv_job_specs` row the
    # review panel reads as its target. The keyless route below passes no job, so it gets neither.
    row = await cv_store.create_cv(
        session, workspace_id=workspace_id, master=master, cv=cv, job_spec=body.job_spec
    )
    return CreatedCV(id=row.id, cv=cv)


@router.post(
    "/{workspace_id}/cv/from-master",
    response_model=CreatedCV,
    dependencies=[Depends(require_workspace_owner)],
)
async def create_from_master(
    workspace_id: str, session: AsyncSession = Depends(get_session)
) -> CreatedCV:
    """Build an AI-free **verbatim draft** from the workspace's stored master and persist it
    (owner-only). No provider key needed: every bullet is a verbatim copy of a master highlight, so
    the draft has zero net-new bullets and export is never blocked — the keyless path that closes
    the loop without a key. 404 if no master is stored yet."""
    try:
        master = await master_store.get_master(session, workspace_id)
    except MasterNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    cv = build_verbatim_draft(master)
    row = await cv_store.create_cv(session, workspace_id=workspace_id, master=master, cv=cv)
    return CreatedCV(id=row.id, cv=cv)


@router.get(
    "/{workspace_id}/cv",
    response_model=list[CvSummary],
    dependencies=[Depends(require_workspace_owner)],
)
async def list_cvs(
    workspace_id: str, session: AsyncSession = Depends(get_session)
) -> list[CvSummary]:
    """Every tailored CV in the workspace, newest first, as lightweight summaries for the dashboard
    list. Scoped to the path workspace (invariant 8); a non-member fails closed in the auth dep,
    never here."""
    rows = await cv_store.list_cvs(session, workspace_id)
    return [_summary(cv_row, label) for cv_row, label in rows]


@router.get(
    "/{workspace_id}/cv/{cv_id}",
    response_model=RenderBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def read_cv(
    workspace_id: str, cv_id: str, session: AsyncSession = Depends(get_session)
) -> RenderBundle:
    """The `{master, cv}` preview bundle. Not sign-off-gated — preview shows net-new bullets so
    the owner can decide; export (below) is what the sign-off gate blocks."""
    try:
        row = await cv_store.get_cv(session, workspace_id, cv_id)
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return await _bundle(session, workspace_id, row)


def _reviewed_text(cv: TailoredCV) -> dict[str, str]:
    """`bulletId -> text` snapshot of the CV as reviewed (server-derived). Stored with the run so
    the client can show which text each finding judged even after the CV is later edited (ADR
    0013)."""
    return {
        bullet.bullet_id: bullet.text
        for section in cv.sections
        for item in section.items
        for bullet in item.highlights
    }


async def _tombstone_stale_review(
    session: AsyncSession, workspace_id: str, cv_id: str, prior_updated_at: datetime | None
) -> None:
    """After a settle-time save FAILED: roll back the failed transaction (a commit-time failure
    leaves a `PendingRollback` session; without this the tombstone would raise), then — best-effort
    — delete ONLY the pre-save review row so a stale previous run isn't silently "restored" on the
    next load. Conditional on the captured `updated_at`: a concurrent tab may have saved a NEWER run
    mid-failure, and that must never be deleted. All best-effort — a tombstone hiccup must not mask
    that the (billed) run itself succeeded (invariant 5 surfaces it via `RunDone.detail`/header)."""
    try:
        await session.rollback()
    except Exception:
        log.warning("review: rollback after save failure failed", exc_info=True)
        return
    if prior_updated_at is None:
        return  # no prior run to become stale — nothing to tombstone
    try:
        await review_store.delete_review(
            session, workspace_id, cv_id, only_if_updated_at=prior_updated_at
        )
        await session.commit()  # delete_review rides the caller's txn → commit the tombstone here
    except Exception:
        log.warning("review: stale-run tombstone failed", exc_info=True)


async def _prior_review_updated_at(
    session: AsyncSession, workspace_id: str, cv_id: str
) -> datetime | None:
    """The stored review's `updated_at` right BEFORE a save — the tombstone condition (ADR 0013).
    Best-effort: if even the read fails, fall back to None (no tombstone) rather than raise."""
    try:
        prior = await review_store.get_review(session, workspace_id, cv_id)
    except Exception:
        log.warning("review: could not read prior review before save", exc_info=True)
        return None
    return prior.updated_at if prior is not None else None


def _review_execute(
    *,
    cv: TailoredCV,
    master: MasterProfile,
    job: JobSpec | None,
    cv_version: int,
    workspace_id: str,
    cv_id: str,
    reviewed_text: dict[str, str],
    builder: PanelRunnerBuilder,
) -> ExecuteCoro:
    """Build the streaming review body for `stream_sse`. The shared spine hands it the FRESH stream
    session; it builds the session-free panel runner on that session, fans out the panel (streaming
    per-agent events), **persists the run BEFORE emitting the terminal `RunDone`**, then emits it.
    The whole fan-out — INCLUDING the builder setup — is wrapped so a setup/fan-out failure still
    ends the stream with `RunDone(ok=false)` (dec #4); a failed run persists nothing."""

    async def execute(session: AsyncSession, progress: ProgressEmit) -> None:
        # Capture the prior row's updated_at BEFORE the fan-out, not at settle: a row saved by a
        # concurrent tab DURING this (long) run is newer than this capture, so a save-failure
        # tombstone can never delete it — the conditional delete only ever matches a row that
        # already existed when this run started.
        prior_updated_at = await _prior_review_updated_at(session, workspace_id, cv_id)
        try:
            runner, resolve = await builder(session)
            bundle = await run_review(
                cv, master, job, cv_version, runner=runner, resolve=resolve, progress=progress
            )
        except Exception as exc:
            log.warning("review: fan-out failed (%s)", type(exc).__name__)
            await progress(RunDone(ok=False, detail=type(exc).__name__))
            return
        # Persist BEFORE emitting RunDone (hard constraint): `sse_stream` breaks the relay ON
        # RunDone, then `finally:` cancels this task + closes the session — a bare `asyncio.shield`
        # can orphan the commit on a session the relay then closes. So `shield` the save AND, on
        # cancellation, await it to completion on the still-open session before propagating cancel.
        save = asyncio.ensure_future(
            review_store.save_review(
                session,
                workspace_id=workspace_id,
                cv_id=cv_id,
                cv_version=cv_version,
                bundle=bundle,
                reviewed_text=reviewed_text,
            )
        )
        try:
            await asyncio.shield(save)
        except asyncio.CancelledError:
            # Client disconnected mid-save: let the commit finish on the still-open session,
            # retrieve the result (so asyncio doesn't log "exception was never retrieved"), then
            # propagate the cancellation. If the save itself FAILED, run the same rollback →
            # conditional-tombstone recovery as the failure arm (no RunDone — the stream is gone):
            # otherwise the stale previous row would be silently "restored" on the next mount.
            # EXCEPT `ReviewSuperseded` — a newer version's row won; it must never be tombstoned.
            await asyncio.wait({save})
            save_exc = save.exception()
            if save_exc is not None and not isinstance(save_exc, ReviewSuperseded):
                log.warning("review: settle-time save failed during disconnect", exc_info=save_exc)
                await _tombstone_stale_review(session, workspace_id, cv_id, prior_updated_at)
            raise
        except ReviewSuperseded:
            # A NEWER version's run persisted while this one ran (slow stale-tab run finishing
            # last). Keep the newer row — NO tombstone; this run isn't restorable, so the client
            # keeps its decisions local exactly like a save failure.
            log.info("review: settle-time save superseded by a newer cv version; run succeeded")
            await progress(RunDone(ok=True, detail="save_failed"))
            return
        except Exception:
            # The (billed) run SUCCEEDED but the save failed. Surface, don't lie (invariant 5): its
            # OWN arm — do NOT fall through to the outer handler, which would emit ok=False. Ordered
            # recovery: log → rollback → conditional tombstone → RunDone(ok=True, save_failed).
            log.warning("review: settle-time save failed; run succeeded", exc_info=True)
            await _tombstone_stale_review(session, workspace_id, cv_id, prior_updated_at)
            await progress(RunDone(ok=True, detail="save_failed"))
            return
        await progress(RunDone(ok=True))

    return execute


@router.post(
    "/{workspace_id}/cv/{cv_id}/review",
    response_model=ReviewBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def review_cv(
    workspace_id: str,
    cv_id: str,
    body: ReviewRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    stream_maker: async_sessionmaker[AsyncSession] = Depends(get_stream_sessionmaker),
    builder: PanelRunnerBuilder = Depends(get_panel_runner_builder),
) -> ReviewBundle | Response:
    """Run the AI review panel over a stored CV (owner-only) — Editor / Fact-Checker / Spotter and,
    when the CV targets a job, the Gatekeeper. The CV + its stored master + `JobSpec` load
    server-side (invariants 2 & 8); the adjudicators read the `TailoredCV` JSON (ADR 0010). A
    no-job draft runs only the job-independent agents (Fact-Checker + Spotter), so `gatekeeper` /
    `editor` stay null. With `Accept: text/event-stream` the panel STREAMS per-agent SSE
    (`AgentStarted` / `AgentReport` / `AgentDone`, terminal `RunDone`); otherwise it blocks and
    returns the full `ReviewBundle`. **Advisory** — nothing here gates export (invariant 2); only
    sign-off does. Provider config (unset tier / missing key) → 503 preflight; a per-agent in-flight
    failure DEGRADES (it lands in `failures` / an `AgentDone(ok=false)`), it never fails the request
    (invariant 5 is met by surfacing it explicitly, not by an HTTP error)."""
    try:
        row = await cv_store.get_cv(session, workspace_id, cv_id)
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    # Stale-tab guard (matches export/apply): reject BEFORE the billed fan-out if the client's view
    # is behind the stored row — otherwise it pays for a review of a version it isn't showing.
    if row.version != body.base_version:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "this CV changed since you loaded it; reload and review again"
        )
    job = await cv_store.get_job_spec(session, workspace_id, cv_id)
    cv = TailoredCV.model_validate(row.cv)
    master = MasterProfile.model_validate(row.master)
    reviewed_text = _reviewed_text(cv)
    if wants_stream(request):
        # Preflight the panel on the REQUEST session: an unset tier / missing key becomes a clean
        # 503 BEFORE the 200, and the client singletons warm so the stream rebuild is a cache hit.
        await builder(session)
        return stream_sse(
            # No per-run id: the review is a latest-only snapshot keyed by cv_id, not a run row
            # (ADR 0013 — still no X-Run-Id, else the FE mints a fake resultRef).
            run_id=None,
            stream_maker=stream_maker,
            execute=_review_execute(
                cv=cv,
                master=master,
                job=job,
                cv_version=row.version,
                workspace_id=workspace_id,
                cv_id=cv_id,
                reviewed_text=reviewed_text,
                builder=builder,
            ),
        )
    # Capture BEFORE the fan-out (a concurrent tab's row saved DURING the run is newer than this
    # capture → the save-failure tombstone can never delete it).
    prior_updated_at = await _prior_review_updated_at(session, workspace_id, cv_id)
    runner, resolve = await builder(session)
    bundle = await run_review(cv, master, job, row.version, runner=runner, resolve=resolve)
    # Settle-time persist (blocking arm). A completed (billed) run must never 500 on a save hiccup:
    # on failure, roll back, best-effort tombstone the stale prior run, and set `X-Review-Saved:
    # false` so a JSON caller can tell the review isn't restorable — then still return the 200.
    try:
        await review_store.save_review(
            session,
            workspace_id=workspace_id,
            cv_id=cv_id,
            cv_version=row.version,
            bundle=bundle,
            reviewed_text=reviewed_text,
        )
    except ReviewSuperseded:
        # A NEWER version's run persisted while this one ran — keep it (never tombstone it); this
        # run just isn't restorable.
        log.info("review: settle-time save superseded by a newer cv version; run succeeded")
        response.headers["X-Review-Saved"] = "false"
    except Exception:
        log.warning("review: settle-time save failed; run succeeded", exc_info=True)
        await _tombstone_stale_review(session, workspace_id, cv_id, prior_updated_at)
        response.headers["X-Review-Saved"] = "false"
    return bundle


@router.get(
    "/{workspace_id}/cv/{cv_id}/review",
    response_model=SavedReview | None,
    dependencies=[Depends(require_workspace_owner)],
)
async def read_review(
    workspace_id: str, cv_id: str, session: AsyncSession = Depends(get_session)
) -> SavedReview | None:
    """The persisted latest review run for a CV (owner-only), or **200-null** when none is stored
    (ADR 0013). Deliberately NOT 404: the rehydrate probe fires on every workspace mount, and a 404
    would reintroduce the console noise. A stored bundle that no longer validates against the
    current `ReviewBundle` (a schema skew — `CamelModel` is `extra="forbid"`) also reads as
    **200-null** with a warning, so a contract change self-heals as "no review" instead of a 500."""
    row = await review_store.get_review(session, workspace_id, cv_id)
    if row is None:
        return None
    # Orphan guard: a lockless settle can outlive a concurrent CV delete (ADR 0013's accepted
    # orphan row). Never serve a review for a CV that no longer exists — self-heal by deleting
    # the orphan and reading as absent.
    if not await cv_store.cv_exists(session, workspace_id, cv_id):
        log.warning("review: orphan review row for deleted cv=%s; removing", cv_id)
        await review_store.delete_review(session, workspace_id, cv_id)
        await session.commit()
        return None
    try:
        return SavedReview.model_validate(
            {
                "cvId": row.cv_id,
                "bundle": row.bundle,
                "reviewedText": row.reviewed_text,
                "decisions": row.decisions,
                "updatedAt": row.updated_at,
            }
        )
    except ValidationError:
        log.warning(
            "review: stored review for cv=%s no longer validates; treating as absent", cv_id
        )
        return None


@router.put(
    "/{workspace_id}/cv/{cv_id}/review/decisions",
    response_model=OkResponse,
    dependencies=[Depends(require_workspace_owner)],
)
async def set_review_decisions(
    workspace_id: str,
    cv_id: str,
    body: ReviewDecisionsRequest,
    session: AsyncSession = Depends(get_session),
) -> OkResponse:
    """Persist the owner's WHOLE per-finding decisions snapshot for a stored review (owner-only,
    ADR 0013) — whole-snapshot last-write-wins at the same review version (invariant 7). **404**
    (`ReviewNotFound`) if no review is stored; **409** (`ReviewVersionConflict`) if the stored
    review is a different CV version than the client shows (it was re-run since) — the server-side
    defense against a stale writer; **422** if the body is over bounds (≤512 entries, ≤512
    chars/key)."""
    # Orphan guard (mirrors the GET): decisions must not land on a review row whose CV was
    # deleted out from under a lockless settle.
    if not await cv_store.cv_exists(session, workspace_id, cv_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no CV {cv_id!r} in this workspace")
    try:
        await review_store.set_decisions(
            session, workspace_id, cv_id, body.decisions, body.cv_version
        )
    except ReviewNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except ReviewVersionConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return OkResponse()


@router.delete(
    "/{workspace_id}/cv/{cv_id}/review",
    response_model=OkResponse,
    dependencies=[Depends(require_workspace_owner)],
)
async def clear_review(
    workspace_id: str, cv_id: str, session: AsyncSession = Depends(get_session)
) -> OkResponse:
    """Owner clears the persisted review for a CV (the "Clear review" action): wipe the run + its
    per-finding decisions so the panel/diff reset. Idempotent — `delete_review` is 0-row-safe, so a
    second clear (or clearing a never-reviewed CV) is a **200 no-op**, never a 404. Needs a
    commit: `delete_review` rides the caller's transaction (like the GET's orphan-delete)."""
    await review_store.delete_review(session, workspace_id, cv_id)
    await session.commit()
    return OkResponse()


@router.post(
    "/{workspace_id}/cv/{cv_id}/signoff",
    response_model=RenderBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def sign_off(
    workspace_id: str,
    cv_id: str,
    body: SignoffRequest,
    session: AsyncSession = Depends(get_session),
) -> RenderBundle:
    """Owner approves net-new bullets, clearing `needsSignoff` (idempotent). Unblocks export."""
    try:
        row = await cv_store.sign_off(
            session, workspace_id, cv_id, body.bullet_ids, base_version=body.base_version
        )
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except BulletNotFound as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    except StaleCV as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return await _bundle(session, workspace_id, row)


@router.post(
    "/{workspace_id}/cv/{cv_id}/edit",
    response_model=RenderBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def edit_bullet(
    workspace_id: str,
    cv_id: str,
    body: EditBulletRequest,
    session: AsyncSession = Depends(get_session),
) -> RenderBundle:
    """Owner edits one tailored bullet's text. The server re-grounds just that bullet (invariant 2):
    a grounded bullet stays grounded (verbatim→reworded), a net-new bullet stays gated. 422 for an
    unknown bullet id; 409 if the CV was changed concurrently (reload and retry)."""
    try:
        row = await cv_store.edit_bullet(
            session, workspace_id, cv_id, body.bullet_id, body.text, base_version=body.base_version
        )
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except BulletNotFound as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    except StaleCV as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return await _bundle(session, workspace_id, row)


def _master_highlight_text(
    master: MasterProfile, item_source_id: str, bullet_source_id: str | None
) -> str | None:
    """The master highlight text a bullet is grounded on, for the Corrector's per-bullet context.
    None for a net-new bullet (`sourceId` None) or a dangling `sourceId` (defensive `next(…, None)`
    — never an index → 500)."""
    if bullet_source_id is None:
        return None
    work = next((w for w in master.work if w.id == item_source_id), None)
    if work is None:
        return None
    return next((h.text for h in work.highlights if h.id == bullet_source_id), None)


def _bullet_contexts(
    cv: TailoredCV, master: MasterProfile, accepted: Sequence[Thread]
) -> list[BulletCorrection]:
    """Group the accepted threads by bullet and attach each bullet's current text + master grounding
    text (DevPR29 per-bullet Corrector input). `accepted` ids are grounded to real CV bullets
    (`ground_thread_anchors`), so every id resolves; a bullet may carry >1 accepted note."""
    index = {
        b.bullet_id: (item, b)
        for section in cv.sections
        for item in section.items
        for b in item.highlights
    }
    by_bullet: dict[str, list[Thread]] = {}
    order: list[str] = []
    for t in accepted:
        if t.anchor_id not in by_bullet:
            by_bullet[t.anchor_id] = []
            order.append(t.anchor_id)
        by_bullet[t.anchor_id].append(t)
    contexts: list[BulletCorrection] = []
    for bid in order:
        item, bullet = index[bid]
        contexts.append(
            BulletCorrection(
                bullet_id=bid,
                current_text=bullet.text,
                master_text=_master_highlight_text(master, item.source_id, bullet.source_id),
                threads=list(by_bullet[bid]),
            )
        )
    return contexts


def _revisions_map(result: CorrectedBullets) -> dict[str, str]:
    """Collapse the model's revision LIST to a `{bulletId: text}` map, rejecting a DUPLICATE id here
    (a dict would silently last-win). A missing accepted id / blank / oversized text is caught at
    splice time in `cv_store.apply_corrections` (422); an unknown id is ignored there (safe)."""
    revisions: dict[str, str] = {}
    for rev in result.revisions:
        if rev.bullet_id in revisions:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"duplicate correction for bullet {rev.bullet_id!r}",
            )
        revisions[rev.bullet_id] = rev.text
    return revisions


@router.post(
    "/{workspace_id}/cv/{cv_id}/apply",
    response_model=RenderBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def apply_corrections(
    workspace_id: str,
    cv_id: str,
    body: ApplyFeedbackRequest,
    session: AsyncSession = Depends(get_session),
    builder: AuthoringRunnerBuilder = Depends(get_authoring_runner_builder),
) -> RenderBundle:
    """Owner applies accepted review threads as Corrector rewrites (dec #7). A cheap preflight
    rejects a stale/locked CV **before** the billed LLM; the Claude call then runs OUTSIDE any DB
    transaction (a session-free authoring runner + a committed preflight), and the short critical
    section guards + saves under the lock. v1 corrects only **bullet**-anchored threads (item /
    section / summary are advisory-only); the server trusts the client threads as INPUT only — the
    output structural guard + selective re-ground decide what persists (invariant 2). 404 unknown
    id; 409 stale / locked; 422 a structurally-invalid or blank/oversized correction, or no
    correctable bullet thread; 503 if the Anthropic tier/key is unset (preflight)."""
    try:
        row = await cv_store.get_cv(session, workspace_id, cv_id)
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    # Stale-tab guard: reject BEFORE the billed Corrector call if the client's view is behind.
    if row.version != body.base_version:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "this CV changed since you loaded it; reload and apply again"
        )
    # Cheap lock pre-check (re-checked authoritatively under the lock in apply_corrections).
    if await cv_store.is_applied(session, workspace_id, cv_id):
        raise CVLocked(cv_id)  # globally mapped → 409, like edit / sign-off / delete
    cv = TailoredCV.model_validate(row.cv)
    master = MasterProfile.model_validate(row.master)
    # v1: only bullet-anchored threads are correctable; drop non-bullet + dead anchors (ADR 0003).
    accepted = ground_thread_anchors(
        [t for t in body.threads if t.anchor_kind is AnchorKind.bullet], cv
    )
    if not accepted:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "no correctable bullet-anchored threads"
        )
    # Per-bullet Corrector (DevPR29): send ONLY the accepted bullets (current text + master text +
    # their accepted threads), not the whole CV — latency scales with edit size, not CV size.
    contexts = _bullet_contexts(cv, master, accepted)
    # Resolve the model + build the client on the request session, then COMMIT — so the multi-second
    # Claude call (and the post-call write) hold no idle transaction (the session-free runner keeps
    # the network call DB-free too). A missing Anthropic tier/key raises here → a clean 503.
    runner, resolve = await builder(session, Provider.anthropic, Tier.strong)
    await session.commit()
    result = await run_correct(contexts, runner=runner, resolve=resolve)
    revisions = _revisions_map(result)  # 422 on a duplicate bulletId (a dict would last-win)
    try:
        row = await cv_store.apply_corrections(
            session,
            workspace_id,
            cv_id,
            revisions,
            {t.anchor_id for t in accepted},
            base_version=body.base_version,
        )
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except StaleCV as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except StructureViolation as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return await _bundle(session, workspace_id, row)


@router.get(
    "/{workspace_id}/cv/{cv_id}/export",
    response_model=RenderBundle,
    responses={status.HTTP_409_CONFLICT: {"model": ExportBlocked}},
    dependencies=[Depends(require_workspace_owner)],
)
async def export_cv(
    workspace_id: str, cv_id: str, session: AsyncSession = Depends(get_session)
) -> RenderBundle | JSONResponse:
    """Gate-checked render bundle (invariant 2). 409 with the blocking bullet ids while any net-new
    bullet is unsigned; otherwise the `{master, cv}` cleared for render. Owner-only."""
    try:
        row = await cv_store.get_cv(session, workspace_id, cv_id)
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    cv = TailoredCV.model_validate(row.cv)
    if cv.needs_signoff():
        blocked = [
            bullet.bullet_id
            for section in cv.sections
            for item in section.items
            for bullet in item.highlights
            if bullet.needs_signoff
        ]
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=ExportBlocked(blocked_bullet_ids=blocked).model_dump(by_alias=True),
        )
    return await _bundle(session, workspace_id, row)


@router.delete(
    "/{workspace_id}/cv/{cv_id}",
    response_model=OkResponse,
    dependencies=[Depends(require_workspace_owner)],
)
async def delete_cv(
    workspace_id: str, cv_id: str, session: AsyncSession = Depends(get_session)
) -> OkResponse:
    """Owner deletes a tailored CV and its dashboard label. Unknown or cross-tenant id → **404**
    (the store filters on `(workspace_id, cv_id)`, so no other tenant's CV is reachable). Returns
    `200 {ok}` (not 204) so the shared `api()` client, which parses every body, doesn't throw."""
    try:
        await cv_store.delete_cv(session, workspace_id, cv_id)
    except CVNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return OkResponse()
