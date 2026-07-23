"""Tailor (Claude) — MasterProfile + JobSpec -> a provenance-tracked TailoredCV.

Mirrors the Parser pattern (agents/parser.py): a pinned `Agent` config + a thin input builder. The
agent's context is MasterProfile + JobSpec, but `run_agent` passes a single `ctx`, so we bind them
in a small frozen `TailorContext` dataclass kept *here*, not in `app/schema/` — it is internal
agent input, never wire surface, so it must not leak into the OpenAPI document.

`run_tailor` is the ONE execution path `POST /workspaces/{id}/cv` calls, so the server-side
provenance gate (invariant 2) and stable-id validation run on every tailoring — they cannot be
bypassed by an alternate route.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.ai.agents.registry import ModelResolver, run_agent
from app.ai.agents.types import Agent
from app.ai.provenance import derive_provenance, validate_stable_ids
from app.ai.providers.base import ProviderRunner
from app.schema import JobSpec, MasterProfile, TailoredCV
from app.schema.common import Provider, Tier


@dataclass(frozen=True)
class TailorContext:
    """Internal agent input — the truth (master) + the target (job). Not a wire model."""

    master: MasterProfile
    job: JobSpec


def _system() -> str:
    return (
        "You tailor a candidate's master CV to one job. Work ONLY from the master bullets — you "
        "may select, reorder, and reword them to match the job, but never invent experience.\n"
        "- Each tailored bullet MUST carry `sourceId` = the id of the exact master Highlight it "
        "came from, and `origin`: 'verbatim' (unchanged) or 'reworded' (same fact, new wording).\n"
        "- Only if a bullet states something with NO backing master Highlight, set `origin` "
        "'net-new' and `sourceId` null — but prefer not to; the server forces any unbacked bullet "
        "to net-new and blocks export on it until the candidate signs off.\n"
        "- Preserve each master work entry's id as the item's `sourceId`; give every "
        "section/item/bullet a unique stable id.\n"
        "- Write a concise `summary` in the candidate's voice. Match the job's tone and surface "
        "its ats keywords where the master genuinely supports them.\n"
        "Return nothing but the TailoredCV."
    )


def _build_input(ctx: TailorContext) -> str:
    master_json = ctx.master.model_dump_json(by_alias=True, indent=2)
    job_json = ctx.job.model_dump_json(by_alias=True, indent=2)
    return f"### MASTER PROFILE\n{master_json}\n\n### JOB SPEC\n{job_json}"


tailor: Agent[TailorContext, TailoredCV] = Agent(
    id="tailor",
    description="MasterProfile + JobSpec -> provenance-tracked TailoredCV.",
    provider=Provider.anthropic,
    tier=Tier.strong,
    output=TailoredCV,
    system=_system,
    build_input=_build_input,
)


async def run_tailor(
    master: MasterProfile,
    job: JobSpec,
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
) -> TailoredCV:
    """Run the Tailor, then apply the server-side gate: derive provenance (invariant 2) and reject
    duplicate stable ids. The single execution path behind `POST /workspaces/{id}/cv`."""
    ctx = TailorContext(master=master, job=job)
    cv = await run_agent(tailor, ctx, runner=runner, resolve=resolve)
    cv = derive_provenance(cv, master)
    validate_stable_ids(cv)
    return cv
