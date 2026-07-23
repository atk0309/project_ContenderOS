"""Agent critique outputs. Every thread anchors to a stable id (`anchorId`), never a doc offset.

Provider split (invariant 6): Editor / Fact-Checker / Gatekeeper run on OpenAI (adjudication);
the AI-Language Spotter's model pass runs on Claude. See docs/ai-panel.md.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import ConfigDict, Field, field_validator

from app.schema.common import (
    AnchorKind,
    CamelModel,
    Decision,
    FactVerdict,
    Severity,
    SlopFlag,
    UtcDateTime,
)


class Thread(CamelModel):
    """A single anchored critique. `anchorId` is a bulletId / itemId / sectionId."""

    anchor_id: str
    anchor_kind: AnchorKind = AnchorKind.bullet
    severity: Severity
    comment: str
    suggested_revision: str | None = None


class EditorReport(CamelModel):
    """Editor agent (OpenAI) — line-edit critique. Critique only, never rewrites."""

    overall: str
    threads: list[Thread] = []


class FactCheckThread(Thread):
    claim: str
    verdict: FactVerdict
    source_id: str | None  # the master bullet this claim traces to, or None if unsupported


class FactCheckReport(CamelModel):
    """Fact-Checker (OpenAI) — every claim must trace to a master bullet."""

    threads: list[FactCheckThread] = []


class SlopThread(Thread):
    flag: SlopFlag


class SlopReport(CamelModel):
    """AI-Language Spotter (Claude) — model pass that pairs with the deterministic heuristics."""

    threads: list[SlopThread] = []


class GatekeeperVerdict(CamelModel):
    """Gatekeeper (OpenAI) — simulates the recruiter / ATS first-pass screen for THIS posting."""

    decision: Decision
    ats_match_score: int  # 0-100; range is enforced server-side after parse, not by the model
    missing_keywords: list[str] = []
    unmet_must_haves: list[str] = []
    recruiter_notes: str  # what a human screener thinks in ~20 seconds, blunt
    threads: list[Thread] = []  # anchored fixes that would flip the verdict


class AgentFailure(CamelModel):
    """One adjudicator that RAN and degraded (provider refusal / truncation / parse-fail / API
    error). Distinct from a null report field, which means the agent didn't apply (e.g. a no-job
    draft has no posting → `gatekeeper`/`editor` are null, with no failure). Surfacing the failure
    explicitly is invariant 5 ("surface refusal/truncation/parse-fail loudly") on the blocking arm,
    which has no SSE `AgentDone(ok=false)` to carry it."""

    agent_id: str
    detail: str  # error category: refusal / truncation / parse-fail / provider-error


class ReviewBundle(CamelModel):
    """The aggregate review result for one CV — each of the four advisory reports, optional. A null
    report means that agent didn't apply (N/A for this CV, e.g. a keyless / no-job draft has no
    posting so `gatekeeper`/`editor` stay null); an agent that ran and degraded is listed in
    `failures` instead. Nothing here gates export; only the sign-off gate does.

    `cvVersion` is the EXACT version of the CV the server reviewed (the row it loaded), so the
    client can tell whether the review still matches the CV on screen: a save since the review
    (or a concurrent edit in another tab) bumps the version, and the mismatch marks the review
    version-drifted — a presentation signal only (ADR 0016): its surfaces stay visible,
    stale-marked, never hidden."""

    cv_version: int
    editor: EditorReport | None = None
    fact_check: FactCheckReport | None = None
    gatekeeper: GatekeeperVerdict | None = None
    slop: SlopReport | None = None
    failures: list[AgentFailure] = []  # agents that ran and FAILED (vs a null field = didn't apply)
    resolved_anchor_ids: list[str] = []
    """Bullet ids the candidate has APPLIED a correction to (ADR 0014). SERVER-controlled — set on
    `apply_corrections` (`resolve_threads`), NEVER by a model: it is NOT on `Thread` (the
    adjudicator output schema), so no fan-out agent can author it. A fresh run assembles it empty,
    so applied chips clear on re-run. The client renders any thread on one of these bullets as a
    resolved "✓" chip (not actionable) while its OTHER, un-applied notes stay live. Whole-bullet
    granularity: an apply rewrites the bullet's text, so every note on it is superseded (per-thread
    resolve is deferred)."""


class AcceptedThread(Thread):
    """An accepted review thread the owner echoes back to `/apply`. Reviews are now persisted (ADR
    0013), but `/apply` still takes the client's accepted-thread echo — the server re-grounds them
    against stored truth (invariant 2), so resolving accepted threads from the stored review row is
    optional hardening, out of scope. The surface emits `Thread` SUBCLASSES with extra fields
    (`SlopThread.flag`, `FactCheckThread.claim`/`verdict`/`sourceId`) plus the frontend's
    `key`/`source`; `CamelModel` is `extra="forbid"`, so a verbatim echo would 422 at the boundary.
    This **ignores** the report-only / UI-only extras, keeping just the anchor + `suggestedRevision`
    the Corrector needs — and stays a `Thread`, so `ground_thread_anchors` accepts it."""

    model_config = ConfigDict(**{**Thread.model_config, "extra": "ignore"})


class ApplyFeedbackRequest(CamelModel):
    """Body for `POST /workspaces/{id}/cv/{cvId}/apply` — the accepted **bullet**-anchored threads
    to apply as Corrector rewrites. (Named `ApplyFeedbackRequest`; `ApplyRequest` is the tracker's
    job-application action.) `baseVersion` is the CV version the client was viewing — the (billed)
    correction is rejected 409 if the stored CV changed since, like the edit/review/export guard."""

    threads: list[AcceptedThread] = []
    base_version: int = Field(ge=1)


class ThreadDecision(StrEnum):
    """The owner's verdict on one review finding (ADR 0013). Lives here, NOT in `common.py`, so it
    doesn't collide with the Gatekeeper's `Decision` (`pass`/`borderline`/`reject`)."""

    accepted = "accepted"
    rejected = "rejected"


# Bounds for the persisted decisions snapshot (a server-side DoS guard, not a real-key constraint):
# anchor/thread keys are unbounded strings (`schema/tailored.py`), uuid-hex in practice.
MAX_REVIEW_DECISIONS = 512
MAX_DECISION_KEY_LEN = 512


class SavedReview(CamelModel):
    """The persisted latest review run for one CV (ADR 0013) — what `GET .../cv/{id}/review` returns
    when a run is stored (200-null when none is). `bundle` is the exact `ReviewBundle` that was
    reviewed; `reviewedText` maps `bulletId -> text` at review time (server-derived); `decisions`
    maps an opaque client `threadKey -> accepted|rejected` (last-write-wins, invariant 7).
    `updatedAt` is the stored-row time."""

    cv_id: str
    bundle: ReviewBundle
    reviewed_text: dict[str, str]
    decisions: dict[str, ThreadDecision]
    updated_at: UtcDateTime


class ReviewDecisionsRequest(CamelModel):
    """Body for `PUT .../cv/{id}/review/decisions` — the client's WHOLE per-finding decisions
    snapshot (last-write-wins, invariant 7) plus the `cvVersion` it was viewing. The server rejects
    a mismatch against the stored review's version with **409** (the review was re-run since).
    Bounded (→ **422**): at most 512 entries, each key at most 512 chars."""

    decisions: dict[str, ThreadDecision]
    cv_version: int

    @field_validator("decisions")
    @classmethod
    def _bound_decisions(cls, value: dict[str, ThreadDecision]) -> dict[str, ThreadDecision]:
        if len(value) > MAX_REVIEW_DECISIONS:
            raise ValueError(f"at most {MAX_REVIEW_DECISIONS} decisions")
        for key in value:
            if len(key) > MAX_DECISION_KEY_LEN:
                raise ValueError(f"decision key exceeds {MAX_DECISION_KEY_LEN} characters")
        return value
