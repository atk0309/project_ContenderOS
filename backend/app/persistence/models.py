"""SQLAlchemy ORM models — **storage only**.

These are NOT wire models: the API schema (the OpenAPI source of truth) lives in `app/schema/`.
What the owner manages in the Admin Menu is persisted here: the encrypted provider API key and the
cached model list + per-tier assignments. Schema is created via `Base.metadata.create_all` on
startup (no Alembic yet — see docs/adr/0006); changes are additive-only.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# JSONB on Postgres, plain JSON elsewhere (sqlite in tests) — one column, both backends.
_JSON_LIST = JSON().with_variant(JSONB, "postgresql")
_JSON_OBJ = JSON().with_variant(JSONB, "postgresql")


def _now() -> datetime:
    """Python-side timestamp (timezone-aware) so the value is populated on the instance at flush —
    no post-commit refresh needed, and it behaves identically on Postgres and SQLite."""
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class ProviderSecret(Base):
    """One row per provider: the encrypted API key (Fernet token) + a masked hint for display."""

    __tablename__ = "provider_secrets"

    provider: Mapped[str] = mapped_column(String(32), primary_key=True)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    last4: Mapped[str] = mapped_column(String(8), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class ProviderModels(Base):
    """One row per provider: the cached available-model ids + the per-tier assignments."""

    __tablename__ = "provider_models"

    provider: Mapped[str] = mapped_column(String(32), primary_key=True)
    available_models: Mapped[list[str]] = mapped_column(_JSON_LIST, nullable=False, default=list)
    tier_strong: Mapped[str | None] = mapped_column(String(128), nullable=True)
    tier_fast: Mapped[str | None] = mapped_column(String(128), nullable=True)
    tier_cheap: Mapped[str | None] = mapped_column(String(128), nullable=True)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class StoredCV(Base):
    """One tailored CV, scoped to a workspace (invariant 8). `master` is snapshotted alongside `cv`
    so the render bundle is self-contained and immutable per CV — the renderer needs both, and there
    is no separate MasterProfile table yet. Both are the camelCase wire JSON; the route validates
    them back into Pydantic on read. `version` mirrors `cv.version` so the two can't drift."""

    __tablename__ = "stored_cvs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    master: Mapped[dict[str, object]] = mapped_column(_JSON_OBJ, nullable=False)
    cv: Mapped[dict[str, object]] = mapped_column(_JSON_OBJ, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class StoredMaster(Base):
    """The workspace owner's canonical master CV (invariant 8). One row per workspace — the
    `workspace_id` is the primary key — because a workspace has exactly one master today. The
    tailoring routes load it server-side so provenance is always grounded in stored truth, never in
    client-supplied JSON (invariant 2). `master` is the camelCase wire JSON, re-validated into a
    `MasterProfile` on read. Created additive-only on startup; no Alembic yet (docs/adr/0006)."""

    __tablename__ = "stored_masters"

    workspace_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    master: Mapped[dict[str, object]] = mapped_column(_JSON_OBJ, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class StoredCvLabel(Base):
    """Dashboard display metadata for a tailored CV — the job it targets. A SEPARATE table (not a
    field on `cv` or a column on `stored_cvs`) so the AI Tailor's provider-enforced `TailoredCV`
    output schema never carries it: the server sets it from the trusted `JobSpec` at create time,
    the model never authors it (invariant 5). One row per CV, workspace-scoped (invariant 8).
    Nullable — a keyless verbatim draft has no job, so it gets no row. New table → `create_all`
    provisions it on startup; no Alembic and no migration of `stored_cvs` (docs/adr/0006)."""

    __tablename__ = "cv_labels"

    cv_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    # Text (unbounded): JobSpec.title/company are unbounded, so a bounded varchar could 500 on
    # Postgres ("value too long"). The display label is truncated in the UI, not the DB.
    job_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    company: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


class StoredCvJobSpec(Base):
    """The `JobSpec` a tailored CV targets — a SEPARATE table (not on `cv` or a column on
    `stored_cvs`) so the Tailor's output schema stays off it and `create_all` provisions it
    additively (no Alembic, no `stored_cvs` migration — docs/adr/0006). One row per CV,
    workspace-scoped (invariant 8), written at create from the **owner's parsed `JobSpec`** (the
    Parser output the create request carries — the same posting the CV was tailored to). The AI
    Review Panel's Gatekeeper + Editor judge "against THIS posting", so they load the full JobSpec
    server-side from here; `cv_labels` keeps only title/company for the dashboard. It is the review
    **target**, not a CV-grounding source: the provenance gate (invariant 2) still grounds content
    in the server-loaded master, so an owner-chosen job never affects what is exportable. A keyless
    draft has no job, so it gets no row, and its review runs only the job-independent agents. It is
    deleted alongside the CV (in `cv_store.delete_cv` and `delete_application`)."""

    __tablename__ = "cv_job_specs"

    cv_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    job_spec: Mapped[dict[str, object]] = mapped_column(_JSON_OBJ, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


class StoredIngestionRun(Base):
    """One CV/LinkedIn ingestion of one document, scoped to a workspace (invariant 8).
    `master_snapshot` captures the master the run was reconciled against; `apply` re-hashes it with
    the CURRENT serializer and refuses (409) if the live master changed since (staleness).
    Re-hashing the snapshot (not a hash frozen at create) keeps an additive schema change from
    falsely staling a run open across a deploy (see `ingest_store.apply_run`). `snapshot_hash` +
    `master_existed` are a DELIBERATE audit trail (kept, not read at runtime): they record what the
    run saw at create time, for prod debugging of staleness disputes — dropping them would need a
    manual prod migration for zero operational win. `doc_text` is the evidence / re-judge source.
    New table -> `create_all`; no Alembic (docs/adr/0006)."""

    __tablename__ = "ingestion_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    filename: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    failure_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    master_snapshot: Mapped[dict[str, object] | None] = mapped_column(_JSON_OBJ, nullable=True)
    master_existed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    snapshot_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    doc_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


# At most ONE open run per workspace (the atomic one-open-run guard). A partial-unique index so the
# constraint covers only non-terminal runs; declared for BOTH dialects (`postgresql_where` +
# `sqlite_where`) so the SQLite gate actually exercises the guard. The cross-process race is a
# Postgres-only guarantee, but the rule itself is testable offline.
_OPEN_RUN_STATES = "('extracting','reconciling','review')"
Index(
    "uq_ingestion_open_run_per_workspace",
    StoredIngestionRun.workspace_id,
    unique=True,
    postgresql_where=text(f"status IN {_OPEN_RUN_STATES}"),
    sqlite_where=text(f"status IN {_OPEN_RUN_STATES}"),
)


class StoredIngestionProposal(Base):
    """One reviewable proposal in a run, scoped to (workspace, run). `payload` is the camelCase wire
    `IngestionProposal` JSON (content / edited / evidence / unitKind / summary); `status` and
    `version` are promoted to columns so accept/decline/edit can use a cheap optimistic-lock UPDATE
    (mirrors `cv_store._guarded_save`); `applied_master_id` records the minted master id once
    applied. New table → `create_all`; no Alembic (docs/adr/0006)."""

    __tablename__ = "ingestion_proposals"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    payload: Mapped[dict[str, object]] = mapped_column(_JSON_OBJ, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    applied_master_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class StoredApplication(Base):
    """One tracked job application, scoped to a workspace (invariant 8). It references — and locks —
    the `StoredCV` it was sent with: a CV is "applied/locked" iff a row here points at it, so
    immutability needs no column on `stored_cvs` (which `create_all` couldn't add to the deployed
    table anyway — ADR 0006/0009). `application` is the camelCase wire `Application` JSON (job
    metadata + stage + events), re-validated into Pydantic on read; the whole blob is reassigned on
    a stage update (JSON columns don't track deep mutation). The unique `(workspace_id, cv_id)`
    constraint makes the lock 1:1 — a CV is applied to exactly one job — and is the atomic backstop
    for a concurrent double-apply. New table → `create_all` provisions it; no Alembic (adr 0006)."""

    __tablename__ = "stored_applications"
    __table_args__ = (UniqueConstraint("workspace_id", "cv_id", name="uq_application_per_cv"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    cv_id: Mapped[str] = mapped_column(String(64), nullable=False)
    application: Mapped[dict[str, object]] = mapped_column(_JSON_OBJ, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class StoredCvReview(Base):
    """The latest AI review run for one CV — a **latest-run-only snapshot**, one row per CV (`cv_id`
    is the PK), scoped to a workspace (invariant 8). Reviews were transient by design (ADR
    0010/0011: SSE-only, never persisted); the owner reversed that, so a review run + the owner's
    per-finding decisions now survive navigation — the superseding decision is ADR 0013.

    Explicitly DECOUPLED from history: there is **no** run-history table, no `gkList`, and no
    durable Diff (the Diff stays client-derived + transient). `bundle` is the camelCase wire
    `ReviewBundle` exactly as reviewed; `cv_version` promotes `bundle.cvVersion` to a column so a
    decisions PUT can 409 on a version mismatch without decoding the blob. `reviewed_text` maps
    `bulletId -> text` at review time (server-derived), so the client can show which text each
    finding judged even after an edit. `decisions` maps an **opaque** client `threadKey ->
    "accepted"|"rejected"` (last-write-wins, invariant 7), reset to `{}` on every re-run. The row
    is deleted alongside the CV (`cv_store.delete_cv`, `application_store.delete_application`).
    At **apply** it is RESOLVED in place, not deleted (ADR 0014) — `apply_corrections` records the
    applied bullets in `bundle.resolvedAnchorIds` and keeps the row (at its `cv_version`) so the
    candidate's other, un-applied review notes survive. New table → `create_all` provisions it
    additively; no Alembic (docs/adr/0006). Mirrors the `cv_job_specs` satellite-table precedent."""

    __tablename__ = "cv_reviews"

    cv_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    cv_version: Mapped[int] = mapped_column(Integer, nullable=False)
    bundle: Mapped[dict[str, object]] = mapped_column(_JSON_OBJ, nullable=False)
    reviewed_text: Mapped[dict[str, object]] = mapped_column(
        _JSON_OBJ, nullable=False, default=dict
    )
    decisions: Mapped[dict[str, object]] = mapped_column(_JSON_OBJ, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )
