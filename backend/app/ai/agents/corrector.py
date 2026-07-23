"""Corrector (Claude) — accepted review threads -> reworded bullet TEXT, PER BULLET.

Mirrors the authoring-agent pattern (agents/tailor.py): a pinned `Agent` config + a thin input
builder + a frozen internal context (never wire surface). DevPR29 shrinks the contract from
whole-CV-in/whole-CV-out to **per-bullet**: the input is only the accepted bullets (current text +
their master source text + the accepted critique threads), and the output is only
`{bulletId -> revised text}` for exactly those bullets. This cuts latency from "scales with CV size"
to "scales with edit size" while keeping the Claude authoring pass (invariant 6 — the model still
AUTHORS the committed text; only the payload shrank).

The SERVER is authoritative on what actually persists — `apply_corrections`
(persistence/cv_store.py) splices ONLY the accepted bullets' returned text onto the STORED CV and
re-grounds them (preserving each stored `sourceId`/`origin`), so a misbehaving model output cannot
change anchoring, attribution, or sign-off (dec #7 / invariant 2). Because the model returns only
text keyed by an id — never structure — there is nothing to add/drop/re-parent, so the old whole-CV
`assert_structure_preserved` tripwire is gone; a missing accepted id / blank / oversized text is a
`StructureViolation` (422) at splice time, and a duplicate revision id is a 422 at the route.

`run_correct` runs through a SESSION-FREE runner (registry.build_authoring_runner), so the Claude
network call holds no DB transaction.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.ai.agents.registry import ModelResolver, run_agent
from app.ai.agents.types import Agent
from app.ai.providers.base import ProviderRunner
from app.schema.common import CamelModel, Provider, Tier
from app.schema.reviews import Thread


class BulletCorrection(CamelModel):
    """One accepted bullet's context for the Corrector — NOT a wire model (internal agent input).
    `masterText` is the bullet's grounding master highlight (None if net-new or dangling); `threads`
    are the accepted critique(s) on this bullet."""

    bullet_id: str
    current_text: str
    master_text: str | None = None
    threads: list[Thread] = []


class RevisedBullet(CamelModel):
    """One corrected bullet the model returns — bulletId-preserving, text only."""

    bullet_id: str
    text: str


class CorrectedBullets(CamelModel):
    """The Corrector's provider-enforced output: a revision for each accepted bullet, text only.
    Internal (not on any route), so it adds no OpenAPI surface."""

    revisions: list[RevisedBullet] = []


@dataclass(frozen=True)
class CorrectContext:
    """Internal agent input — the accepted bullets under correction. Not a wire model."""

    bullets: Sequence[BulletCorrection]


def _system() -> str:
    return (
        "You revise tailored CV bullets by applying ONLY the reviewer threads you are given. You "
        "are given a SET of bullets; each has a `bulletId`, its `currentText`, the `masterText` it "
        "is grounded on (may be null), and one or more `threads` (each may carry a "
        "`suggestedRevision`).\n"
        "- For EACH bullet, return ONE revision: apply its thread's `suggestedRevision` when "
        "present, else address the thread `comment`. Keep the SAME underlying fact as `masterText` "
        "— never invent a new claim (the server gates unbacked text and blocks export on it).\n"
        "- Return ONE revision per bullet you were given, echoing its `bulletId` unchanged. "
        "Return NOTHING for any other bullet, and never add, drop, or duplicate a bullet.\n"
        "Return nothing but the revisions."
    )


def _build_input(ctx: CorrectContext) -> str:
    bullets_json = "\n".join(b.model_dump_json(by_alias=True) for b in ctx.bullets)
    return f"### BULLETS TO CORRECT\n{bullets_json}"


corrector: Agent[CorrectContext, CorrectedBullets] = Agent(
    id="corrector",
    description="Accepted bullets + threads -> reworded bullet text (per-bullet, id-preserving).",
    provider=Provider.anthropic,
    tier=Tier.strong,
    output=CorrectedBullets,
    system=_system,
    build_input=_build_input,
)


async def run_correct(
    bullets: Sequence[BulletCorrection],
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
) -> CorrectedBullets:
    """Run the Corrector and return its RAW per-bullet revisions. Server authority (the per-bullet
    splice + selective re-ground + the lock) lives in `cv_store.apply_corrections`, not here — this
    is just the AI call (AGENTS §8). Drive it with a SESSION-FREE `(runner, resolve)` pair
    (`build_authoring_runner`) so the network call holds no DB transaction."""
    return await run_agent(
        corrector, CorrectContext(bullets=bullets), runner=runner, resolve=resolve
    )
