"""The model resolver reads the Admin Menu's DB tier map; an unset tier fails closed, and the
/ai/parse route surfaces that as a 503 (not a 500). Offline (SQLite + fake runner)."""

from __future__ import annotations

import asyncio
from typing import TypeVar

import pytest
from app.ai.agents.registry import get_model_resolver, get_runner
from app.ai.providers.base import ModelTierUnset, ProviderRunner
from app.auth.deps import current_user
from app.main import app
from app.persistence.models import ProviderModels
from app.schema import AuthUser
from app.schema.common import Provider, Tier
from fastapi.testclient import TestClient
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

TOut = TypeVar("TOut", bound=BaseModel)

OWNER = AuthUser(email="owner@example.com")


def test_resolver_reads_tier_and_fails_closed(
    sqlite_maker: async_sessionmaker[AsyncSession],
) -> None:
    async def scenario() -> None:
        async with sqlite_maker() as session:
            session.add(
                ProviderModels(
                    provider="anthropic",
                    available_models=["claude-opus-4-8"],
                    tier_strong="claude-opus-4-8",
                )
            )
            await session.commit()
            resolve = get_model_resolver(session)
            assert await resolve(Provider.anthropic, Tier.strong) == "claude-opus-4-8"
            with pytest.raises(ModelTierUnset):
                await resolve(Provider.anthropic, Tier.fast)  # column is null
            with pytest.raises(ModelTierUnset):
                await resolve(Provider.openai, Tier.strong)  # no row at all

    asyncio.run(scenario())


def test_parse_503_when_tier_unset(sqlite_maker: async_sessionmaker[AsyncSession]) -> None:
    # Real resolver against an empty DB → ModelTierUnset → 503. Runner is faked but never reached.
    def _fake_runner() -> ProviderRunner:
        async def runner(
            *,
            provider: Provider,
            model: str,
            system: str,
            user: str,
            output: type[TOut],
            **_: object,
        ) -> TOut:  # pragma: no cover - not reached
            raise AssertionError("runner should not be called when the tier is unset")

        return runner

    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_runner] = _fake_runner
    try:
        client = TestClient(app, base_url="https://testserver")
        res = client.post("/ai/parse", json={"rawText": "x"})
        assert res.status_code == 503
    finally:
        app.dependency_overrides.clear()
