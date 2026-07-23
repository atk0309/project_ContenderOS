"""AI agent endpoints. Handlers stay thin: build the agent input, resolve its model + run it through
the injected runner (the real provider by default; fakes in tests), return the validated schema.
Provider keys never touch the client (invariant 4) and are sourced from the encrypted DB store."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.ai.agents.parser import parser
from app.ai.agents.registry import ModelResolver, get_model_resolver, get_runner, run_agent
from app.ai.providers.base import ProviderRunner
from app.schema import JobSpec
from app.schema.requests import ParseRequest

router = APIRouter(prefix="/ai", tags=["ai"])


@router.post("/parse", response_model=JobSpec)
async def parse(
    body: ParseRequest,
    runner: ProviderRunner = Depends(get_runner),
    resolve: ModelResolver = Depends(get_model_resolver),
) -> JobSpec:
    """Parse a pasted job posting into a structured JobSpec (Parser agent, Claude)."""
    spec = await run_agent(parser, body.raw_text, runner=runner, resolve=resolve)
    # The Parser outputs ParsedJobSpec (no postingUrl by construction); upgrade to the wire JobSpec.
    # postingUrl is owner-supplied (the new-application modal), never model-produced.
    return JobSpec.model_validate(spec.model_dump(by_alias=True))
