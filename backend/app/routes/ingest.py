"""Workspace-scoped ingestion routes — build the master from a CV / LinkedIn document.

Owner-only (the candidate builds their own master, invariant 8). Every path binds `{workspace_id}`,
so the auth dep re-derives the caller's role per request and the store scopes every query to it — a
cross-tenant run/proposal id is a 404. The owner's accept is the ingestion sign-off gate (inv 2):
proposals persist server-side; `apply` works by stored `proposalId`, never a client master blob.

Two input arms share one spine (`_ingest_pipeline`): **paste** text (`POST .../ingest`) and a PDF
**upload** (`POST .../ingest/file`, sent to Claude as a native document block — ADR 0007). pypdf
gives uploads a stored text copy + a page/size guard; native extraction can fall back to that text.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Callable

from anthropic import BadRequestError
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.ai.agents.ingest import NATIVE_PDF_INPUT, ProgressEmit, run_extract, run_ingest
from app.ai.agents.registry import ModelResolver, get_model_resolver, get_runner
from app.ai.ingest_apply import IngestApplyError
from app.ai.pdf_text import (
    MAX_PDF_BYTES,
    PdfTooLarge,
    PdfTooManyPages,
    PdfUnreadable,
    extract_pdf_text,
)
from app.ai.providers.base import AgentParseError, Document, ProviderRunner
from app.auth.deps import require_workspace_owner
from app.persistence import ingest_store, master_store
from app.persistence.engine import get_session, get_stream_sessionmaker
from app.persistence.ingest_store import (
    IneligibleProposal,
    OpenRunExists,
    ProposalNotFound,
    RunNotEditable,
    RunNotFound,
    StaleMaster,
    StaleProposal,
)
from app.persistence.master_store import MasterNotFound
from app.schema import MasterProfile
from app.schema.common import Provider, Tier
from app.schema.ingest import (
    ApplyResult,
    BulkDecideRequest,
    DecideProposalRequest,
    ExtractedProfile,
    IngestionRun,
    IngestionRunBundle,
    IngestRunStatus,
    IngestSourceType,
    PasteIngestRequest,
    ProposalAction,
)
from app.schema.sse import RunDone
from app.sse_stream import ExecuteCoro, stream_sse, wants_stream

log = logging.getLogger("contender.ingest")

router = APIRouter(prefix="/workspaces", tags=["ingest"])

# Failures that justify a one-shot retry WITHOUT the PDF block: a 400 the API returns for the
# (document + schema) combination — an unprocessable document, or "schema too complex"
# (`BadRequestError`) — or no schema-valid output (`AgentParseError`). Deliberately NARROW: NOT the
# base `APIError` (it also covers 429/timeout/5xx/network — text-only would just fail again and bill
# a second call; let those 502), NOT AgentTruncated (output limit — text-only truncates again), NOT
# AgentRefusal (a real refusal — surface it, invariant 5), NOT ProviderConfigError (a 503).
_FALLBACK_ERRORS = (BadRequestError, AgentParseError)


async def _extract(
    doc_text: str,
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
    document: Document | None,
    progress: ProgressEmit | None = None,
) -> ExtractedProfile:
    """Run the Extractor. For an uploaded PDF (`document` present) attempt the native document block
    first with a NEUTRAL text prompt (the PDF is the input; the pypdf `doc_text` is
    evidence/fallback only, ADR 0007 — never prompt input beside the PDF). If it fails with a
    fallback-eligible error AND pypdf got usable text, retry once text-only over `doc_text` (ADR
    0007's documented fallback). An empty `doc_text` (a scanned PDF pypdf couldn't read) has nothing
    to retry over, so the native error re-raises (a loud failure, never a silent zero-proposal
    'success'). Paste (`document is None`) is a plain pass-through. `progress` (streaming arm) flows
    to `run_extract` for per-agent events."""
    if document is None:
        return await run_extract(doc_text, runner=runner, resolve=resolve, progress=progress)
    try:
        return await run_extract(
            NATIVE_PDF_INPUT, runner=runner, resolve=resolve, document=document, progress=progress
        )
    except _FALLBACK_ERRORS:
        if not doc_text.strip():
            raise
        log.warning("ingest: native PDF extract failed; retrying text-only")
        # Streaming: the retry re-runs all sections, so each emits a second AgentStarted/AgentDone;
        # the client keys the checklist by agentId (last-event-wins), so a section that failed
        # natively flips back to done on the text retry.
        return await run_extract(doc_text, runner=runner, resolve=resolve, progress=progress)


async def _get_master(session: AsyncSession, workspace_id: str) -> MasterProfile | None:
    try:
        return await master_store.get_master(session, workspace_id)
    except MasterNotFound:
        return None


async def _prepare_run(
    *,
    workspace_id: str,
    session: AsyncSession,
    resolve: ModelResolver,
    source_type: IngestSourceType,
    doc_text: str,
    master: MasterProfile | None,
    filename: str | None = None,
) -> str:
    """The cheap, must-keep-HTTP-status phase, run in the handler BEFORE any streaming response:
    pre-flight the Extractor's tier (503) and open the run row FIRST (409 if one is already open) —
    so both fail as a real HTTP status, not mid-stream. Returns the new run id. (A missing/
    undecryptable provider key surfaces later as the run's failure: `RunDone(ok=False)` + the failed
    run's `failureReason`, which already carries the actionable 'add it in the admin menu' text.)"""
    await resolve(Provider.anthropic, Tier.strong)
    try:
        run = await ingest_store.create_run(
            session,
            workspace_id=workspace_id,
            source_type=source_type,
            doc_text=doc_text,
            master=master,
            filename=filename,
        )
    except OpenRunExists as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return run.id


async def _finish(
    progress: ProgressEmit | None, run_id: str, bundle: IngestionRunBundle
) -> IngestionRunBundle | None:
    """Terminal step. Streaming arm: emit `RunDone{result_ref}` (return None). Blocking arm: return
    the bundle. `ok` is derived from the run's final status — `review` succeeded; a run
    discarded/reaped from under the pipeline (a CAS-false branch) is `ok=False`, so the client
    reloads it and shows the discarded/failed card, not a phantom success."""
    if progress is not None:
        ok = bundle.run.status is IngestRunStatus.review
        await progress(RunDone(ok=ok, result_ref=run_id))
        return None
    return bundle


async def _execute_run(
    *,
    workspace_id: str,
    run_id: str,
    master: MasterProfile | None,
    doc_text: str,
    document: Document | None,
    session: AsyncSession,
    resolve: ModelResolver,
    runner: ProviderRunner,
    progress: ProgressEmit | None = None,
) -> IngestionRunBundle | None:
    """The slow agent phase, shared by both arms (the old `_ingest_pipeline` tail). One mark-failed
    guard over extract → reconcile → build → persist so a failure can't wedge the workspace.

    BLOCKING (`progress is None`): returns the bundle; on failure marks failed then re-raises for
    the global 422/502/503 mapping — byte-for-byte the prior behaviour.

    STREAMING (`progress` set): emits per-agent events (via `progress`, threaded into run_extract/
    run_ingest) and a terminal `RunDone`, and NEVER re-raises — the 200 + headers are already
    committed, so the AgentError->HTTP handlers can't fire. A failure becomes `RunDone(ok=False)`
    (the failed run row, loaded via `result_ref`, carries the kind/reason). The terminal `RunDone`
    is emitted even if `mark_failed` itself throws, so the stream always ends."""
    try:
        # The SAME `master` create_run hashed into snapshot_hash is reconciled against (never a
        # re-read), so the proposals' baked targets match the run's staleness token.
        extracted = await _extract(
            doc_text, runner=runner, resolve=resolve, document=document, progress=progress
        )
        # When both sides have work, flip extracting → reconciling. A False return means the run was
        # discarded/reaped during extraction — surface the (discarded) run rather than burn a
        # Reconciler call on a dead one (`and` short-circuits, so it only fires with work to match).
        if (
            master is not None
            and master.work
            and extracted.work
            and not await ingest_store.mark_reconciling(
                session, workspace_id=workspace_id, run_id=run_id
            )
        ):
            bundle = await ingest_store.get_run_bundle(session, workspace_id, run_id)
            return await _finish(progress, run_id, bundle)
        proposals = await run_ingest(
            extracted, master, doc_text, runner=runner, resolve=resolve, progress=progress
        )
        bundle = await ingest_store.save_proposals_and_review(
            session, workspace_id=workspace_id, run_id=run_id, proposals=proposals
        )
        return await _finish(progress, run_id, bundle)
    except Exception as exc:
        try:
            await ingest_store.mark_failed(
                session,
                workspace_id=workspace_id,
                run_id=run_id,
                kind=type(exc).__name__,
                reason=str(exc),
            )
        finally:
            if progress is not None:
                await progress(RunDone(ok=False, result_ref=run_id))
        if progress is None:
            raise
        return None


# The streaming generator owns a FRESH session (the request one is torn down once the response
# finishes and isn't concurrency-safe), so it must rebuild the resolver + runner from THAT session,
# not the request's injected closures. These factories make the session→resolver/runner builders
# injectable, so a test fakes the generator's runner exactly as it fakes the request's `get_runner`.
RunnerFactory = Callable[[AsyncSession], ProviderRunner]
ResolverFactory = Callable[[AsyncSession], ModelResolver]


def get_runner_factory() -> RunnerFactory:
    return get_runner


def get_resolver_factory() -> ResolverFactory:
    return get_model_resolver


def _ingest_execute(
    *,
    workspace_id: str,
    run_id: str,
    master: MasterProfile | None,
    doc_text: str,
    document: Document | None,
    runner_factory: RunnerFactory,
    resolver_factory: ResolverFactory,
) -> ExecuteCoro:
    """Build the streaming pipeline body for `stream_sse`. The shared spine hands it a FRESH session
    (the request one is torn down once the response finishes and isn't concurrency-safe), so it
    rebuilds the resolver + runner from THAT session via the factories — not the request's `Depends`
    closures. `_execute_run` owns the terminal-`RunDone` guarantee, so the stream always ends."""

    async def execute(session: AsyncSession, progress: ProgressEmit) -> None:
        await _execute_run(
            workspace_id=workspace_id,
            run_id=run_id,
            master=master,
            doc_text=doc_text,
            document=document,
            session=session,
            resolve=resolver_factory(session),
            runner=runner_factory(session),
            progress=progress,
        )

    return execute


def _looks_like_pdf(file: UploadFile) -> bool:
    """Accept by declared content-type OR a `.pdf` extension — some browsers send
    `application/octet-stream` for a genuine PDF. Anything that slips through still fails at
    `extract_pdf_text` (→ 422)."""
    name = (file.filename or "").lower()
    return file.content_type == "application/pdf" or name.endswith(".pdf")


async def _read_capped(file: UploadFile) -> bytes:
    """Read the upload in chunks, raising `PdfTooLarge` the moment it exceeds the byte cap, so an
    over-cap (or no-content-length) upload is never materialized whole in memory. Starlette has
    already spooled the part to disk; this bounds the in-memory copy and rejects fast. The frontend
    file-size guard + the proxy content-length net are the earlier best-effort layers; this is the
    authoritative server-side cap."""
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1 << 20):  # 1 MiB at a time
        total += len(chunk)
        if total > MAX_PDF_BYTES:
            raise PdfTooLarge
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/{workspace_id}/ingest",
    response_model=IngestionRunBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def start_ingest(
    workspace_id: str,
    body: PasteIngestRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
    runner: ProviderRunner = Depends(get_runner),
    resolve: ModelResolver = Depends(get_model_resolver),
    stream_maker: async_sessionmaker[AsyncSession] = Depends(get_stream_sessionmaker),
    runner_factory: RunnerFactory = Depends(get_runner_factory),
    resolver_factory: ResolverFactory = Depends(get_resolver_factory),
) -> IngestionRunBundle | Response:
    """Paste a CV / LinkedIn document → run the Extractor → reviewable net-new proposals. With
    `Accept: text/event-stream` the same synchronous run is streamed as per-agent SSE progress
    (ending in `RunDone{resultRef}`, then the client reloads the bundle); otherwise it blocks and
    returns the bundle. See `_prepare_run` / `_execute_run` for the run-row-first / mark-failed /
    409 / 503 semantics."""
    if not body.text.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "paste some text to import")
    master = await _get_master(session, workspace_id)
    streaming = wants_stream(request)
    run_id = await _prepare_run(
        workspace_id=workspace_id,
        session=session,
        resolve=resolve,
        source_type=body.source_type,
        doc_text=body.text,
        master=master,
    )
    if streaming:
        return stream_sse(
            run_id=run_id,
            stream_maker=stream_maker,
            execute=_ingest_execute(
                workspace_id=workspace_id,
                run_id=run_id,
                master=master,
                doc_text=body.text,
                document=None,
                runner_factory=runner_factory,
                resolver_factory=resolver_factory,
            ),
        )
    bundle = await _execute_run(
        workspace_id=workspace_id,
        run_id=run_id,
        master=master,
        doc_text=body.text,
        document=None,
        session=session,
        resolve=resolve,
        runner=runner,
    )
    assert bundle is not None  # the blocking arm (progress=None) always returns the bundle
    return bundle


