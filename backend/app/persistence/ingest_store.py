"""Ingestion store: runs + proposals, scoped by workspace (invariant 8).

Routes stay thin (AGENTS §8). Every read/write filters on `workspace_id` (and `run_id`/`proposal_id`
where relevant), so a cross-tenant guess is a 404, never a leak. Proposal accept/decline/edit ride
an optimistic lock on the proposal `version` column (mirrors `cv_store._guarded_save`). `apply_run`
does the master read-modify-write in ONE transaction under the per-workspace advisory lock, refusing
(409) if the master changed since the run was created (staleness). The one-open-run guard is the DB
partial-unique index (`models.py`), so two concurrent creates can't both open a run.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

from pydantic import ValidationError
from sqlalchemy import CursorResult, select, update
from sqlalchemy.exc import IntegrityError

from app.ai.ingest_apply import apply_accepted, master_hash
from app.persistence.locks import lock_workspace_master
from app.persistence.master_store import MasterNotFound, get_master, write_master
from app.persistence.models import StoredIngestionProposal, StoredIngestionRun
from app.schema import MasterProfile
from app.schema.ingest import (
    ApplyResult,
    IngestionProposal,
    IngestionRun,
    IngestionRunBundle,
    IngestRelationship,
    IngestRunStatus,
    IngestSourceType,
    ProposalAction,
    ProposalContent,
    ProposalStatus,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

# A run stuck mid-pipeline (process crash) is demoted to `failed` after this, so the one-open-run
# guard can't wedge the workspace. Comfortably longer than any real extract.
_REAP_AFTER = timedelta(minutes=15)
_OPEN_STATES = (IngestRunStatus.extracting.value, IngestRunStatus.reconciling.value)


class RunNotFound(Exception):
    """No run with this id in this workspace (→ 404). Covers the cross-tenant guess."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(f"no ingestion run {run_id!r} in this workspace")


class ProposalNotFound(Exception):
    """No proposal with this id in this run/workspace (→ 404)."""

    def __init__(self, proposal_id: str) -> None:
        self.proposal_id = proposal_id
        super().__init__(f"no proposal {proposal_id!r} in this run")


class StaleProposal(Exception):
    """A proposal changed between the client's read and its write (→ 409, reload and retry)."""

    def __init__(self, proposal_id: str) -> None:
        self.proposal_id = proposal_id
        super().__init__(f"proposal {proposal_id!r} changed concurrently; reload and retry")


class OpenRunExists(Exception):
    """An unapplied run is already open in this workspace (→ 409). One document at a time."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(f"an ingestion run ({run_id!r}) is already open; finish or discard it")


class StaleMaster(Exception):
    """The master changed since this run was created, so its proposals may no longer fit (→ 409)."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(f"the master changed since run {run_id!r} started; re-import to refresh")


class IneligibleProposal(Exception):
    """A bulk-accept ("Add all new items") submitted a proposal that isn't `net-new` (→ 422). Only
    net-new units are bulk-acceptable; enrich/correction need a deliberate per-item accept. The
    server re-derives eligibility from the STORED (immutable) relationship, so the client's list can
    never widen the gate (invariant 2)."""

    def __init__(self, proposal_id: str) -> None:
        self.proposal_id = proposal_id
        super().__init__(
            f"proposal {proposal_id!r} isn't a new item; accept enrich/correction one at a time"
        )


