"""Judge agent (OpenAI) — advisory verdicts on the reconciled ingestion proposals.

The adjudication side of ingestion (invariant 6) and the FIRST OpenAI agent in the repo. Given the
server's reconciled proposals (each a server-minted `proposalId` + kind / relationship / summary),
the Judge recommends **include / exclude / needs-review** per proposal — ADVISORY ONLY. It never
gates apply nor the bulk net-new add (the server + the owner's accept remain the authority); an
omitted/unknown `proposalId`, or a Judge outage, maps to `needs-review` and the run still reaches
review.

Strict-mode / grammar: OpenAI structured outputs (`responses.parse`) require every key present, so
`JudgeReport` is a single REQUIRED list of fixed-shape `JudgeDecision {proposalId, verdict, reason}`
(0 optional fields). This is the first live OpenAI structured-output call in the codebase;
**re-spiked GREEN against a real key** (`test_run_openai_live_spike`, 2026-06-25).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.ai.agents.types import Agent
from app.schema.common import CamelModel, Provider, Tier
from app.schema.ingest import IngestionProposal, IngestVerdict


class JudgeDecision(CamelModel):
    """One advisory verdict, echoing the server-minted `proposalId`. All required (no optionals)."""

    proposal_id: str
    verdict: IngestVerdict
    reason: str


class JudgeReport(CamelModel):
    """The verdict set — a REQUIRED list (no default, so the model can't omit it). One decision per
    proposal; the server joins by `proposalId` and defaults any missing to needs-review."""

    decisions: list[JudgeDecision]


@dataclass(frozen=True)
class JudgeContext:
    proposals: list[IngestionProposal]


def _system() -> str:
    return (
        "You adjudicate proposed additions to a candidate's master CV profile. For EACH proposal, "
        "recommend whether the candidate should include it, exclude it, or look more closely. You "
        "are ADVISORY — the candidate decides; never refuse and never rewrite their content.\n"
        "Rules:\n"
        "- Emit exactly one decision per proposal, echoing its `proposalId` verbatim.\n"
        "- `verdict`: `include` (clearly belongs), `exclude` (noise / duplicate / irrelevant), "
        "or `needs-review` (unsure, or possibly overstated).\n"
        "- `reason`: one short phrase the candidate can act on.\n"
        "- Judge only what is shown; never invent facts about the candidate."
    )


def _build_input(ctx: JudgeContext) -> str:
    lines = ["### PROPOSALS (proposalId · kind · relationship · summary)"]
    for p in ctx.proposals:
        lines.append(
            f"{p.proposal_id} · {p.unit_kind.value} · {p.relationship.value} · {p.summary}"
        )
    return "\n".join(lines)


judge: Agent[JudgeContext, JudgeReport] = Agent(
    id="judge",
    description="Reconciled ingestion proposals -> advisory include/exclude/needs-review verdicts.",
    provider=Provider.openai,
    tier=Tier.strong,
    output=JudgeReport,
    system=_system,
    build_input=_build_input,
    max_tokens=4000,
)
