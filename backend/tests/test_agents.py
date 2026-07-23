"""Parser agent + the /ai/parse route, exercised with fakes. Tests run offline — no live provider
key, no DB, no network: the runner and model resolver are both injectable and overridden here."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TypeVar

import pytest
from app.ai.agents.parser import parser
from app.ai.agents.registry import (
    ModelResolver,
    get_model_resolver,
    get_runner,
    run_agent,
)
from app.ai.providers.base import (
    AgentParseError,
    AgentRefusal,
    AgentTruncated,
    ModelTierUnset,
    ProviderKeyMissing,
    ProviderRunner,
)
from app.auth.deps import current_user
from app.main import app
from app.schema import AuthUser, JobSpec, ParsedJobSpec
from app.schema.common import Provider, Tier
from fastapi.testclient import TestClient
from pydantic import BaseModel

from tests.factories import sample_job_spec

TOut = TypeVar("TOut", bound=BaseModel)

OWNER = AuthUser(email="owner@example.com")


def _fake_runner() -> ProviderRunner:
    """A runner that ignores the model and returns a canned, schema-valid object."""

    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[TOut],
        **_: object,
    ) -> TOut:
        # The Parser's output type is ParsedJobSpec (no postingUrl) — drop it from the canned dump.
        return output.model_validate(
            sample_job_spec().model_dump(by_alias=True, exclude={"posting_url"})
        )

    return runner


def _fixed_resolver() -> ModelResolver:
    async def resolve(provider: Provider, tier: Tier) -> str:
        return "fake-model-id"

    return resolve


def _runner_raising(exc: Exception) -> Callable[[], ProviderRunner]:
    def factory() -> ProviderRunner:
        async def runner(
            *,
            provider: Provider,
            model: str,
            system: str,
            user: str,
            output: type[TOut],
            **_: object,
        ) -> TOut:
            raise exc

        return runner

    return factory


def test_parser_builds_input_with_posting() -> None:
    text = parser.build_input("Hiring a Senior Integration Engineer at Acme")
    assert "Senior Integration Engineer" in text


def test_run_agent_returns_validated_jobspec() -> None:
    result = asyncio.run(
        run_agent(parser, "raw posting", runner=_fake_runner(), resolve=_fixed_resolver())
    )
    assert isinstance(result, ParsedJobSpec)
    assert result.title == "Senior Integration Engineer"  # from the fake


def test_parse_route_returns_jobspec() -> None:
    # /ai/* is gated; stand in an authenticated owner so we test the route, not the gate. Both the
    # runner and the model resolver are faked, so no DB or provider key is needed.
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_runner] = _fake_runner
    app.dependency_overrides[get_model_resolver] = _fixed_resolver
    try:
        client = TestClient(app)
        res = client.post("/ai/parse", json={"rawText": "Senior Integration Engineer at Acme"})
        assert res.status_code == 200
        body = res.json()
        assert body["title"] == "Senior Integration Engineer"
        assert body["seniority"] == "senior"
    finally:
        app.dependency_overrides.clear()


def test_parser_output_excludes_posting_url() -> None:
    """postingUrl is owner-supplied: not in the Parser's output schema (so the model can't produce
    it) — it lives only on the wire/persisted JobSpec."""
    assert "posting_url" not in ParsedJobSpec.model_fields
    assert "posting_url" in JobSpec.model_fields


def test_parse_route_posting_url_is_null() -> None:
    """The /ai/parse response is a JobSpec whose postingUrl is null — the Parser never sets it (it's
    not in ParsedJobSpec); the owner supplies it later via the new-application modal."""
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_runner] = _fake_runner
    app.dependency_overrides[get_model_resolver] = _fixed_resolver
    try:
        client = TestClient(app)
        res = client.post("/ai/parse", json={"rawText": "Senior Integration Engineer at Acme"})
        assert res.status_code == 200
        assert res.json()["postingUrl"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (AgentRefusal("model declined"), 422),
        (AgentTruncated("cut off"), 502),
        (AgentParseError("no schema-valid output"), 502),
        (ProviderKeyMissing(Provider.anthropic), 503),
    ],
)
def test_parse_maps_runner_errors(exc: Exception, code: int) -> None:
    """No error handling existed before — these would have been raw 500s. Each is now mapped."""
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_model_resolver] = _fixed_resolver
    app.dependency_overrides[get_runner] = _runner_raising(exc)
    try:
        client = TestClient(app)
        res = client.post("/ai/parse", json={"rawText": "x"})
        assert res.status_code == code
    finally:
        app.dependency_overrides.clear()


def test_parse_maps_model_tier_unset_to_503() -> None:
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_runner] = _fake_runner

    def _resolver() -> ModelResolver:
        async def resolve(provider: Provider, tier: Tier) -> str:
            raise ModelTierUnset(provider, tier)

        return resolve

    app.dependency_overrides[get_model_resolver] = _resolver
    try:
        client = TestClient(app)
        res = client.post("/ai/parse", json={"rawText": "x"})
        assert res.status_code == 503
    finally:
        app.dependency_overrides.clear()