@router.post(
    "/{workspace_id}/ingest/file",
    response_model=IngestionRunBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def start_ingest_file(
    workspace_id: str,
    request: Request,
    file: UploadFile = File(...),
    source_type: IngestSourceType = Form(IngestSourceType.cv_pdf, alias="sourceType"),
    session: AsyncSession = Depends(get_session),
    runner: ProviderRunner = Depends(get_runner),
    resolve: ModelResolver = Depends(get_model_resolver),
    stream_maker: async_sessionmaker[AsyncSession] = Depends(get_stream_sessionmaker),
    runner_factory: RunnerFactory = Depends(get_runner_factory),
    resolver_factory: ResolverFactory = Depends(get_resolver_factory),
) -> IngestionRunBundle | Response:
    """Upload a PDF (a CV, or a LinkedIn 'Save to PDF' export) → extract natively via Claude's
    document block (ADR 0007) → reviewable net-new proposals. pypdf supplies the stored text copy
    and the byte/page guard (413/422); the run then proceeds as the paste path (with the native
    text-only fallback), blocking or — with `Accept: text/event-stream` — streamed as SSE progress.
    Owner-only; `sourceType=pasted` belongs to the text route (422)."""
    if source_type is IngestSourceType.pasted:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "use the paste endpoint for text; upload a PDF here",
        )
    if not _looks_like_pdf(file):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "please upload a PDF file")
    # Read with an early byte-cap abort, then enforce the page cap + extract text in a threadpool
    # (pypdf is CPU-bound). PdfTooLarge/PdfTooManyPages → 413; an unreadable/non-PDF → 422.
    try:
        data = await _read_capped(file)
        doc_text = await run_in_threadpool(extract_pdf_text, data)
    except (PdfTooLarge, PdfTooManyPages) as exc:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, str(exc)) from exc
    except PdfUnreadable as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    document = Document(data_b64=base64.b64encode(data).decode("ascii"))
    master = await _get_master(session, workspace_id)
    streaming = wants_stream(request)
    run_id = await _prepare_run(
        workspace_id=workspace_id,
        session=session,
        resolve=resolve,
        source_type=source_type,
        doc_text=doc_text,
        master=master,
        filename=file.filename,
    )
    if streaming:
        return stream_sse(
            run_id=run_id,
            stream_maker=stream_maker,
            execute=_ingest_execute(
                workspace_id=workspace_id,
                run_id=run_id,
                master=master,
                doc_text=doc_text,
                document=document,
                runner_factory=runner_factory,
                resolver_factory=resolver_factory,
            ),
        )
    bundle = await _execute_run(
        workspace_id=workspace_id,
        run_id=run_id,
        master=master,
        doc_text=doc_text,
        document=document,
        session=session,
        resolve=resolve,
        runner=runner,
    )
    assert bundle is not None  # the blocking arm (progress=None) always returns the bundle
    return bundle


