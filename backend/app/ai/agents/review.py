"""Review orchestrator — fan out the adjudicators over one TailoredCV (ADR 0010).

Runs the advisory panel CONCURRENTLY (dec #5): the job-independent agents (Fact-Checker, Spotter)
always run; the Gatekeeper + Editor run only with a target job. Each member self-degrades — a
provider failure becomes an `AgentFailure` (and an `AgentDone(ok=false)` on the streaming arm),
never cancelling its siblings — so the `asyncio.gather` is safe. Reports are advisory: nothing here
gates export (invariant 2); only sign-off does.

Concurrency safety (R2): `runner`/`resolve` MUST be the SESSION-FREE pair from
`build_panel_runner` — this module never touches a DB session, so the gather is network-only.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from anthropic import APIError as AnthropicAPIError
from openai import APIError as OpenAIAPIError
from pydantic import BaseModel

from app.ai.agents.editor import EditorContext, apply_editor_authority, editor
from app.ai.agents.fact_checker import (
    FactCheckContext,
    apply_fact_check_authority,
    fact_checker,
)
from app.ai.agents.gatekeeper import (
    GatekeeperContext,
    apply_gatekeeper_authority,
    gatekeeper,
)
from app.ai.agents.registry import ModelResolver
from app.ai.agents.spotter import SlopContext, apply_slop_authority, spotter
from app.ai.agents.types import Agent
from app.ai.providers.base import AgentError, ProviderRunner
from app.schema import AgentFailure, JobSpec, MasterProfile, ReviewBundle, TailoredCV
from app.schema.sse import AgentDone, AgentReport, AgentStarted
from app.sse_stream import ProgressEmit

log = logging.getLogger("contender.review")

# Only PROVIDER/AGENT failures degrade an agent to a visible "unavailable"; anything else (a
# prompt-construction bug, a server-authority bug) propagates and 500s loudly (dec #5). The two SDK
# `APIError` classes are DISTINCT/unrelated, so BOTH must be listed; `AgentError` is the shared base
# covering refusal / truncation / parse-fail.
_EXPECTED = (AgentError, OpenAIAPIError, AnthropicAPIError)

# A pre-bound, uniform-arity server-authority pass (closes over cv / master, both loop-invariant).
_Authority = Callable[[Any], BaseModel]


@dataclass(frozen=True)
class MemberResult:
    """One panel member's outcome: a grounded report (success) XOR a failure (degraded)."""

    report: BaseModel | None
    failure: AgentFailure | None


def _report_event(agent_id: str, field: str, report: BaseModel) -> AgentReport:
    """Build the AgentReport envelope with exactly the one matching report field populated."""
    event = AgentReport(agent_id=agent_id)
    setattr(event, field, report)  # CamelModel has no validate_assignment → plain set
    return event


async def _run_member(
    agent: Agent[Any, Any],
    ctx: Any,
    authority: _Authority,
    field: str,
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
    progress: ProgressEmit | None,
) -> MemberResult:
    """Run one adjudicator with per-agent degrade + SSE. The prompt is built OUTSIDE the try, so a
    construction bug surfaces loudly (it's not an outage to hide); only an `_EXPECTED` provider /
    agent failure degrades to an `AgentFailure`."""
    system = agent.system()
    user = agent.build_input(ctx)
    if progress is not None:
        await progress(AgentStarted(agent_id=agent.id))
    try:
        model = await resolve(agent.provider, agent.tier)
        raw = await runner(
            provider=agent.provider,
            model=model,
            system=system,
            user=user,
            output=agent.output,
            max_tokens=agent.max_tokens,
            agent_id=agent.id,
        )
    except _EXPECTED as exc:
        detail = type(exc).__name__
        log.warning("review: %s degraded (%s)", agent.id, detail)
        if progress is not None:
            await progress(AgentDone(agent_id=agent.id, ok=False, detail=detail))
        return MemberResult(report=None, failure=AgentFailure(agent_id=agent.id, detail=detail))
    report = authority(raw)
    if progress is not None:
        await progress(_report_event(agent.id, field, report))
        await progress(AgentDone(agent_id=agent.id, ok=True))
    return MemberResult(report=report, failure=None)


async def run_review(
    cv: TailoredCV,
    master: MasterProfile,
    job: JobSpec | None,
    cv_version: int,
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
    progress: ProgressEmit | None = None,
) -> ReviewBundle:
    """Fan out the panel over `cv` and assemble a `ReviewBundle`. With `progress` set (the SSE arm)
    each member also streams `AgentStarted` → `AgentReport`/`AgentDone`. A null report field means
    the agent didn't apply (e.g. no job → no Gatekeeper/Editor); a degraded agent lands in
    `failures` (invariant 5)."""
    members: list[tuple[Agent[Any, Any], Any, _Authority, str]] = [
        (spotter, SlopContext(cv=cv), lambda r: apply_slop_authority(r, cv), "slop"),
        (
            fact_checker,
            FactCheckContext(cv=cv, master=master),
            lambda r: apply_fact_check_authority(r, cv, master),
            "fact_check",
        ),
    ]
    if job is not None:
        members += [
            (
                gatekeeper,
                GatekeeperContext(cv=cv, job=job, languages=tuple(master.languages)),
                lambda r: apply_gatekeeper_authority(r, cv),
                "gatekeeper",
            ),
            (
                editor,
                EditorContext(cv=cv, job=job),
                lambda r: apply_editor_authority(r, cv),
                "editor",
            ),
        ]
    # No return_exceptions: each member already returns a MemberResult, so the only escapee is a
    # real bug, which must propagate cleanly rather than become a value the bundle assembly chokes
    # on. We materialise Tasks (not bare coroutines) so that on such an unexpected escape we can
    # cancel AND await the still-running siblings before re-raising — otherwise their billed
    # provider calls leak on past the failure (PR #35 Codex P2). The drain swallows the resulting
    # CancelledErrors only; the original exception is re-raised untouched (clean-propagation holds).
    tasks = [
        asyncio.create_task(
            _run_member(
                agent, ctx, authority, field, runner=runner, resolve=resolve, progress=progress
            )
        )
        for agent, ctx, authority, field in members
    ]
    try:
        results: list[MemberResult] = await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    bundle = ReviewBundle(cv_version=cv_version)
    for (_agent, _ctx, _authority, field), result in zip(members, results, strict=True):
        if result.report is not None:
            setattr(bundle, field, result.report)
        if result.failure is not None:
            bundle.failures.append(result.failure)
    return bundle
