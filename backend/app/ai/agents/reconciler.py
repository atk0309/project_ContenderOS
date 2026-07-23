"""Reconciler agent (Claude) — match extracted work entries against the existing master.

The reconciliation side of ingestion's authoring half (invariant 6): given the freshly extracted
work entries and the candidate's current master work entries, decide which extracted roles ARE an
existing master entry (so their NEW bullets enrich it) vs which are net-new. The model ONLY
classifies — it emits an index→master-id match list and never re-emits or rewords the candidate's
real CV text. The server re-grounds every match, diffs highlights, and builds the proposals
(`agents/ingest.build_reconciled_proposals`). Basics / education / skills / languages reconcile
deterministically server-side, so the model is needed for fuzzy work-entry matching ONLY.

Grammar budget (ADR 0007 / [[anthropic-structured-output-complexity]]): the output is a single
REQUIRED list of fixed-shape `WorkMatch` (0 optional fields) — simpler than the live-passing
`ExtractedWorkList`, far below the optional-dense `RawBasics` the API rejected. The list is required
(no default) so the model can't omit it and re-introduce optionality. **Re-spiked GREEN** against a
real key (`test_run_claude_live_reconciler_spike`, 2026-06-25) — the offline fake runner returns a
canned object and can't prove the API accepts the schema; the live spike does.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.ai.agents.types import Agent
from app.schema.common import CamelModel, Provider, Tier
from app.schema.ingest import ExtractedWork
from app.schema.master import WorkEntry


class WorkMatch(CamelModel):
    """One extracted role the model believes IS an existing master work entry — purely STRUCTURAL
    (index → master id), no prose: the model classifies, the server builds everything else (ADR
    0008), so the model never emits the candidate's facts. Both required (one grammar shape)."""

    extracted_index: int  # 0-based index into the extracted work list shown in the prompt
    master_work_id: str  # the id of the master work entry it matches


class WorkReconciliation(CamelModel):
    """The match set — a SPARSE list (only roles the model matched; an extracted role absent here is
    net-new). `matches` is REQUIRED, no default: a defaulted/omittable field would re-introduce the
    grammar optionality the 3-call Extractor split exists to avoid (ADR 0007). Emits [] when nothing
    matches."""

    matches: list[WorkMatch]


@dataclass(frozen=True)
class ReconcileWorkContext:
    """Reconciler input: the extracted work entries (positional) + the master's work entries (id +
    identity only — no highlights; match on the role, not the bullets)."""

    extracted: list[ExtractedWork]
    master: list[WorkEntry]


def _system() -> str:
    return (
        "You reconcile a candidate's EXTRACTED work history against the work entries already "
        "in their master profile. For each extracted role decide whether it is THE SAME role as an "
        "existing master entry (the same job at the same employer) — so its bullet points should "
        "enrich that entry — or a NEW role the master does not have yet.\n"
        "Rules:\n"
        "- Emit a match ONLY for an extracted role that IS an existing master entry; give the "
        "extracted role's 0-based `extractedIndex` and the entry's `masterWorkId`.\n"
        "- OMIT any extracted role that is new (no confident match) — never invent a match.\n"
        "- Match on employer + role identity (company, position, dates), NOT on bullet wording.\n"
        "- Use ONLY the `masterWorkId` values listed below; never mint, alter, or guess an id.\n"
        "- Map each `extractedIndex` to at most one entry, and each entry to at most one index.\n"
        "- Emit ONLY the index and the id — no prose, no other fields.\n"
        "- If nothing matches, return an empty `matches` list."
    )


def _build_input(ctx: ReconcileWorkContext) -> str:
    lines: list[str] = ["### EXTRACTED WORK (extractedIndex · company · position · dates)"]
    if ctx.extracted:
        for i, w in enumerate(ctx.extracted):
            lines.append(
                f"[{i}] {w.company} · {w.position} · {w.start_date}-{w.end_date or 'present'}"
            )
    else:
        lines.append("(none)")
    lines += ["", "### MASTER WORK ENTRIES (masterWorkId · company · position · dates)"]
    if ctx.master:
        for m in ctx.master:
            lines.append(
                f"{m.id} · {m.company} · {m.position} · {m.start_date}-{m.end_date or 'present'}"
            )
    else:
        lines.append("(none)")
    return "\n".join(lines)


work_reconciler: Agent[ReconcileWorkContext, WorkReconciliation] = Agent(
    id="reconciler-work",
    description="Extracted work history + master work entries -> index→masterWorkId match set.",
    provider=Provider.anthropic,
    tier=Tier.strong,
    output=WorkReconciliation,
    system=_system,
    build_input=_build_input,
    max_tokens=4000,
)
