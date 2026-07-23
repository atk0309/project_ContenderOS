"""AI-Language Spotter (Claude) — the model pass that pairs with the deterministic slop heuristics.

Claude runs this voice review (invariant 6 keeps voice/authoring on Claude). Given the `TailoredCV`,
returns a `SlopReport`: anchored threads flagging generic / LLM-tell / cliché / bland / off-voice
phrasing. Critique only; frame as matching the candidate's authentic voice, never "beat the AI
detector". Advisory: never gates export (invariant 2). This is the optional-dense schema the PR-0
spike proved `messages.parse` compiles (dec #10).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.ai.agents.types import Agent
from app.ai.provenance import ground_thread_anchors
from app.schema import SlopReport, TailoredCV
from app.schema.common import Provider, Tier


@dataclass(frozen=True)
class SlopContext:
    """Internal agent input — the CV under review. Not a wire model."""

    cv: TailoredCV


def _system() -> str:
    return (
        "You review a CV for AI-sounding, generic, or off-voice language — the kind a sharp "
        "recruiter clocks as bland or machine-written. Frame everything as matching the "
        "candidate's authentic voice, NOT as evading detection. CRITIQUE ONLY, never rewrite.\n"
        "- `threads`: one per flagged span. `anchorId` is a real bulletId / itemId / sectionId, or "
        "'summary'. `flag`: 'generic-phrasing' / 'llm-tell' / 'cliche' / 'tonal-blandness' / "
        "'off-voice'. `severity` info/minor/major; `comment` what reads as slop and why; optional "
        "`suggestedRevision` a more human phrasing.\n"
        "Return nothing but the SlopReport."
    )


def _build_input(ctx: SlopContext) -> str:
    return f"### TAILORED CV\n{ctx.cv.model_dump_json(by_alias=True, indent=2)}"


spotter: Agent[SlopContext, SlopReport] = Agent(
    id="spotter",
    description="TailoredCV -> AI-language / voice slop flags (anchored, critique-only).",
    provider=Provider.anthropic,
    tier=Tier.strong,
    output=SlopReport,
    system=_system,
    build_input=_build_input,
    max_tokens=4000,
)


def apply_slop_authority(report: SlopReport, cv: TailoredCV) -> SlopReport:
    """Drop any thread whose anchor isn't a real id of the matching kind in this CV (ADR 0003).
    Applied by the review orchestrator after the agent call."""
    report.threads = ground_thread_anchors(report.threads, cv)
    return report
