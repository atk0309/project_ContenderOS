"""The run entrypoint + provider routing. New agents register/import here and are documented in
docs/ai-panel.md (the `ai-agent-change` doc rule).

Two injectable FastAPI dependencies keep routes testable offline:
- `get_runner` builds the provider client from the DB-stored key and routes to the per-provider
  wrapper. Tests override it with a fake runner (no DB, no network).
- `get_model_resolver` resolves an agent's tier → a concrete model id from the Admin Menu's DB
  config. Tests override it with a fake returning a fixed id.

Resolving the model BEFORE the runner keeps the `ProviderRunner` protocol (`model: str`) intact.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol, TypeVar

from fastapi import Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.agents.types import Agent
from app.ai.providers.anthropic import run_claude
from app.ai.providers.base import DEFAULT_MAX_TOKENS, Document, ModelTierUnset, ProviderRunner
from app.ai.providers.clients import get_anthropic_client, get_openai_client
from app.ai.providers.openai import run_openai
from app.persistence.engine import get_session
from app.persistence.models import ProviderModels
from app.schema.common import Provider, Tier

TCtx = TypeVar("TCtx")
TOut = TypeVar("TOut", bound=BaseModel)


class ModelResolver(Protocol):
    """Resolve a (provider, tier) to a concrete model id from the Admin Menu's DB config."""

    async def __call__(self, provider: Provider, tier: Tier) -> str: ...


async def run_agent[TCtx, TOut: BaseModel](
    agent: Agent[TCtx, TOut],
    ctx: TCtx,
    *,
    runner: ProviderRunner,
    resolve: ModelResolver,
    document: Document | None = None,
) -> TOut:
    """Resolve the agent's tier → model id (Admin Menu config), then run it through `runner`,
    returning the validated output. Provider routing lives in the runner, not here. `document` (a
    PDF) is optional runtime data — only a multimodal agent (the Extractor) passes one; the runner
    hands it to Claude as a content block and text-only providers ignore it."""
    model = await resolve(agent.provider, agent.tier)
    return await runner(
        provider=agent.provider,
        model=model,
        system=agent.system(),
        user=agent.build_input(ctx),
        output=agent.output,
        document=document,
        max_tokens=agent.max_tokens,
        agent_id=agent.id,
    )


def get_model_resolver(session: AsyncSession = Depends(get_session)) -> ModelResolver:
    """FastAPI dependency. Reads the DB tier map; an unset tier fails closed (ModelTierUnset → 503,
    'assign a model in the admin menu') rather than falling back to a hardcoded string."""

    async def resolve(provider: Provider, tier: Tier) -> str:
        pm = await session.get(ProviderModels, provider.value)
        model_id: str | None = None
        if pm is not None:
            if tier is Tier.strong:
                model_id = pm.tier_strong
            elif tier is Tier.fast:
                model_id = pm.tier_fast
            else:
                model_id = pm.tier_cheap
        if not model_id:
            raise ModelTierUnset(provider, tier)
        return model_id

    return resolve


def get_runner(session: AsyncSession = Depends(get_session)) -> ProviderRunner:
    """FastAPI dependency. The real runner builds the provider client from the DB-stored key (no
    env singleton) and routes to the per-provider wrapper; tests override it with a fake."""

    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[TOut],
        document: Document | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        agent_id: str,
    ) -> TOut:
        if provider is Provider.anthropic:
            return await run_claude(
                client=await get_anthropic_client(session),
                model=model,
                system=system,
                user=user,
                output=output,
                document=document,
                max_tokens=max_tokens,
                agent_id=agent_id,
            )
        return await run_openai(
            client=await get_openai_client(session),
            model=model,
            system=system,
            user=user,
            output=output,
            document=document,
            max_tokens=max_tokens,
            agent_id=agent_id,
        )

    return runner


