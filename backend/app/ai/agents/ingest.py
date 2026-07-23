"""run_ingest orchestration — the single gated path from a document to reviewable proposals.

PR-B1 was **Extractor-only**: extract → turn every extracted unit into a *net-new*
`IngestionProposal` (server-minted `proposalId`, `pending`). PR-E adds reconciliation against an
existing master: `run_ingest` runs the Extractor, then (when a master exists) the work
**Reconciler** (Claude) to match extracted roles to master entries, then builds proposals
server-side — net-new units, `enrich` highlights for matched roles, and `correction`s for changed
basics. The model only classifies work matches by index; the server re-grounds every target and
diffs highlights, so no model re-emits the candidate's real CV text (invariant 2). The advisory
Judge (OpenAI) is layered on in E2.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable

from pydantic import BaseModel

from app.ai.agents.extractor import (
    ExtractedWorkList,
    RawBasics,
    basics_extractor,
    qualifications_extractor,
    work_extractor,
)
from app.ai.agents.judge import JudgeContext, judge
from app.ai.agents.reconciler import (
    ReconcileWorkContext,
    WorkReconciliation,
    work_reconciler,
)
from app.ai.agents.registry import ModelResolver, run_agent
from app.ai.agents.types import Agent
from app.ai.providers.base import Document, ProviderRunner
from app.schema.ingest import (
    Evidence,
    ExtractedBasics,
    ExtractedEducation,
    ExtractedLanguage,
    ExtractedProfile,
    ExtractedProfileLink,
    ExtractedSkill,
    ExtractedWork,
    IngestionProposal,
    IngestRelationship,
    IngestUnitKind,
    IngestVerdict,
    ProposalContent,
    ProposalDecision,
    ProposalStatus,
    ProposedField,
    ProposedHighlight,
)
from app.schema.master import MasterProfile
from app.schema.sse import AgentDone, AgentProgress, AgentStarted, SseEvent

log = logging.getLogger("contender.ingest")

# The visible marker set on a proposal's verdict when the advisory Judge can't be reached, so the UI
# can show one quiet "suggestions unavailable" line instead of a wall of needs-review warnings.
JUDGE_UNAVAILABLE = "suggestions unavailable"

# The Extractor's text prompt when the CV travels as a native PDF document block (PR-C): the PDF IS
# the input, so the prompt is a neutral placeholder. The pypdf `doc_text` is evidence/fallback ONLY
# (ADR 0007) — putting it in the prompt beside the PDF would give the model two rival readings (a
# garbled multi-column pypdf extraction vs the clean native PDF).
NATIVE_PDF_INPUT = "(the candidate's CV is the attached PDF)"

# Streaming-progress sink: the ingest SSE route passes one to surface per-agent start / progress /
# done events as the pipeline runs. None (default) keeps the blocking JSON path byte-for-byte.
ProgressEmit = Callable[[SseEvent], Awaitable[None]]


async def _traced[TCtx, TOut: BaseModel](
    agent: Agent[TCtx, TOut],
    ctx: TCtx,
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
    document: Document | None = None,
    progress: ProgressEmit | None = None,
    note: Callable[[TOut], str] | None = None,
) -> TOut:
    """Run one agent through `run_agent`, emitting `AgentStarted` then a terminal `AgentDone` (ok on
    success, `ok=False` + `detail=<error>` on failure, before re-raising) when a `progress` sink is
    attached (the streaming path). Every started agent then has a terminal event (the client keys
    its checklist by `agentId` and can name a failed one). `note` (DevPR33) builds an owner-facing
    `AgentProgress` status sentence from the leg's output, emitted BETWEEN the call and the success
    `AgentDone` — so `AgentDone` stays each agent's terminal event and a note can never precede the
    run's first `AgentStarted` (the Stop escape hatch gates on a non-empty checklist). The native
    PDF→text fallback re-runs the sections, so a retried section emits a second started/done pair —
    last-event-wins by `agentId` collapses it (a rare PDF-only path). `progress=None` (the JSON
    path) is unchanged."""
    if progress is not None:
        await progress(AgentStarted(agent_id=agent.id))
    try:
        out = await run_agent(agent, ctx, runner=runner, resolve=resolve, document=document)
    except Exception as exc:
        if progress is not None:
            await progress(AgentDone(agent_id=agent.id, ok=False, detail=type(exc).__name__))
        raise
    if progress is not None:
        if note is not None:
            await progress(AgentProgress(agent_id=agent.id, note=note(out)))
        await progress(AgentDone(agent_id=agent.id, ok=True))
    return out


def _work_found_note(work_list: ExtractedWorkList) -> str:
    """Owner-facing summary of the work pass (renders verbatim in the aria-live status line)."""
    n = len(work_list.work)
    if n == 0:
        return "No work roles found in this document"
    return f"Found {'1 role' if n == 1 else f'{n} roles'} in your work history"


def _to_basics(raw: RawBasics) -> ExtractedBasics:
    """Map the no-optional `RawBasics` (empty/whitespace string = absent) onto the wire
    `ExtractedBasics`."""

    def opt(v: str) -> str | None:
        # Strip, so a model-emitted " " / "\t" reads as absent like "" — a whitespace value must not
        # survive as an invisible basics proposal that satisfies a required MasterProfile field and
        # slips past the first-run identity gate (invariant 2).
        s = v.strip()
        return s or None

    return ExtractedBasics(
        name=opt(raw.name),
        label=opt(raw.label),
        email=opt(raw.email),
        phone=opt(raw.phone),
        url=opt(raw.url),
        summary=opt(raw.summary),
        city=opt(raw.city),
        region=opt(raw.region),
        country_code=opt(raw.country_code),
        profiles=raw.profiles,
        evidence=raw.evidence,
    )


async def run_extract(
    text: str,
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
    document: Document | None = None,
    progress: ProgressEmit | None = None,
) -> ExtractedProfile:
    """Extract one document into an `ExtractedProfile` via THREE section-scoped structured-output
    calls (basics / work / qualifications), merged here. They run sequentially, not concurrently:
    `run_agent` resolves the model and builds the provider client through the request-scoped
    `AsyncSession`, which is not concurrency-safe — `asyncio.gather` would 500 in prod while passing
    the DB-less test fake. The single full `ExtractedProfile` schema is rejected by the API as too
    complex (ADR 0007). `text` is the user prompt fed to every section call: the pasted source on
    the text path, or — when the CV travels as a native PDF `document` block (PR-C) — a NEUTRAL
    placeholder (`NATIVE_PDF_INPUT`), because the PDF itself is the input and the pypdf text is
    evidence/fallback only (ADR 0007), never prompt input beside the PDF. A sub-call
    refusal/truncation/parse error propagates immediately to the caller's mark-failed path
    (invariant 5)."""
    raw_basics = await _traced(
        basics_extractor,
        text,
        runner=runner,
        resolve=resolve,
        document=document,
        progress=progress,
        note=lambda _out: "Contact details captured",
    )
    work_list = await _traced(
        work_extractor,
        text,
        runner=runner,
        resolve=resolve,
        document=document,
        progress=progress,
        note=_work_found_note,
    )
    quals = await _traced(
        qualifications_extractor,
        text,
        runner=runner,
        resolve=resolve,
        document=document,
        progress=progress,
        note=lambda _out: "Education, skills & languages captured",
    )
    return ExtractedProfile(
        basics=_to_basics(raw_basics),
        work=work_list.work,
        education=quals.education,
        skills=quals.skills,
        languages=quals.languages,
    )


def _norm(value: str) -> str:
    return " ".join(value.split()).casefold()


def _evidence(snippet: str, doc_text: str) -> Evidence:
    """Best-effort verbatim check: a snippet that appears (whitespace/case-normalised) in the source
    is `verified`; otherwise it's shown but flagged, never blocking apply."""
    verified = bool(snippet.strip()) and _norm(snippet) in _norm(doc_text)
    return Evidence(snippet=snippet, verified=verified)


