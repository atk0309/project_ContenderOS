"""Async SQLAlchemy engine + session.

The engine is built **lazily** so importing this module (and thus the app) never requires a
database — the offline test suite overrides `get_session` and never touches Postgres. The DB URL
scheme is normalized to the asyncpg driver so Railway's plain `postgresql://` reference works
without a dashboard edit.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def _normalize_db_url(url: str) -> str:
    """Rewrite a plain Postgres URL to the async driver. Railway/Heroku hand out `postgres://` or
    `postgresql://`; SQLAlchemy async needs `postgresql+asyncpg://`. An already-async URL (or a
    non-Postgres one like `sqlite+aiosqlite://` in tests) is returned untouched."""
    if url.startswith("postgresql+") or "+" in url.split("://", 1)[0]:
        return url
    if url.startswith("postgresql://"):
        return "postgresql+asyncpg://" + url[len("postgresql://") :]
    if url.startswith("postgres://"):
        return "postgresql+asyncpg://" + url[len("postgres://") :]
    return url


def get_engine() -> AsyncEngine:
    """Build the engine once. Raises if no DATABASE_URL is set — callers must not reach the DB in
    that state (outside dev the lifespan fails closed before any request)."""
    global _engine, _sessionmaker
    if _engine is None:
        if not settings.database_url:
            raise RuntimeError("DATABASE_URL is not set — cannot open a database connection.")
        _engine = create_async_engine(_normalize_db_url(settings.database_url), pool_pre_ping=True)
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        get_engine()
    assert _sessionmaker is not None  # set by get_engine()
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding an async session. Tests override this with a SQLite session."""
    async with get_sessionmaker()() as session:
        yield session


def get_stream_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """FastAPI dependency returning the sessionmaker a streaming route uses to open its OWN session
    INSIDE the response generator. The request-scoped `get_session` is torn down once the streaming
    response finishes, and is not concurrency-safe — a `StreamingResponse` whose pipeline runs as a
    background task must own a fresh session for its whole life. Tests override this to point at the
    SQLite test DB (the file-backed test engine lets a second session read committed rows)."""
    return get_sessionmaker()
