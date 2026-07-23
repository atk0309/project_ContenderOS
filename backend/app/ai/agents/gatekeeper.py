"""Gatekeeper (OpenAI) — the recruiter / ATS first-pass screen for THIS posting.

The adjudication side (invariant 6). Given the `TailoredCV` + the `JobSpec` it targets (+ the
master profile's declared `languages`, when any), it returns a `GatekeeperVerdict`: pass /
borderline / reject + an ATS match score + missing keywords / unmet must-haves + blunt recruiter
notes + anchored fixes that would flip the verdict. It reads the structured `TailoredCV` JSON —
every stable id travels in it (ADR 0010), so its `threads` can anchor without a rendered-text
projection. The declared languages count as evidence for language-related must-haves, so a language
must-have isn't marked unmet just because the CV body doesn't restate it.

Advisory only: the verdict NEVER gates export (only the sign-off gate does, invariant 2). The score
range is enforced server-side after parse (`apply_gatekeeper_authority` clamps it — the schema
documents 0-100 but the model isn't trusted for it). Mirrors the Judge (`agents/judge.py`), the
repo's other OpenAI adjudicator; the PR-0 spike proved `responses.parse` accepts the schema.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from app.ai.agents.types import Agent
from app.ai.provenance import ground_thread_anchors
from app.schema import GatekeeperVerdict, JobSpec, TailoredCV
from app.schema.common import Provider, Tier
from app.schema.master import Language


@dataclass(frozen=True)
class GatekeeperContext:
    """Internal agent input — the CV under review + the posting to screen it against. Not a wire
    model (kept here, off the OpenAPI surface), like the other agents' contexts."""

    cv: TailoredCV
    job: JobSpec
    # The master profile's declared languages — evidence for language must-haves. A tuple (not a
    # list): a frozen dataclass needs an immutable default, and `()` is safely shared.
    languages: tuple[Language, ...] = ()


def _system() -> str:
    return (
        "You are a recruiter/ATS running the FIRST-PASS screen on ONE job posting. Judge the CV "
        "against THIS posting only — be the screener, not a coach. Never invent qualifications the "
        "CV does not evidence.\n"
        "- `decision`: pass / borderline / reject, as a ~20-second human screen would land it.\n"
        "- `atsMatchScore`: 0-100, how well the CV matches the posting's keywords and must-haves.\n"
        "- `missingKeywords`: posting ats keywords the CV does not surface.\n"
        "- `unmetMustHaves`: must-haves the CV does not evidence.\n"
        "- `recruiterNotes`: blunt, what a screener thinks in ~20 seconds.\n"
        "- `threads`: anchored fixes (each `anchorId` is a real bulletId / itemId / sectionId, or "
        "'summary') that would flip a borderline/reject — critique only, do not rewrite.\n"
        "When a CANDIDATE LANGUAGES section is present, treat those declared languages as "
        "evidence when judging language-related must-haves/keywords — do not mark a language "
        "must-have unmet solely because the CV body does not restate a declared language; never "
        "assume fluency beyond what is declared.\n"
        "Return nothing but the GatekeeperVerdict."
    )


def _build_input(ctx: GatekeeperContext) -> str:
    cv_json = ctx.cv.model_dump_json(by_alias=True, indent=2)
    job_json = ctx.job.model_dump_json(by_alias=True, indent=2)
    text = f"### TAILORED CV\n{cv_json}\n\n### JOB SPEC\n{job_json}"
    if ctx.languages:
        # Appended AFTER the stable CV + job prefix (prompt-cache-friendly ordering, ADR 0010).
        languages_json = json.dumps([lang.model_dump(by_alias=True) for lang in ctx.languages])
        text += f"\n\n### CANDIDATE LANGUAGES (declared on the master profile)\n{languages_json}"
    return text


gatekeeper: Agent[GatekeeperContext, GatekeeperVerdict] = Agent(
    id="gatekeeper",
    description="TailoredCV + JobSpec -> recruiter/ATS pass/borderline/reject verdict.",
    provider=Provider.openai,
    tier=Tier.strong,
    output=GatekeeperVerdict,
    system=_system,
    build_input=_build_input,
    max_tokens=4000,
)


def apply_gatekeeper_authority(verdict: GatekeeperVerdict, cv: TailoredCV) -> GatekeeperVerdict:
    """Server-authority pass over a raw Gatekeeper verdict (mutates and returns it): CLAMP
    `atsMatchScore` into 0-100 (the model is not trusted for the range — enforced HERE, not by the
    model) and DROP any anchored fix whose `anchorId` isn't a real id of the matching kind in this
    CV (a hallucinated anchor would orphan the thread — ADR 0003). Advisory: the caller never gates
    export on the verdict (invariant 2). Applied by the review orchestrator after the agent call."""
    verdict.ats_match_score = max(0, min(100, verdict.ats_match_score))
    verdict.threads = ground_thread_anchors(verdict.threads, cv)
    return verdict
