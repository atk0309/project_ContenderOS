"""Wire models for CV / LinkedIn ingestion → the master profile.

The owner pastes (PR-B1) or uploads (PR-C) a document; the **Extractor** (Claude) returns an
id-less `ExtractedProfile`; the server turns each unit into an `IngestionProposal` (PR-B1: all
net-new); the owner accepts / declines / edits each inline; **apply** merges the accepted set into
the stored master (server mints ids, validates, writes under the per-workspace advisory lock).

The owner's accept is the ingestion analogue of the invariant-2 sign-off gate: the server — not the
model or client — decides what enters the master. So proposals persist server-side and `apply` works
by stored `proposalId`, never a client-supplied master blob.

Note: the per-kind proposed content uses **optional typed sub-fields** (`field`/`work`/…), not a
discriminated union — the Extractor's structured output and these views stay simple Pydantic, which
both providers' structured-output APIs and the OpenAPI→TS codegen handle cleanly. The reconciliation
envelope (`relationship` / `targetWorkId` / `targetLabel` / `currentValue` / `decision`) is
server-owned metadata layered on top of this shape — never a model output, so its optional fields
are free of the structured-output grammar budget (PR-E).
"""

from __future__ import annotations

from enum import StrEnum

from app.schema.common import CamelModel, UtcDateTime
from app.schema.master import MasterProfile


class IngestSourceType(StrEnum):
    """Where the ingested document came from (display + future per-source handling)."""

    pasted = "pasted"
    linkedin_pdf = "linkedin-pdf"
    cv_pdf = "cv-pdf"
    other = "other"


class IngestRunStatus(StrEnum):
    """Lifecycle of one ingestion run. `extracting`/`reconciling` are the non-terminal (open) states
    the one-open-run guard and the reaper key on; `review` is ready for the owner;
    `applied`/`failed`/`discarded` are terminal."""

    extracting = "extracting"
    reconciling = (
        "reconciling"  # PR-E: the Reconciler is matching extracted units against the master
    )
    review = "review"
    applied = "applied"
    failed = "failed"
    discarded = "discarded"


class IngestUnitKind(StrEnum):
    """What a proposal would add to the master. `highlight` enriches an existing work entry with one
    new bullet (PR-E); the rest build a whole unit net-new (PR-B1), and a `basics-field` may instead
    be a `correction` of an already-set field (carried by `relationship`, PR-E). `certificate` is
    LEGACY: no new certificate proposals are built (DevPR31), but persisted pre-DevPR31 runs still
    carry them, and review/apply must keep honouring those."""

    basics_field = "basics-field"
    work = "work"
    education = "education"
    skill = "skill"
    certificate = "certificate"  # legacy — pre-DevPR31 persisted proposals only
    profile = "profile"
    language = "language"
    highlight = "highlight"


class ProposalStatus(StrEnum):
    pending = "pending"
    accepted = "accepted"
    declined = "declined"


class ProposalAction(StrEnum):
    accept = "accept"
    decline = "decline"
    edit = "edit"


class IngestRelationship(StrEnum):
    """How a proposal relates to the CURRENT master — **server-derived after re-grounding, never a
    model output**. `net_new` adds a unit the master lacks; `enrich` appends a new highlight to an
    existing work entry (`targetWorkId`); `correction` overwrites an already-set basics field
    (`currentValue` shows what it replaces). Only `net_new` is bulk-acceptable — enrich/correction
    need a deliberate per-item accept (invariant 2)."""

    net_new = "net-new"
    enrich = "enrich"
    correction = "correction"


class IngestVerdict(StrEnum):
    """The Judge's advisory recommendation per proposal (OpenAI adjudication — PR-E E2). Advisory
    ONLY: it never gates apply nor widens the bulk gate. An omitted/unknown proposalId, or a Judge
    outage, maps to `needs_review`."""

    include = "include"
    exclude = "exclude"
    needs_review = "needs-review"


class Evidence(CamelModel):
    """The verbatim source span supporting a proposal, so the owner can trust what enters the
    master. `verified` is True when the server confirmed the snippet appears in the source
    document (best-effort substring check); a non-verbatim snippet is flagged, never gates apply."""

    snippet: str
    verified: bool = False


# --- Extractor output (id-less; the model never mints master ids) ------------------------------


class ExtractedProfileLink(CamelModel):
    network: str
    url: str


class ExtractedBasics(CamelModel):
    """Identity fields the document states. All optional — a LinkedIn export or old CV rarely
    has every field; the server proposes what's present and gates a first-run build on
    completeness."""

    name: str | None = None
    label: str | None = None
    email: str | None = None
    phone: str | None = None
    url: str | None = None
    summary: str | None = None
    city: str | None = None
    region: str | None = None
    country_code: str | None = None
    profiles: list[ExtractedProfileLink] = []
    evidence: str = ""


class ExtractedWork(CamelModel):
    company: str
    position: str
    start_date: str
    end_date: str | None = None
    highlights: list[str] = []
    tags: list[str] = []
    evidence: str = ""


class ExtractedEducation(CamelModel):
    institution: str
    area: str
    study_type: str
    start_date: str
    end_date: str | None = None
    evidence: str = ""


class ExtractedSkill(CamelModel):
    name: str
    level: str | None = None
    keywords: list[str] = []
    evidence: str = ""


class ExtractedCertificate(CamelModel):
    """LEGACY (DevPR31): ingestion no longer extracts or proposes certificates — none of the four
    render outputs nor the master editor shows them, so accepting one sent data into a black hole.
    The shape stays because persisted pre-DevPR31 proposals carry it (`ProposalContent.certificate`)
    and open runs in prod must still render/apply."""

    name: str
    issuer: str
    date: str
    evidence: str = ""


