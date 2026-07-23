"""Fact-Checker (OpenAI) — every material claim must trace to a master bullet.

Adjudication side (invariant 6). Given the `TailoredCV` + the `MasterProfile` it derives from,
returns a `FactCheckReport`: per-claim threads with a verdict (supported / overstated / unsupported)
and the `sourceId` of the master bullet the claim traces to. Job-independent. Reads structured JSON
(ADR 0010). Advisory: never gates export (invariant 2) — overstatement on a real source stays
advisory; the server only validates that `sourceId` points at a REAL highlight of the anchored item.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.ai.agents.types import Agent
from app.ai.provenance import allowed_highlight_ids_for_item, ground_thread_anchors
from app.schema import FactCheckReport, MasterProfile, TailoredCV
from app.schema.common import AnchorKind, FactVerdict, Provider, Tier


@dataclass(frozen=True)
class FactCheckContext:
    """Internal agent input — the CV under review + the master it derives from. Not a wire model."""

    cv: TailoredCV
    master: MasterProfile


def _system() -> str:
    return (
        "You are a fact-checker. For each material claim in the CV, decide whether the MASTER "
        "PROFILE backs it. You are ADVISORY — never rewrite, never refuse.\n"
        "- `threads`: one per checked claim. `anchorId` is a real bulletId / itemId / sectionId, "
        "or 'summary'. `verdict`: 'supported' (the master backs it), 'overstated' (a real basis "
        "but inflated), or 'unsupported' (no backing).\n"
        "- `sourceId`: the id of the exact master Highlight the claim traces to, or null if none.\n"
        "- `comment`: one short, specific note. Judge only what is shown; never invent facts.\n"
        "Return nothing but the FactCheckReport."
    )


def _build_input(ctx: FactCheckContext) -> str:
    cv_json = ctx.cv.model_dump_json(by_alias=True, indent=2)
    master_json = ctx.master.model_dump_json(by_alias=True, indent=2)
    return f"### TAILORED CV\n{cv_json}\n\n### MASTER PROFILE\n{master_json}"


fact_checker: Agent[FactCheckContext, FactCheckReport] = Agent(
    id="fact-checker",
    description="TailoredCV + MasterProfile -> per-claim supported/overstated/unsupported.",
    provider=Provider.openai,
    tier=Tier.strong,
    output=FactCheckReport,
    system=_system,
    build_input=_build_input,
    max_tokens=4000,
)


def apply_fact_check_authority(
    report: FactCheckReport, cv: TailoredCV, master: MasterProfile
) -> FactCheckReport:
    """Server authority over a raw Fact-Check report (mutates + returns). (1) Drop threads whose
    anchor isn't a real id of the matching kind (ADR 0003). (2) Validate each `sourceId` PER-ITEM,
    not against a global set — master highlight ids are unique only WITHIN a work entry, so a claim
    must trace to a highlight of ITS anchored item's source work; an out-of-scope `sourceId` is
    misattributed → null it. A section/summary anchor has no single item, so it falls back to the
    global highlight-id set (looser; documented v1 heuristic). (3) Floor: a non-`unsupported`
    verdict left with no valid source can't stand → downgrade to `unsupported` (no
    'supported'/'overstated' without a real backing bullet); and an `unsupported` verdict always
    carries `sourceId: null` (the schema contract — an unsupported claim cites nothing)."""
    report.threads = ground_thread_anchors(report.threads, cv)
    item_by_bullet = {
        bullet.bullet_id: item
        for section in cv.sections
        for item in section.items
        for bullet in item.highlights
    }
    item_by_id = {item.item_id: item for section in cv.sections for item in section.items}
    global_ids = {h.id for w in master.work for h in w.highlights}
    for thread in report.threads:
        item = None
        if thread.anchor_kind is AnchorKind.bullet:
            item = item_by_bullet.get(thread.anchor_id)
        elif thread.anchor_kind is AnchorKind.item:
            item = item_by_id.get(thread.anchor_id)
        allowed = (
            allowed_highlight_ids_for_item(master, item.source_id)
            if item is not None
            else global_ids
        )
        if thread.source_id is not None and thread.source_id not in allowed:
            thread.source_id = None  # misattributed citation → drop it
        if thread.verdict is not FactVerdict.unsupported and thread.source_id is None:
            thread.verdict = FactVerdict.unsupported  # no valid backing → can't be supported
        if thread.verdict is FactVerdict.unsupported:
            thread.source_id = None  # contract: an unsupported claim carries NO citation
    return report