class RunNotEditable(Exception):
    """The run is no longer open for review (already applied / discarded / failed), so its proposals
    can't be changed (→ 409). Guards the audit trail of what the owner approved."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(f"run {run_id!r} is no longer open for review")


def _to_run(row: StoredIngestionRun) -> IngestionRun:
    return IngestionRun(
        id=row.id,
        source_type=IngestSourceType(row.source_type),
        filename=row.filename,
        status=IngestRunStatus(row.status),
        failure_kind=row.failure_kind,
        failure_reason=row.failure_reason,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_proposal(row: StoredIngestionProposal) -> IngestionProposal:
    # `status`/`version`/`appliedMasterId` are column-authoritative (mutated by guarded updates);
    # the
    # rest of the proposal (content/edited/evidence/…) is the stored payload.
    data = dict(row.payload)
    data["status"] = row.status
    data["version"] = row.version
    data["appliedMasterId"] = row.applied_master_id
    return IngestionProposal.model_validate(data)


async def _run_row(
    session: AsyncSession, workspace_id: str, run_id: str, *, for_update: bool = False
) -> StoredIngestionRun:
    stmt = select(StoredIngestionRun).where(
        StoredIngestionRun.id == run_id, StoredIngestionRun.workspace_id == workspace_id
    )
    if for_update:
        # Serialize the mutating paths (apply, decide) on the run row so a decide can't change a
        # proposal mid-apply (which would make the audit trail disagree with the built master).
        # No-op on SQLite, which has no row-level lock and a single writer anyway.
        stmt = stmt.with_for_update()
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise RunNotFound(run_id)
    return row


async def _proposals_of(
    session: AsyncSession, workspace_id: str, run_id: str
) -> Sequence[StoredIngestionProposal]:
    stmt = (
        select(StoredIngestionProposal)
        .where(
            StoredIngestionProposal.run_id == run_id,
            StoredIngestionProposal.workspace_id == workspace_id,
        )
        .order_by(StoredIngestionProposal.created_at.asc())
    )
    return (await session.execute(stmt)).scalars().all()


async def _require_review_run(
    session: AsyncSession, workspace_id: str, run_id: str
) -> StoredIngestionRun:
    """Load the run (404 if missing/cross-tenant) and require it be open for review — so a proposal
    can't be mutated after the run was applied/discarded/failed (which would corrupt the audit
    trail of what the owner approved), and an empty bulk action on an unknown run is a clean 404.
    Locks the run row so a decide serializes against a concurrent apply."""
    run = await _run_row(session, workspace_id, run_id, for_update=True)
    if run.status != IngestRunStatus.review.value:
        raise RunNotEditable(run_id)
    return run


async def reap_stale(session: AsyncSession, workspace_id: str) -> None:
    """Demote runs stuck `extracting`/`reconciling` past the TTL to `failed`, so a crashed run can't
    permanently block new ingests. `review` runs are waiting for the owner — never reaped."""
    cutoff = datetime.now(UTC) - _REAP_AFTER
    await session.execute(
        update(StoredIngestionRun)
        .where(
            StoredIngestionRun.workspace_id == workspace_id,
            StoredIngestionRun.status.in_(_OPEN_STATES),
            StoredIngestionRun.updated_at < cutoff,
        )
        .values(
            status=IngestRunStatus.failed.value,
            failure_kind="timeout",
            failure_reason="the run stalled (process restart?) and was abandoned",
        )
    )
    await session.commit()


async def create_run(
    session: AsyncSession,
    *,
    workspace_id: str,
    source_type: IngestSourceType,
    doc_text: str,
    master: MasterProfile | None,
    filename: str | None = None,
) -> StoredIngestionRun:
    """Open a run (status `extracting`), recording the master it will be reconciled against. The DB
    partial-unique index enforces one open run per workspace: a concurrent second create trips the
    constraint → `OpenRunExists` (not a 500). Reaps stale runs first so a crashed run doesn't
    wedge. `filename` is the PDF-upload's original name (PR-C) — opaque display metadata only
    (truncated; never used in a path or query), `None` for the paste path."""
    await reap_stale(session, workspace_id)
    row = StoredIngestionRun(
        id=uuid.uuid4().hex,
        workspace_id=workspace_id,
        source_type=source_type.value,
        filename=filename[:255] if filename else None,
        status=IngestRunStatus.extracting.value,
        master_snapshot=master.model_dump(mode="json", by_alias=True) if master else None,
        master_existed=master is not None,
        snapshot_hash=master_hash(master),
        doc_text=doc_text,
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        stmt = select(StoredIngestionRun.id).where(
            StoredIngestionRun.workspace_id == workspace_id,
            StoredIngestionRun.status.in_(
                (
                    IngestRunStatus.extracting.value,
                    IngestRunStatus.reconciling.value,
                    IngestRunStatus.review.value,
                )
            ),
        )
        open_id = (await session.execute(stmt)).scalars().first()
        raise OpenRunExists(open_id or "?") from exc
    return row


async def mark_reconciling(session: AsyncSession, *, workspace_id: str, run_id: str) -> bool:
    """CAS-flip a run `extracting → reconciling` just before the work Reconciler runs (honest
    observability; the reaper already covers `reconciling`). Returns False when the flip matched 0
    rows — the run was discarded/reaped during extraction — so the caller skips the Reconciler/Judge
    rather than burn provider calls on a dead run. Commits the flip (the request session is
    `expire_on_commit=False`)."""
    result = await session.execute(
        update(StoredIngestionRun)
        .where(
            StoredIngestionRun.id == run_id,
            StoredIngestionRun.workspace_id == workspace_id,
            StoredIngestionRun.status == IngestRunStatus.extracting.value,
        )
        .values(status=IngestRunStatus.reconciling.value)
    )
    await session.commit()
    return cast("CursorResult[Any]", result).rowcount > 0


async def save_proposals_and_review(
    session: AsyncSession,
    *,
    workspace_id: str,
    run_id: str,
    proposals: list[IngestionProposal],
) -> IngestionRunBundle:
    """Persist the proposals and flip the run to `review` in one commit — a compare-and-set on the
    OPEN states (`extracting` or `reconciling`: the paste/first-run path stays `extracting`, the
    reconcile path passes through `reconciling`). If discarded/reaped meanwhile (0 rows), drop the
    result rather than resurrect it, and return the run's current state."""
    flip = await session.execute(
        update(StoredIngestionRun)
        .where(
            StoredIngestionRun.id == run_id,
            StoredIngestionRun.workspace_id == workspace_id,
            StoredIngestionRun.status.in_(_OPEN_STATES),
        )
        .values(status=IngestRunStatus.review.value)
    )
    if cast("CursorResult[Any]", flip).rowcount == 0:
        await session.rollback()
        return await get_run_bundle(session, workspace_id, run_id)
    for p in proposals:
        session.add(
            StoredIngestionProposal(
                id=p.proposal_id,
                run_id=run_id,
                workspace_id=workspace_id,
                payload=p.model_dump(by_alias=True),
                status=p.status.value,
                version=p.version,
                applied_master_id=p.applied_master_id,
            )
        )
    await session.commit()
    return await get_run_bundle(session, workspace_id, run_id)