# (extracted attribute, wire fieldPath, display label)
_BASICS_FIELDS: list[tuple[str, str, str]] = [
    ("name", "basics.name", "Name"),
    ("label", "basics.label", "Headline"),
    ("email", "basics.email", "Email"),
    ("phone", "basics.phone", "Phone"),
    ("url", "basics.url", "Website"),
    ("summary", "basics.summary", "Summary"),
    ("city", "basics.location.city", "City"),
    ("region", "basics.location.region", "Region"),
    ("country_code", "basics.location.countryCode", "Country"),
]


def _proposal(
    kind: IngestUnitKind,
    summary: str,
    content: ProposalContent,
    evidence: Evidence,
    *,
    relationship: IngestRelationship = IngestRelationship.net_new,
    target_work_id: str | None = None,
    target_label: str | None = None,
    current_value: str | None = None,
) -> IngestionProposal:
    return IngestionProposal(
        proposal_id=uuid.uuid4().hex,
        unit_kind=kind,
        summary=summary,
        content=content,
        edited=None,
        evidence=evidence,
        status=ProposalStatus.pending,
        version=1,
        applied_master_id=None,
        relationship=relationship,
        target_work_id=target_work_id,
        target_label=target_label,
        current_value=current_value,
    )


# --- per-unit proposal builders (shared by the net-new and reconciled paths) --------------------


