"""Workspace-scoped master-profile routes — store + auth + id validation (invariant 8).

Offline: SQLite stands in for Postgres (sqlite_maker); the membership store is in-memory, so
per-workspace authorization is exercised without a key or the network."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator

import httpx
import pytest
from app.auth.deps import current_user
from app.main import app
from app.persistence import get_membership_store, master_store
from app.persistence.locks import lock_workspace_master
from app.persistence.master_store import MasterNotFound
from app.persistence.models import Base
from app.schema import AuthUser, MasterProfile, Membership
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from tests.factories import InMemoryMembershipStore, sample_master_profile

OWNER = AuthUser(email="owner@example.com")
STRANGER = AuthUser(email="stranger@example.com")

# Owner is a member of `default`; the store denies everyone else everywhere.
_STORE = InMemoryMembershipStore([Membership(workspace_id="default", email=OWNER.email)])


@pytest.fixture
def client(sqlite_maker: async_sessionmaker[AsyncSession]) -> Iterator[TestClient]:
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_membership_store] = lambda: _STORE
    try:
        yield TestClient(app, base_url="https://testserver")
    finally:
        app.dependency_overrides.clear()


def _put(
    client: TestClient, master: MasterProfile | None = None, workspace: str = "default"
) -> httpx.Response:
    payload = (master or sample_master_profile()).model_dump(by_alias=True)
    res: httpx.Response = client.put(f"/workspaces/{workspace}/master", json=payload)
    return res


def test_get_master_null_when_unset(client: TestClient) -> None:
    """First run reads as **200-null**, not 404 — probe parity with the review-latest GET (the
    workspace mount + /master editor probe on load; an absent master is an expected state)."""
    res = client.get("/workspaces/default/master")
    assert res.status_code == 200
    assert res.json() is None


def test_put_then_get_roundtrips(client: TestClient) -> None:
    assert _put(client).status_code == 200
    got = client.get("/workspaces/default/master")
    assert got.status_code == 200
    assert got.json()["basics"]["name"] == "Sample Candidate"


def test_non_member_denied(client: TestClient) -> None:
    app.dependency_overrides[current_user] = lambda: STRANGER
    assert client.get("/workspaces/default/master").status_code == 403
    assert _put(client).status_code == 403


def test_cross_tenant_isolation(client: TestClient) -> None:
    """OWNER isn't a member of `ws2`, so neither read nor write reaches it — 403, no leak."""
    assert _put(client, workspace="default").status_code == 200
    assert client.get("/workspaces/ws2/master").status_code == 403
    assert _put(client, workspace="ws2").status_code == 403


def test_put_rejects_duplicate_work_id_422(client: TestClient) -> None:
    master = sample_master_profile()
    master.work.append(master.work[0].model_copy())  # same id "exampleco-integration-mgr"
    assert _put(client, master).status_code == 422


def test_put_rejects_colon_in_id_422(client: TestClient) -> None:
    master = sample_master_profile()
    master.work[0].id = "bad:id"  # ':' is the draft namespacing delimiter — must be rejected
    assert _put(client, master).status_code == 422


@pytest.mark.parametrize("field", ["name", "email"])
def test_put_rejects_blank_identity_422(client: TestClient, field: str) -> None:
    """name/email are NonBlank — a blank is rejected server-side (a required `str` alone accepts
    `""`). The PUT body fails request validation → a FastAPI 422 with a structured `detail` array
    (a different shape from the ingest-apply identity 422)."""
    payload = sample_master_profile().model_dump(by_alias=True)
    payload["basics"][field] = "   "  # whitespace-only → stripped to "" → min_length:1 fails
    res = client.put("/workspaces/default/master", json=payload)
    assert res.status_code == 422
    locs = [".".join(str(x) for x in e["loc"]) for e in res.json()["detail"]]
    assert any(field in loc for loc in locs)


def test_put_rejects_blank_highlight_id_422(client: TestClient) -> None:
    master = sample_master_profile()
    master.work[0].highlights[0].id = "   "
    assert _put(client, master).status_code == 422


