"""Editor (OpenAI) — line-edit critique of a TailoredCV against THIS posting.

Adjudication side (invariant 6). Given the `TailoredCV` + the `JobSpec` it targets, returns an
`EditorReport`: an overall note + anchored line-edit threads (critique only, never rewrites — the
Corrector applies fixes later). Reads the structured `TailoredCV` JSON (ADR 0010), so threads anchor
without a rendered-text projection. Advisory: never gates export (invariant 2).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.ai.agents.types import Agent
from app.ai.provenance import ground_thread_anchors
from app.schema import EditorReport, JobSpec, TailoredCV
from app.schema.common import Provider, Tier


@dataclass(frozen=True)
class EditorContext:
    """Internal agent input — the CV under review + the posting it targets. Not a wire model."""

    cv: TailoredCV
    job: JobSpec


def _system() -> str:
    return (
        "You are a senior CV editor doing a LINE EDIT against ONE job posting. Tighten wording, "
        "cut filler, and sharpen impact for THIS posting — but CRITIQUE ONLY, never rewrite the "
        "candidate's content (a separate step applies fixes). Never invent experience.\n"
        "- `overall`: 1-2 sentences on the CV's strongest and weakest lines for this posting.\n"
        "- `threads`: anchored line-edits. Each `anchorId` is a real bulletId / itemId / "
        "sectionId, or 'summary'; `severity` info/minor/major; `comment` the specific edit; "
        "optional `suggestedRevision` a tighter wording the candidate could adopt.\n"
        "Return nothing but the EditorReport."
    )


def _build_input(ctx: EditorContext) -> str:
    cv_json = ctx.cv.model_dump_json(by_alias=True, indent=2)
    job_json = ctx.job.model_dump_json(by_alias=True, indent=2)
    return f"### TAILORED CV\n{cv_json}\n\n### JOB SPEC\n{job_json}"


editor: Agent[EditorContext, EditorReport] = Agent(
    id="editor",
    description="TailoredCV + JobSpec -> line-edit critique (anchored, critique-only).",
    provider=Provider.openai,
    tier=Tier.strong,
    output=EditorReport,
    system=_system,
    build_input=_build_input,
    max_tokens=4000,
)


def apply_editor_authority(report: EditorReport, cv: TailoredCV) -> EditorReport:
    """Drop any thread whose anchor isn't a real id of the matching kind in this CV (ADR 0003).
    Applied by the review orchestrator after the agent call."""
    report.threads = ground_thread_anchors(report.threads, cv)
    return report