async def mark_failed(
    session: AsyncSession, *, workspace_id: str, run_id: str, kind: str, reason: str
) -> None:
    """Record a pipeline failure (compare-and-set on the open states, so it won't override a
    discard).
    Rolls back any pending work first so the failure write isn't poisoned by the failed
    transaction."""
    await session.rollback()
    await session.execute(
        update(StoredIngestionRun)
        .where(
            StoredIngestionRun.id == run_id,
            StoredIngestionRun.workspace_id == workspace_id,
            StoredIngestionRun.status.in_(_OPEN_STATES),
        )
        .values(status=IngestRunStatus.failed.value, failure_kind=kind, failure_reason=reason[:500])
    )
    await session.commit()


async def get_run_bundle(
    session: AsyncSession, workspace_id: str, run_id: str
) -> IngestionRunBundle:
    """The run + its proposals (reload-safe, deep-linkable). Reaps stale runs first, so landing on a
    crashed run via its deep link surfaces `failed`, not a forever-spinner."""
    await reap_stale(session, workspace_id)
    row = await _run_row(session, workspace_id, run_id)
    proposals = await _proposals_of(session, workspace_id, run_id)
    return IngestionRunBundle(run=_to_run(row), proposals=[_to_proposal(p) for p in proposals])


async def list_runs(session: AsyncSession, workspace_id: str) -> list[IngestionRun]:
    """All runs in the workspace, newest first (the recovery / history surface). Reaps stale
    first."""
    await reap_stale(session, workspace_id)
    stmt = (
        select(StoredIngestionRun)
        .where(StoredIngestionRun.workspace_id == workspace_id)
        .order_by(StoredIngestionRun.created_at.desc())
    )
    return [_to_run(r) for r in (await session.execute(stmt)).scalars().all()]