@router.get(
    "/{workspace_id}/ingest",
    response_model=list[IngestionRun],
    dependencies=[Depends(require_workspace_owner)],
)
async def list_ingest_runs(
    workspace_id: str, session: AsyncSession = Depends(get_session)
) -> list[IngestionRun]:
    """Runs newest-first — the recovery / history surface (a dropped upload is reachable here)."""
    return await ingest_store.list_runs(session, workspace_id)


@router.get(
    "/{workspace_id}/ingest/{run_id}",
    response_model=IngestionRunBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def get_ingest_run(
    workspace_id: str, run_id: str, session: AsyncSession = Depends(get_session)
) -> IngestionRunBundle:
    """The run + proposals (reload-safe, deep-linkable). Unknown / cross-tenant id → 404."""
    try:
        return await ingest_store.get_run_bundle(session, workspace_id, run_id)
    except RunNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc


@router.post(
    "/{workspace_id}/ingest/{run_id}/proposals/{proposal_id}",
    response_model=IngestionRunBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def decide_proposal(
    workspace_id: str,
    run_id: str,
    proposal_id: str,
    body: DecideProposalRequest,
    session: AsyncSession = Depends(get_session),
) -> IngestionRunBundle:
    """Accept / decline / edit one proposal (optimistic-locked on its version → 409 if stale)."""
    try:
        return await ingest_store.act_on_proposal(
            session,
            workspace_id=workspace_id,
            run_id=run_id,
            proposal_id=proposal_id,
            action=body.action,
            edited=body.edited,
            base_version=body.base_version,
        )
    except (ProposalNotFound, RunNotFound) as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except (StaleProposal, RunNotEditable) as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/{workspace_id}/ingest/{run_id}/decide",
    response_model=IngestionRunBundle,
    dependencies=[Depends(require_workspace_owner)],
)
async def bulk_decide_proposals(
    workspace_id: str,
    run_id: str,
    body: BulkDecideRequest,
    session: AsyncSession = Depends(get_session),
) -> IngestionRunBundle:
    """Bulk accept/decline. The server only flips proposals that are genuinely still pending, and on
    accept ("Add all new items") only `net-new` ones — so the client's list can't widen the gate
    (invariant 2). Unknown id → 404; an enrich/correction in an accept → 422; stale item → 409."""
    if body.action is ProposalAction.edit:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "bulk action must be accept or decline"
        )
    items = [(it.proposal_id, it.base_version) for it in body.items]
    try:
        return await ingest_store.bulk_decide(
            session,
            workspace_id=workspace_id,
            run_id=run_id,
            items=items,
            action=body.action,
            require_net_new=body.action is ProposalAction.accept,
        )
    except (ProposalNotFound, RunNotFound) as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except IneligibleProposal as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    except (StaleProposal, RunNotEditable) as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/{workspace_id}/ingest/{run_id}/apply",
    response_model=ApplyResult,
    dependencies=[Depends(require_workspace_owner)],
)
async def apply_ingest_run(
    workspace_id: str, run_id: str, session: AsyncSession = Depends(get_session)
) -> ApplyResult:
    """Apply the accepted proposals to the master under the advisory lock. 409 if the master changed
    since the run started (staleness); 422 if the result isn't a valid master (e.g. first-run
    identity
    incomplete); partial — conflicts are reported, the rest still lands."""
    try:
        return await ingest_store.apply_run(session, workspace_id, run_id)
    except RunNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except StaleMaster as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except IngestApplyError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


@router.post(
    "/{workspace_id}/ingest/{run_id}/discard",
    response_model=IngestionRun,
    dependencies=[Depends(require_workspace_owner)],
)
async def discard_ingest_run(
    workspace_id: str, run_id: str, session: AsyncSession = Depends(get_session)
) -> IngestionRun:
    """Abandon a run — the escape hatch from a wedged/unwanted run, freeing the workspace."""
    try:
        return await ingest_store.discard_run(session, workspace_id, run_id)
    except RunNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