def _work_proposal(w: ExtractedWork, doc_text: str) -> IngestionProposal:
    return _proposal(
        IngestUnitKind.work,
        f"{w.company} · {w.position}",
        ProposalContent(work=w),
        _evidence(w.evidence, doc_text),
    )


def _education_proposal(e: ExtractedEducation, doc_text: str) -> IngestionProposal:
    return _proposal(
        IngestUnitKind.education,
        f"{e.study_type} {e.area} · {e.institution}".strip(),
        ProposalContent(education=e),
        _evidence(e.evidence, doc_text),
    )


def _skill_proposal(s: ExtractedSkill, doc_text: str) -> IngestionProposal:
    return _proposal(
        IngestUnitKind.skill,
        f"Skill: {s.name}",
        ProposalContent(skill=s),
        _evidence(s.evidence, doc_text),
    )


def _language_proposal(lang: ExtractedLanguage, doc_text: str) -> IngestionProposal:
    return _proposal(
        IngestUnitKind.language,
        f"Language: {lang.language}",
        ProposalContent(language=lang),
        _evidence(lang.evidence, doc_text),
    )


def _profile_proposal(pl: ExtractedProfileLink, doc_text: str) -> IngestionProposal:
    return _proposal(
        IngestUnitKind.profile,
        f"Profile: {pl.network}",
        ProposalContent(profile=pl),
        _evidence(pl.url, doc_text),
    )


def _quals_proposals(extracted: ExtractedProfile, doc_text: str) -> list[IngestionProposal]:
    """Education / skills / languages / profile links — always net-new here; apply-time dedup
    (skills by name, languages by name, profiles by url, edu by institution/area/type) keeps a
    re-import from duplicating them. No certificate proposals since DevPR31 (nothing renders or
    edits them) — the apply-time certificate merge stays for persisted pre-DevPR31 runs. Profile
    links live under `basics.profiles` but reconcile like the other list units, so they ride here
    rather than with the basics fields."""
    return (
        [_education_proposal(e, doc_text) for e in extracted.education]
        + [_skill_proposal(s, doc_text) for s in extracted.skills]
        + [_language_proposal(lang, doc_text) for lang in extracted.languages]
        + [_profile_proposal(pl, doc_text) for pl in extracted.basics.profiles]
    )


def _basics_field_proposal(
    path: str,
    label: str,
    value: str,
    evidence_snippet: str,
    doc_text: str,
    *,
    relationship: IngestRelationship = IngestRelationship.net_new,
    current_value: str | None = None,
) -> IngestionProposal:
    return _proposal(
        IngestUnitKind.basics_field,
        f"{label}: {value}",
        ProposalContent(field=ProposedField(field_path=path, value=value)),
        _evidence(evidence_snippet, doc_text),
        relationship=relationship,
        current_value=current_value,
    )


def build_net_new_proposals(extracted: ExtractedProfile, doc_text: str) -> list[IngestionProposal]:
    """One net-new proposal per unit — the first-run path (`master is None`): nothing to reconcile
    against, so every unit is net-new. Basics field-by-field (the owner admits identity piecemeal);
    work/education/skill/language as whole entries."""
    b = extracted.basics
    proposals = [
        _basics_field_proposal(path, label, value, b.evidence, doc_text)
        for attr, path, label in _BASICS_FIELDS
        if (value := (getattr(b, attr) or "").strip())
    ]
    proposals += [_work_proposal(w, doc_text) for w in extracted.work]
    proposals += _quals_proposals(extracted, doc_text)
    return proposals