def _new_status(action: ProposalAction) -> ProposalStatus:
    if action is ProposalAction.accept:
        return ProposalStatus.accepted
    if action is ProposalAction.decline:
        return ProposalStatus.declined
    return ProposalStatus.pending  # `edit` stays pending (staged edit only)


async def act_on_proposal(
    session: AsyncSession,
    *,
    workspace_id: str,
    run_id: str,
    proposal_id: str,
    action: ProposalAction,
    edited: ProposalContent | None,
    base_version: int,
) -> IngestionRunBundle:
    """Accept / decline / edit one proposal under the optimistic lock on its `version`. `edited` (on
    accept or edit) replaces the content; a stale `base_version` is a 409. The run must be open for
    review (else 409) — proposals are frozen once the run is applied/discarded."""
    await _require_review_run(session, workspace_id, run_id)
    stmt = select(StoredIngestionProposal).where(
        StoredIngestionProposal.id == proposal_id,
        StoredIngestionProposal.run_id == run_id,
        StoredIngestionProposal.workspace_id == workspace_id,
    )
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise ProposalNotFound(proposal_id)
    payload = dict(row.payload)
    if edited is not None and action in (ProposalAction.accept, ProposalAction.edit):
        payload["edited"] = edited.model_dump(by_alias=True)
    result = await session.execute(
        update(StoredIngestionProposal)
        .where(
            StoredIngestionProposal.id == proposal_id,
            StoredIngestionProposal.workspace_id == workspace_id,
            StoredIngestionProposal.version == base_version,
        )
        .values(status=_new_status(action).value, version=base_version + 1, payload=payload)
    )
    if cast("CursorResult[Any]", result).rowcount == 0:
        raise StaleProposal(proposal_id)
    await session.commit()
    return await get_run_bundle(session, workspace_id, run_id)


async def bulk_decide(
    session: AsyncSession,
    *,
    workspace_id: str,
    run_id: str,
    items: list[tuple[str, int]],
    action: ProposalAction,
    require_net_new: bool = False,
) -> IngestionRunBundle:
    """Accept/decline many proposals in one transaction. The server re-derives eligibility: each
    update is guarded on `status='pending'` AND the item's `version`, so the client's list can only
    flip proposals that are genuinely still pending (it can't widen the gate — invariant 2). When
    `require_net_new` (the "Add all new items" path), a pre-pass also rejects any submitted proposal
    whose STORED relationship isn't `net-new` (→ `IneligibleProposal`/422) — enrich/correction need
    a deliberate per-item accept; relationship is immutable in the payload, so this can't be widened
    by the client. An unknown id → 404; a stale item → 409; an ineligible item → 422 (nothing
    committed). The run must be open for review (else 409), which also makes an empty-items request
    on an unknown run a clean 404."""
    await _require_review_run(session, workspace_id, run_id)
    rows = {r.id: r for r in await _proposals_of(session, workspace_id, run_id)}
    # Eligibility pre-pass (no writes yet): unknown id → 404; a non-net-new id under require_net_new
    # → 422. Re-derived from STORED relationship so the client's list can't admit an excluded unit.
    for proposal_id, _ in items:
        row = rows.get(proposal_id)
        if row is None:
            raise ProposalNotFound(proposal_id)
        relationship = str(row.payload.get("relationship", IngestRelationship.net_new.value))
        if require_net_new and relationship != IngestRelationship.net_new.value:
            raise IneligibleProposal(proposal_id)
    new_status = _new_status(action).value
    for proposal_id, base_version in items:
        result = await session.execute(
            update(StoredIngestionProposal)
            .where(
                StoredIngestionProposal.id == proposal_id,
                StoredIngestionProposal.workspace_id == workspace_id,
                StoredIngestionProposal.run_id == run_id,
                StoredIngestionProposal.version == base_version,
                StoredIngestionProposal.status == ProposalStatus.pending.value,
            )
            .values(status=new_status, version=base_version + 1)
        )
        if cast("CursorResult[Any]", result).rowcount == 0:
            await session.rollback()
            raise StaleProposal(proposal_id)
    await session.commit()
    return await get_run_bundle(session, workspace_id, run_id)