class ExtractedLanguage(CamelModel):
    """A spoken/written language the document states, with fluency when given. Small +
    low-optionality (one optional scalar) so folding it into the qualifications Extractor call
    doesn't blow the structured-output grammar budget (see agents/extractor.py)."""

    language: str
    fluency: str | None = None
    evidence: str = ""


class ExtractedProfile(CamelModel):
    """The Extractor's whole structured reading of one document — only what it literally states.
    No `certificates`: ingestion stopped proposing them (DevPR31; nothing renders or edits them)."""

    basics: ExtractedBasics = ExtractedBasics()
    work: list[ExtractedWork] = []
    education: list[ExtractedEducation] = []
    skills: list[ExtractedSkill] = []
    languages: list[ExtractedLanguage] = []


# --- Proposal content (server-built; exactly one sub-field set, per `unitKind`) -----------------


class ProposedField(CamelModel):
    """A single basics/identity field. `fieldPath` is a wire path validated server-side against a
    typed allowlist (e.g. `basics.name`, `basics.location.countryCode`); `value` is the proposed
    text."""

    field_path: str
    value: str


class ProposedHighlight(CamelModel):
    """The proposed new bullet for an `enrich` proposal — text only. The target work entry is the
    server-owned `targetWorkId`/`targetLabel` on the proposal envelope, so an owner edits the bullet
    text but can never re-point the merge to a different role (invariant 2)."""

    text: str


class ProposalDecision(CamelModel):
    """The Judge's advisory verdict carried on a proposal (PR-E E2) — server-built from the Judge's
    structured output, never client-set. Advisory only (invariant 6)."""

    verdict: IngestVerdict
    reason: str = ""


class ProposalContent(CamelModel):
    """The proposed master fragment. Exactly one sub-field is set, matching `unitKind` (enforced
    server-side): `field` for a basics-field add or correction, `highlight` for an enrich, and
    work/education/skill/cert reuse the id-less Extracted shapes for a whole net-new unit."""

    field: ProposedField | None = None
    work: ExtractedWork | None = None
    education: ExtractedEducation | None = None
    skill: ExtractedSkill | None = None
    certificate: ExtractedCertificate | None = None
    profile: ExtractedProfileLink | None = None
    language: ExtractedLanguage | None = None
    highlight: ProposedHighlight | None = None


class IngestionProposal(CamelModel):
    """One reviewable change, anchored to a stable server-minted `proposalId` (invariant 7).

    `version` is the optimistic-lock token a decide call echoes as `baseVersion`. `appliedMasterId`
    records the master id minted when an accepted proposal was applied. The reconciliation envelope
    (`relationship` / `targetWorkId` / `targetLabel` / `currentValue` / `decision`) is
    **server-owned and immutable** — `edited` carries only owner content edits, so an owner can
    never re-target an enrich or correction (invariant 2). All five default, so pre-PR-E stored
    payloads load unchanged."""

    proposal_id: str
    unit_kind: IngestUnitKind
    summary: str
    content: ProposalContent
    edited: ProposalContent | None = None
    evidence: Evidence
    status: ProposalStatus
    version: int
    applied_master_id: str | None = None
    relationship: IngestRelationship = IngestRelationship.net_new
    target_work_id: str | None = None
    target_label: str | None = None
    current_value: str | None = None
    decision: ProposalDecision | None = None


class IngestionRun(CamelModel):
    """One ingestion of one document. `failureKind`/`failureReason` are set when a run ends
    `failed`, so a recovered/listed run is self-describing (refusal vs truncation vs down)."""

    id: str
    source_type: IngestSourceType
    filename: str | None = None
    status: IngestRunStatus
    failure_kind: str | None = None
    failure_reason: str | None = None
    created_at: UtcDateTime
    updated_at: UtcDateTime


class IngestionRunBundle(CamelModel):
    """The reload-safe, deep-linkable read backing `/ingest?run=<id>`: the run + its proposals."""

    run: IngestionRun
    proposals: list[IngestionProposal] = []


# --- Requests / results ------------------------------------------------------------------------


class PasteIngestRequest(CamelModel):
    """Body for `POST /workspaces/{id}/ingest` (PR-B1, text path): the pasted CV / LinkedIn text."""

    text: str
    source_type: IngestSourceType = IngestSourceType.pasted


class DecideProposalRequest(CamelModel):
    """Accept / decline / edit one proposal. `edited` (a replacement `ProposalContent`) is honoured
    on `accept` and `edit`; `baseVersion` is the proposal version the client was viewing — a stale
    write is a 409 (optimistic lock), so a stale tab can't admit content it never saw."""

    action: ProposalAction
    edited: ProposalContent | None = None
    base_version: int


class BulkDecideItem(CamelModel):
    proposal_id: str
    base_version: int


class BulkDecideRequest(CamelModel):
    """Bulk accept/decline. Per-item `baseVersion` keeps the single path's optimistic-lock guarantee
    (stale items → reported, not silently clobbered). The server re-derives which proposals are
    eligible from stored state — the client's list never widens the gate (invariant 2)."""

    items: list[BulkDecideItem]
    action: ProposalAction


class ApplyConflict(CamelModel):
    """A proposal `apply` skipped (e.g. a stale enrich target in PR-E, or a malformed unit) so the
    rest of the accepted set still lands — apply is partial, never all-or-nothing."""

    proposal_id: str
    reason: str


class ApplyResult(CamelModel):
    """Result of applying the accepted proposals: how many landed, what was skipped, and the master
    as persisted."""

    applied_count: int
    conflicts: list[ApplyConflict] = []
    master: MasterProfile