async def build_panel_runner(
    session: AsyncSession,
) -> tuple[ProviderRunner, ModelResolver]:
    """Build a SESSION-FREE (runner, resolver) pair for the review fan-out (ADR 0010).

    The AsyncSession is not concurrency-safe, so a naive `asyncio.gather` over agents that each call
    `resolve()` + a cold-cache `get_*_client` would 500 in prod. Here we resolve BOTH providers'
    strong model + build BOTH clients SERIALLY up front (the only session work), then return a
    runner + resolver that close over the prebuilt clients + resolved models and never touch the
    session — so the gather is network-only. Pins the panel to the strong tier per provider (all
    review agents are strong). A missing key / unset tier raises HERE, so the streaming handler's
    preflight turns it into a clean 503 before the 200 (never mid-stream)."""
    base_resolve = get_model_resolver(session)
    models = {
        Provider.openai: await base_resolve(Provider.openai, Tier.strong),
        Provider.anthropic: await base_resolve(Provider.anthropic, Tier.strong),
    }
    oai = await get_openai_client(session)
    ant = await get_anthropic_client(session)

    async def resolve(provider: Provider, tier: Tier) -> str:
        assert tier is Tier.strong, "the review panel is pinned to the strong tier"
        return models[provider]

    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[TOut],
        document: Document | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        agent_id: str,
    ) -> TOut:
        # Typed branch (not a `clients[provider]` lookup) so each wrapper gets its concrete client.
        if provider is Provider.anthropic:
            return await run_claude(
                client=ant,
                model=model,
                system=system,
                user=user,
                output=output,
                document=document,
                max_tokens=max_tokens,
                agent_id=agent_id,
            )
        return await run_openai(
            client=oai,
            model=model,
            system=system,
            user=user,
            output=output,
            document=document,
            max_tokens=max_tokens,
            agent_id=agent_id,
        )

    return runner, resolve


async def build_authoring_runner(
    session: AsyncSession, provider: Provider, tier: Tier
) -> tuple[ProviderRunner, ModelResolver]:
    """Build a SESSION-FREE (runner, resolver) for a SINGLE authoring-agent run (the Corrector).

    Like `build_panel_runner` but for ONE provider: resolve the tier → model id and build that
    provider's client UP FRONT (the only session work), then return a runner + resolver closing over
    them that never touch the session. The caller commits/closes its request transaction before the
    provider call, so the multi-second network round-trip holds no DB transaction — there is no
    idle-in-transaction connection to be killed before the post-call write (which would 500 on
    asyncpg). Only the requested provider is touched, so an apply needs only THAT provider's
    key/tier (a missing one raises HERE → a clean 503 preflight, never mid-call)."""
    model = await get_model_resolver(session)(provider, tier)
    # Build only the requested provider's client (the other stays None → no key required for it).
    ant = await get_anthropic_client(session) if provider is Provider.anthropic else None
    oai = await get_openai_client(session) if provider is Provider.openai else None

    async def resolve(provider: Provider, tier: Tier) -> str:
        return model

    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[TOut],
        document: Document | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        agent_id: str,
    ) -> TOut:
        if provider is Provider.anthropic:
            assert ant is not None, "authoring runner built for a different provider"
            return await run_claude(
                client=ant,
                model=model,
                system=system,
                user=user,
                output=output,
                document=document,
                max_tokens=max_tokens,
                agent_id=agent_id,
            )
        assert oai is not None, "authoring runner built for a different provider"
        return await run_openai(
            client=oai,
            model=model,
            system=system,
            user=user,
            output=output,
            document=document,
            max_tokens=max_tokens,
            agent_id=agent_id,
        )

    return runner, resolve


# Builds the session-free panel (runner, resolver) pair. Injectable so tests fake the whole panel
# (the fan-out calls `get_*_client`/`get_model_resolver` directly, bypassing `Depends` overrides).
PanelRunnerBuilder = Callable[[AsyncSession], Awaitable[tuple[ProviderRunner, ModelResolver]]]


def get_panel_runner_builder() -> PanelRunnerBuilder:
    """FastAPI dependency returning the real `build_panel_runner`; tests override it with a fake
    returning a `(fake_runner, fake_resolve)` pair so the offline suite never builds clients."""
    return build_panel_runner


# Builds the single-agent session-free (runner, resolver) for the Corrector's `/apply`. Injectable
# for the same reason as the panel builder: `build_authoring_runner` calls `get_*_client` /
# `get_model_resolver` directly, so a test fakes the whole builder rather than those deps.
AuthoringRunnerBuilder = Callable[
    [AsyncSession, Provider, Tier], Awaitable[tuple[ProviderRunner, ModelResolver]]
]


def get_authoring_runner_builder() -> AuthoringRunnerBuilder:
    """FastAPI dependency returning the real `build_authoring_runner`; tests override it with a fake
    so the offline suite never builds a provider client or hits the network."""
    return build_authoring_runner