async def discard_run(session: AsyncSession, workspace_id: str, run_id: str) -> IngestionRun:
    """Owner abandons a run (the escape hatch from a wedged/unwanted run). Terminal runs are
    returned
    unchanged; an open run flips to `discarded`, freeing the workspace for a new ingest."""
    row = await _run_row(session, workspace_id, run_id, for_update=True)
    if row.status in (
        IngestRunStatus.extracting.value,
        IngestRunStatus.reconciling.value,
        IngestRunStatus.review.value,
    ):
        row.status = IngestRunStatus.discarded.value
        await session.commit()
        await session.refresh(row)
    return _to_run(row)


async def apply_run(session: AsyncSession, workspace_id: str, run_id: str) -> ApplyResult:
    """Apply the run's accepted proposals to the master in ONE transaction under the per-workspace
    advisory lock: lock → read current master → staleness check → merge → write master → record
    applied ids → flip run `review → applied` → single commit. Apply is partial (conflicts
    skipped)."""
    await lock_workspace_master(session, workspace_id)
    # Lock the run row so a concurrent decide can't mutate a proposal between our read of the
    # accepted set and the commit (it blocks on the same row, then 409s once we flip to applied).
    row = await _run_row(session, workspace_id, run_id, for_update=True)
    if row.status != IngestRunStatus.review.value:
        raise StaleMaster(run_id)
    try:
        current: MasterProfile | None = await get_master(session, workspace_id)
    except MasterNotFound:
        current = None
    except ValidationError as exc:
        # A live stored master that no longer validates (a non-additive schema change): `get_master`
        # also `model_validate`s. Fail closed to a re-import (409), never a 500 — mirroring the
        # snapshot guard below, so both validation points stay in the re-import lane.
        raise StaleMaster(run_id) from exc
    # Staleness = did the master change since the run was reconciled against it? Re-hash the run's
    # STORED snapshot with the CURRENT serializer instead of trusting the `snapshot_hash` frozen at
    # create, so an additive schema change (a new MasterProfile field defaulting `[]`/None) can't
    # shift the hash of an UNCHANGED master and falsely 409 a run open across the deploy: both sides
    # go through the same `master_hash`, so the new field cancels; `snapshot_hash` is audit-only.
    # (`master_snapshot` and `snapshot_hash` were captured from the same master at create.)
    # A NON-additive schema change (a field removed/renamed) could make a legacy snapshot fail
    # validation (CamelModel is extra="forbid"). Fail closed to a re-import (409) — never a 500 — so
    # this stays in the same "ask the owner to re-import" lane the frozen-hash compare lived in.
    try:
        snapshot = (
            MasterProfile.model_validate(row.master_snapshot)
            if row.master_snapshot is not None
            else None
        )
    except ValidationError as exc:
        raise StaleMaster(run_id) from exc
    if master_hash(current) != master_hash(snapshot):
        raise StaleMaster(run_id)

    proposal_rows = await _proposals_of(session, workspace_id, run_id)
    accepted = [_to_proposal(r) for r in proposal_rows if r.status == ProposalStatus.accepted.value]
    new_master, conflicts, applied_ids = apply_accepted(current, accepted)
    await write_master(session, workspace_id, new_master)

    for r in proposal_rows:
        minted = applied_ids.get(r.id)
        if minted is not None:
            r.applied_master_id = minted
    flip = await session.execute(
        update(StoredIngestionRun)
        .where(
            StoredIngestionRun.id == run_id,
            StoredIngestionRun.workspace_id == workspace_id,
            StoredIngestionRun.status == IngestRunStatus.review.value,
        )
        .values(status=IngestRunStatus.applied.value)
    )
    if cast("CursorResult[Any]", flip).rowcount == 0:
        await session.rollback()
        raise StaleMaster(run_id)
    await session.commit()
    return ApplyResult(applied_count=len(applied_ids), conflicts=conflicts, master=new_master)
