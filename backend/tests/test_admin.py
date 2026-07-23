"""Admin Menu routes + store. Offline: SQLite stands in for Postgres (sqlite_maker fixture) and the
provider model-list calls are faked, so nothing hits the network."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import app.ai.providers.clients as clients
import httpx
import pytest
from anthropic import APIError as AnthropicAPIError
from app.auth.deps import current_user
from app.config import settings
from app.main import app
from app.persistence import provider_store
from app.schema import AuthUser
from app.schema.common import Provider
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

OWNER = AuthUser(email="owner@example.com")
STRANGER = AuthUser(email="stranger@example.com")


@pytest.fixture(autouse=True)
def allowlisted(monkeypatch: pytest.MonkeyPatch) -> None:
    """`require_owner` re-checks the allowlist directly (defense-in-depth), so every admin-driving
    test needs OWNER's email allowlisted — the `current_user` override alone doesn't cover it."""
    monkeypatch.setattr(settings, "allowlist_emails", "owner@example.com")


@pytest.fixture
def client(sqlite_maker: async_sessionmaker[AsyncSession]) -> Iterator[TestClient]:
    app.dependency_overrides[current_user] = lambda: OWNER
    try:
        yield TestClient(app, base_url="https://testserver")
    finally:
        app.dependency_overrides.pop(current_user, None)


def _fake_list_for_key(monkeypatch: pytest.MonkeyPatch, models: list[str]) -> None:
    async def _list(provider: Provider, api_key: str) -> list[str]:
        return list(models)

    monkeypatch.setattr(provider_store, "list_models_for_key", _list)


def test_admin_requires_session() -> None:
    res = TestClient(app, base_url="https://testserver").get("/admin/providers")
    assert res.status_code == 401


def test_non_allowlisted_forbidden(client: TestClient) -> None:
    """A session for an email outside the allowlist is refused by the admin gate (403) — the
    defense-in-depth re-check, exercised past the overridden `current_user`."""
    app.dependency_overrides[current_user] = lambda: STRANGER
    assert client.get("/admin/providers").status_code == 403


def test_status_empty(client: TestClient) -> None:
    body = client.get("/admin/providers").json()
    providers = {p["provider"]: p for p in body["providers"]}
    assert providers["anthropic"]["isSet"] is False
    assert providers["anthropic"]["availableModels"] == []
    assert providers["openai"]["isSet"] is False


def test_set_key_caches_models_and_masks(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_list_for_key(monkeypatch, ["claude-opus-4-8", "claude-haiku-4-5"])
    res = client.put("/admin/providers/anthropic/key", json={"apiKey": "test-key-SECRETVALUE7777"})
    assert res.status_code == 200
    body = res.json()
    assert body["isSet"] is True
    assert body["last4"] == "7777"
    assert body["availableModels"] == ["claude-opus-4-8", "claude-haiku-4-5"]
    assert "SECRETVALUE" not in res.text  # the key is never echoed back
    # GET is masked too — the secret appears nowhere in the response.
    got = client.get("/admin/providers")
    assert "SECRETVALUE" not in got.text
    anthropic = next(p for p in got.json()["providers"] if p["provider"] == "anthropic")
    assert anthropic["isSet"] is True
    assert anthropic["last4"] == "7777"


def test_set_key_rejected_stores_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(provider: Provider, api_key: str) -> list[str]:
        raise AnthropicAPIError(
            "invalid key", request=httpx.Request("GET", "https://api.anthropic.com"), body=None
        )

    monkeypatch.setattr(provider_store, "list_models_for_key", _boom)
    res = client.put("/admin/providers/anthropic/key", json={"apiKey": "invalid-test-key"})
    assert res.status_code == 400
    # Nothing stored: status still unset.
    anthropic = next(
        p
        for p in client.get("/admin/providers").json()["providers"]
        if p["provider"] == "anthropic"
    )
    assert anthropic["isSet"] is False


def test_sync_models_no_key_409(client: TestClient) -> None:
    assert client.post("/admin/providers/openai/sync-models").status_code == 409


def test_sync_models_refreshes(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_list_for_key(monkeypatch, ["claude-old"])
    client.put("/admin/providers/anthropic/key", json={"apiKey": "test-key-aaaabbbb"})

    async def _list(_client: object) -> list[str]:
        return ["claude-new-1", "claude-new-2"]

    monkeypatch.setattr(provider_store, "list_anthropic_models", _list)
    res = client.post("/admin/providers/anthropic/sync-models")
    assert res.status_code == 200
    assert res.json()["availableModels"] == ["claude-new-1", "claude-new-2"]


def test_set_tiers_no_models_409(client: TestClient) -> None:
    res = client.put("/admin/providers/anthropic/models", json={"strong": "claude-x"})
    assert res.status_code == 409


def test_set_tiers_rejects_unknown_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_list_for_key(monkeypatch, ["claude-opus-4-8"])
    client.put("/admin/providers/anthropic/key", json={"apiKey": "test-key-aaaabbbb"})
    res = client.put("/admin/providers/anthropic/models", json={"strong": "not-a-real-model"})
    assert res.status_code == 422


def test_set_tiers_ok(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_list_for_key(monkeypatch, ["claude-opus-4-8", "claude-haiku-4-5"])
    client.put("/admin/providers/anthropic/key", json={"apiKey": "test-key-aaaabbbb"})
    res = client.put(
        "/admin/providers/anthropic/models",
        json={"strong": "claude-opus-4-8", "cheap": "claude-haiku-4-5"},
    )
    assert res.status_code == 200
    assert res.json()["tierStrong"] == "claude-opus-4-8"
    assert res.json()["tierCheap"] == "claude-haiku-4-5"


def test_delete_key_clears(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_list_for_key(monkeypatch, ["claude-x"])
    client.put("/admin/providers/anthropic/key", json={"apiKey": "test-key-aaaabbbb"})
    assert client.delete("/admin/providers/anthropic/key").json()["isSet"] is False
    # Cached models cleared too → sync now reports no key.
    assert client.post("/admin/providers/anthropic/sync-models").status_code == 409


def test_set_key_invalidates_cached_client(
    sqlite_maker: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _list(provider: Provider, api_key: str) -> list[str]:
        return ["claude-x"]

    monkeypatch.setattr(provider_store, "list_models_for_key", _list)

    async def scenario() -> None:
        async with sqlite_maker() as session:
            await provider_store.set_key(session, Provider.anthropic, "test-key-aaaabbbb")
        async with sqlite_maker() as session:
            built = await clients.get_anthropic_client(session)  # populates the cache
            assert clients._anthropic is built
            await provider_store.set_key(session, Provider.anthropic, "test-key-ccccdddd")
            assert clients._anthropic is None  # rotation invalidated the cached client

    asyncio.run(scenario())


def test_sync_models_503_when_master_key_rotated(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rotated/corrupt master key → decrypt fails → ProviderKeyUndecryptable → 503, not a 500."""
    _fake_list_for_key(monkeypatch, ["claude-x"])
    client.put("/admin/providers/anthropic/key", json={"apiKey": "test-key-aaaabbbb"})
    monkeypatch.setattr(settings, "secrets_encryption_key", Fernet.generate_key().decode())
    assert client.post("/admin/providers/anthropic/sync-models").status_code == 503


def test_sync_models_prunes_now_invalid_tier(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refresh that drops a model clears any tier pointing at it; still-valid tiers survive."""
    _fake_list_for_key(monkeypatch, ["claude-keep", "claude-drop"])
    client.put("/admin/providers/anthropic/key", json={"apiKey": "test-key-aaaabbbb"})
    client.put(
        "/admin/providers/anthropic/models",
        json={"strong": "claude-drop", "fast": "claude-keep"},
    )

    async def _list(_client: object) -> list[str]:
        return ["claude-keep"]

    monkeypatch.setattr(provider_store, "list_anthropic_models", _list)
    assert client.post("/admin/providers/anthropic/sync-models").status_code == 200
    anthropic = next(
        p
        for p in client.get("/admin/providers").json()["providers"]
        if p["provider"] == "anthropic"
    )
    assert anthropic["tierStrong"] is None  # pruned — claude-drop no longer available
    assert anthropic["tierFast"] == "claude-keep"  # survives
