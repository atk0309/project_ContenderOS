"""Shared test fixtures. The suite is offline: a file-backed SQLite DB (NullPool, so connections
never cross event loops) stands in for Postgres, and provider clients/runners are faked. No network,
no live keys."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import app.ai.providers.clients as clients
import pytest
from app.main import app
from app.persistence.engine import get_session, get_stream_sessionmaker
from app.persistence.models import Base
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool


@pytest.fixture
def sqlite_maker(tmp_path: Path) -> Iterator[async_sessionmaker[AsyncSession]]:
    """A file-backed SQLite async sessionmaker with the schema created, wired as the app's
    `get_session` override — a real DB for store/route tests without Postgres."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/test.db", poolclass=NullPool)

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def _override() -> AsyncIterator[AsyncSession]:
        async with maker() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    # The streaming ingest route opens its OWN session from this maker inside the response generator
    # (the file-backed test engine lets that second session read rows the request committed).
    app.dependency_overrides[get_stream_sessionmaker] = lambda: maker
    yield maker
    app.dependency_overrides.pop(get_session, None)
    app.dependency_overrides.pop(get_stream_sessionmaker, None)
    asyncio.run(engine.dispose())


@pytest.fixture(autouse=True)
def _reset_provider_clients() -> Iterator[None]:
    """Provider clients are process-level singletons — reset them around each test for isolation."""
    clients._anthropic = None
    clients._openai = None
    yield
    clients._anthropic = None
    clients._openai = None