# --- reconciliation against an existing master --------------------------------------------------


def _master_basics_value(master: MasterProfile, attr: str) -> str | None:
    """The live master value for a `_BASICS_FIELDS` extracted attribute (location fields sit under
    `basics.location`)."""
    location_attrs = ("city", "region", "country_code")
    source = master.basics.location if attr in location_attrs else master.basics
    value: str | None = getattr(source, attr)
    return value


def _basics_reconciled(
    extracted: ExtractedBasics, master: MasterProfile, doc_text: str
) -> list[IngestionProposal]:
    """Per basics field: master empty → net-new fill; equal (normalised) → suppress; different →
    a `correction` carrying the live `current_value` for the owner's current-vs-proposed view."""
    out: list[IngestionProposal] = []
    for attr, path, label in _BASICS_FIELDS:
        value = (getattr(extracted, attr) or "").strip()
        if not value:
            continue
        current = (_master_basics_value(master, attr) or "").strip()
        if not current:
            out.append(_basics_field_proposal(path, label, value, extracted.evidence, doc_text))
        elif _norm(current) != _norm(value):
            out.append(
                _basics_field_proposal(
                    path,
                    label,
                    value,
                    extracted.evidence,
                    doc_text,
                    relationship=IngestRelationship.correction,
                    current_value=current,
                )
            )
        # else: already present (normalised-equal) → suppress
    return out


def _match_index_to_master(
    recon: WorkReconciliation, extracted_count: int, master_ids: set[str]
) -> dict[int, str]:
    """Clean the model's match list into a `{extractedIndex: masterWorkId}` map, re-grounded like
    `derive_provenance`: drop an out-of-range index, a `masterWorkId` that isn't a real master entry
    (D1 demote — the role falls through to net-new), and a duplicate claim (index or master id
    claimed twice → keep the first; the rest fall through to net-new)."""
    out: dict[int, str] = {}
    seen_master: set[str] = set()
    for m in recon.matches:
        i, mid = m.extracted_index, m.master_work_id
        if not (0 <= i < extracted_count):
            continue
        if mid not in master_ids or i in out or mid in seen_master:
            continue
        out[i] = mid
        seen_master.add(mid)
    return out


def build_reconciled_proposals(
    extracted: ExtractedProfile,
    master: MasterProfile,
    recon: WorkReconciliation,
    doc_text: str,
) -> list[IngestionProposal]:
    """Build proposals against an EXISTING master. Work is extracted-major: a role with no
    (re-grounded) match is net-new; a matched role contributes one `enrich` proposal per highlight
    not already on the target entry (normalised). Basics reconcile per field; education / skills
    / languages stay net-new (apply-time dedup). The target work id/label live on the proposal
    envelope, so the owner edits a bullet's text but never its target (invariant 2)."""
    proposals: list[IngestionProposal] = _basics_reconciled(extracted.basics, master, doc_text)

    master_by_id = {w.id: w for w in master.work}
    texts_by_id = {w.id: {_norm(h.text) for h in w.highlights} for w in master.work}
    match = _match_index_to_master(recon, len(extracted.work), set(master_by_id))

    for i, w in enumerate(extracted.work):
        mid = match.get(i)
        if mid is None:
            proposals.append(_work_proposal(w, doc_text))
            continue
        target = master_by_id[mid]
        label = f"{target.company} · {target.position}"
        seen = texts_by_id[mid]
        for text in w.highlights:
            t = text.strip()
            if not t or _norm(t) in seen:
                continue
            seen.add(_norm(t))  # so two identical extracted bullets don't both propose
            proposals.append(
                _proposal(
                    IngestUnitKind.highlight,
                    f"Add to {label}: {t}",
                    ProposalContent(highlight=ProposedHighlight(text=t)),
                    _evidence(t, doc_text),
                    relationship=IngestRelationship.enrich,
                    target_work_id=mid,
                    target_label=label,
                )
            )

    proposals += _quals_proposals(extracted, doc_text)
    return proposals


