"""FastAPI application factory.

Thin: route handlers live in `app/routes/`, business logic in `app/`. Provider keys stay
server-side (encrypted in the DB, managed via the Admin Menu). In the private-backend topology the
browser is same-origin with the frontend, which proxies to this backend over Railway's private
network — so CORS is defensive (it only matters if the backend is ever exposed publicly). Auth rides
an http-only session cookie (SessionMiddleware, signed with AUTH_SECRET).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from anthropic import APIError as AnthropicAPIError
from fastapi import Depends, FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import APIError as OpenAIAPIError
from starlette.middleware.sessions import SessionMiddleware

from app.ai.provenance import StableIdError
from app.ai.providers.base import (
    AgentParseError,
    AgentRefusal,
    AgentTruncated,
    ProviderConfigError,
)
from app.auth.deps import current_user
from app.auth.entra import init_entra
from app.config import settings
from app.persistence.cv_store import CVLocked
from app.persistence.engine import get_engine
from app.persistence.models import Base
from app.routes import admin, ai, applications, auth, cv, health, ingest, master, meta
from app.schema import ApplicationConflict, ConflictCode


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Fail closed outside dev: a missing master key or DB URL must crash at boot, not mid-request.
    if settings.environment != "development":
        _ = settings.fernet_key
        settings.require_database_url()
    # Create tables on startup (additive-only; no Alembic — docs/adr/0006). Skipped with no DB URL
    # so the offline test suite + local runs without Postgres still import and start.
    if settings.database_url:
        async with get_engine().begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    yield
    if settings.database_url:
        await get_engine().dispose()


def _register_error_handlers(app: FastAPI) -> None:
    """Map domain errors to clean status codes so nothing leaks as a raw 500. Misconfiguration is a
    503 (fix it in the Admin Menu); a provider that refused/cut-off/garbled output, or a provider
    SDK failure, is a 4xx/502 — never our 500."""

    async def on_config_error(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": str(exc)}
        )

    async def on_refusal(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, content={"detail": str(exc)}
        )

    async def on_bad_gateway(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY, content={"detail": str(exc)})

    async def on_cv_locked(request: Request, exc: Exception) -> JSONResponse:
        # An applied/locked CV refused an edit/sign-off/delete (ADR 0009). 409 with the machine code
        # so the client tells it apart from a stale-version 409 and redirects to the tracker.
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=ApplicationConflict(code=ConflictCode.cv_locked, detail=str(exc)).model_dump(
                by_alias=True
            ),
        )

    app.add_exception_handler(CVLocked, on_cv_locked)
    app.add_exception_handler(ProviderConfigError, on_config_error)
    app.add_exception_handler(AgentRefusal, on_refusal)
    # Blank/duplicate stable ids in a tailored CV break review-thread anchoring — reject early.
    app.add_exception_handler(StableIdError, on_refusal)
    app.add_exception_handler(AgentTruncated, on_bad_gateway)
    app.add_exception_handler(AgentParseError, on_bad_gateway)
    app.add_exception_handler(AnthropicAPIError, on_bad_gateway)
    app.add_exception_handler(OpenAIAPIError, on_bad_gateway)


def create_app() -> FastAPI:
    app = FastAPI(
        title=f"{settings.app_name} API",
        version="0.1.0",
        description="AI CV-tailoring cockpit — agents, persistence, auth, the provenance gate.",
        lifespan=lifespan,
    )

    # Auth session cookie (signed). SameSite/Secure come from settings so cross-site FE/BE on
    # Railway works (None+Secure) while local dev can relax it.
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.signing_secret,  # fails closed outside dev (see config.signing_secret)
        session_cookie=settings.session_cookie_name,
        max_age=settings.session_ttl_seconds,
        same_site=settings.cookie_samesite,
        https_only=settings.cookie_secure,
    )
    # Defensive: the browser is same-origin via the frontend proxy, so server-to-server calls don't
    # trigger CORS. This only bites if the backend is given a public domain.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    init_entra()  # registers the Entra OIDC client iff configured; no-op otherwise
    _register_error_handlers(app)

    app.include_router(health.router)
    app.include_router(meta.router)
    app.include_router(auth.router)
    # Everything behind the gate: no session -> 401.
    app.include_router(ai.router, dependencies=[Depends(current_user)])
    # Workspace-scoped CV routes; per-workspace authorization is enforced on each route.
    app.include_router(cv.router, dependencies=[Depends(current_user)])
    # Workspace-scoped application tracking (lock a CV to a job); owner-only per route.
    app.include_router(applications.router, dependencies=[Depends(current_user)])
    # Workspace-scoped master-profile routes (owner's canonical CV); per-route authorization.
    app.include_router(master.router, dependencies=[Depends(current_user)])
    # Workspace-scoped ingestion routes (build the master from a document); owner-only per route.
    app.include_router(ingest.router, dependencies=[Depends(current_user)])
    # Admin Menu: authenticated AND owner-only (require_owner on the router).
    app.include_router(admin.router, dependencies=[Depends(current_user)])
    return app


app = create_app()
