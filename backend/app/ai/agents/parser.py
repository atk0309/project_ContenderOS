"""Parser (Claude) — raw job posting -> JobSpec. Extract only; never editorialise. Flags vague or
contradictory language as redFlags."""

from __future__ import annotations

from app.ai.agents.types import Agent
from app.schema import ParsedJobSpec
from app.schema.common import Provider, Tier


def _system() -> str:
    return (
        "You parse a job posting into a strict JobSpec. Extract ONLY what the posting states — do "
        "not invent details, infer aggressively, or editorialise.\n"
        "- title / company / seniority / tone: read them off the posting.\n"
        "- mustHaves vs niceToHaves: separate hard requirements from preferred/bonus ones.\n"
        "- atsKeywords: the exact literal tokens an ATS would screen for (skills, tools, certs); "
        "an ATS does not infer synonyms, so keep them verbatim.\n"
        "- redFlags: vague, contradictory, or unrealistic language worth noting (may be empty).\n"
        "Return nothing but the JobSpec."
    )


def _build_input(raw_text: str) -> str:
    return f"### JOB POSTING\n{raw_text}"


parser: Agent[str, ParsedJobSpec] = Agent(
    id="parser",
    description="Job posting -> structured ParsedJobSpec (extract-only; no owner input).",
    provider=Provider.anthropic,
    tier=Tier.strong,
    output=ParsedJobSpec,
    system=_system,
    build_input=_build_input,
)