async def _attach_judge(
    proposals: list[IngestionProposal],
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
    progress: ProgressEmit | None = None,
) -> None:
    """Run the advisory **Judge** (OpenAI) over the reconciled proposals and attach a verdict to
    each (mutates in place; persisted in the proposal payload). The Judge is advisory (invariant 6):
    a failure of the RESOLVE+CALL leg degrades every proposal to a visible `JUDGE_UNAVAILABLE`
    needs-review (the run still reaches review — an OpenAI outage can't block the owner), covering a
    normalized `AgentError`, an unset tier, AND a raw provider SDK error (`openai.APIError`, raised
    before `run_openai` normalizes it) alike. Prompt construction (`system`/`build_input`) is
    OUTSIDE the catch, so a code bug there surfaces loudly rather than hiding as 'unavailable' (this
    inlines `run_agent` to draw that boundary). A missing proposalId also → needs-review."""
    if not proposals:
        return
    # Pure — built OUTSIDE the catch so a code bug here surfaces (it's not an outage to degrade).
    system = judge.system()
    user = judge.build_input(JudgeContext(proposals=proposals))
    # Emit AgentStarted AFTER the pure build (a build bug must surface loudly, not log a phantom
    # judge step). The outer finally emits AgentDone(ok=True) on BOTH the success and degrade paths:
    # the Judge is advisory, so a degraded run is "done" (its verdicts carry JUDGE_UNAVAILABLE), not
    # "failed" — the checklist shows the step finished either way.
    if progress is not None:
        await progress(AgentStarted(agent_id=judge.id))
    try:
        try:
            model = await resolve(judge.provider, judge.tier)
            report = await runner(
                provider=judge.provider,
                model=model,
                system=system,
                user=user,
                output=judge.output,
                max_tokens=judge.max_tokens,
                agent_id=judge.id,
            )
        except Exception as exc:  # advisory Judge must NEVER propagate (invariant 6)
            log.warning("ingest: judge degraded (%s) — verdicts unavailable", type(exc).__name__)
            for p in proposals:
                p.decision = ProposalDecision(
                    verdict=IngestVerdict.needs_review, reason=JUDGE_UNAVAILABLE
                )
            # Owner-facing degrade note (DevPR33) — same quiet voice as the JUDGE_UNAVAILABLE line;
            # emitted before the terminal AgentDone in the finally.
            if progress is not None:
                await progress(
                    AgentProgress(
                        agent_id=judge.id,
                        note="Suggestions unavailable — everything is ready for your review",
                    )
                )
            return
        by_id = {d.proposal_id: d for d in report.decisions}
        for p in proposals:
            d = by_id.get(p.proposal_id)
            p.decision = ProposalDecision(
                verdict=d.verdict if d is not None else IngestVerdict.needs_review,
                reason=d.reason if d is not None else "",
            )
        n = len(proposals)
        # Success note (DevPR33), before the terminal AgentDone in the finally.
        if progress is not None:
            await progress(
                AgentProgress(
                    agent_id=judge.id,
                    note=f"Reviewed {'1 suggestion' if n == 1 else f'{n} suggestions'}",
                )
            )
    finally:
        if progress is not None:
            await progress(AgentDone(agent_id=judge.id, ok=True))


async def run_ingest(
    extracted: ExtractedProfile,
    master: MasterProfile | None,
    doc_text: str,
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
    progress: ProgressEmit | None = None,
) -> list[IngestionProposal]:
    """Build reviewable proposals from an extracted document. First run (`master is None`) → every
    unit net-new, **OpenAI-free** (no Judge). Otherwise reconcile: run the work **Reconciler**
    (Claude) to match extracted roles to master entries (skipped when either side lacks work), build
    enrich/correction/net-new proposals server-side, then run the advisory **Judge** (OpenAI) for a
    verdict per proposal. A Reconciler refusal/truncation/parse error propagates to the caller's
    mark-failed path (invariant 5); the Judge degrades silently-to-`review` (invariant 6)."""
    if master is None:
        return build_net_new_proposals(extracted, doc_text)
    recon = WorkReconciliation(matches=[])
    if master.work and extracted.work:  # nothing to match if either side has no work entries
        recon = await _traced(
            work_reconciler,
            ReconcileWorkContext(extracted=extracted.work, master=master.work),
            runner=runner,
            resolve=resolve,
            progress=progress,
            note=lambda _out: "Checked your document against your master",
        )
    proposals = build_reconciled_proposals(extracted, master, recon, doc_text)
    await _attach_judge(proposals, runner=runner, resolve=resolve, progress=progress)
    return proposals