def test_concurrent_first_save_is_last_write_wins(
    sqlite_maker: async_sessionmaker[AsyncSession],
) -> None:
    """Two racing FIRST saves for the same workspace must not 500. Both sessions SELECT no master,
    then both INSERT the same PK; the loser trips the unique constraint and falls back to an update
    (last-write-wins), leaving exactly one master — never a surfaced IntegrityError."""
    first = sample_master_profile()
    first.basics.name = "First Writer"
    second = sample_master_profile()
    second.basics.name = "Second Writer"

    async def race() -> str:
        async with sqlite_maker() as s1, sqlite_maker() as s2:
            await asyncio.gather(
                master_store.upsert_master(s1, "default", first),
                master_store.upsert_master(s2, "default", second),
            )
        async with sqlite_maker() as s3:
            return (await master_store.get_master(s3, "default")).basics.name

    assert asyncio.run(race()) in {"First Writer", "Second Writer"}


def test_lock_workspace_master_is_noop_on_sqlite(
    sqlite_maker: async_sessionmaker[AsyncSession],
) -> None:
    """Advisory locks are a Postgres concept; on the SQLite suite the helper must return cleanly
    (never raise on the unknown `pg_advisory_xact_lock` function) so the lock-taking write paths run
    unchanged offline."""

    async def run() -> None:
        async with sqlite_maker() as s:
            await lock_workspace_master(s, "default")

    asyncio.run(run())


def test_write_master_does_not_commit(
    sqlite_maker: async_sessionmaker[AsyncSession],
) -> None:
    """`write_master` upserts but never commits — the caller owns the transaction. A session that
    rolls back instead of committing must leave NO master stored (this is what lets the ingest apply
    in PR-B1 wrap the whole read-modify-write + status flips in one transaction)."""

    async def run() -> str:
        async with sqlite_maker() as writer:
            await master_store.write_master(writer, "default", sample_master_profile())
            await writer.rollback()
        async with sqlite_maker() as reader:
            try:
                await master_store.get_master(reader, "default")
            except MasterNotFound:
                return "not-persisted"
            return "persisted"

    assert asyncio.run(run()) == "not-persisted"


def test_write_master_persists_when_caller_commits(
    sqlite_maker: async_sessionmaker[AsyncSession],
) -> None:
    """The companion to the no-commit contract: once the owning transaction commits, the master the
    caller assembled is stored and re-validates to the exact JSON written."""

    async def run() -> str:
        master = sample_master_profile()
        master.basics.name = "Committed Writer"
        async with sqlite_maker() as writer:
            await master_store.write_master(writer, "default", master)
            await writer.commit()
        async with sqlite_maker() as reader:
            return (await master_store.get_master(reader, "default")).basics.name

    assert asyncio.run(run()) == "Committed Writer"


@pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"),
    reason=(
        "advisory-lock serialization is a Postgres-only guarantee (no-op on SQLite); "
        "set TEST_POSTGRES_URL to a clean async Postgres DB to run it"
    ),
)
def test_put_master_serializes_under_advisory_lock_on_postgres() -> None:
    """Two racing first-saves on Postgres must serialize under `lock_workspace_master` and resolve
    to last-write-wins with no surfaced error. (The SQLite gate cannot exercise the real lock — this
    is the integration check that closes that gap; until it runs in a Postgres job the property is a
    declared verification gap, not a pass.)"""
    url = os.environ["TEST_POSTGRES_URL"]

    async def run() -> str:
        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            maker = async_sessionmaker(engine, expire_on_commit=False)
            first = sample_master_profile()
            first.basics.name = "First Writer"
            second = sample_master_profile()
            second.basics.name = "Second Writer"
            async with maker() as s1, maker() as s2:
                await asyncio.gather(
                    master_store.upsert_master(s1, "pgws", first),
                    master_store.upsert_master(s2, "pgws", second),
                )
            async with maker() as s3:
                return (await master_store.get_master(s3, "pgws")).basics.name
        finally:
            await engine.dispose()

    assert asyncio.run(run()) in {"First Writer", "Second Writer"}
