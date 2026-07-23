"""Persistence / data-access layer.

Two concerns live here: async SQLAlchemy engine/session + ORM models for admin-managed provider
config (ADR 0006), and workspace ownership + membership — the tenancy boundary (invariant 8). The
API schema (OpenAPI source of truth) lives in `app/schema/`, never here. Provider-config tables are
created via `Base.metadata.create_all` on startup (no Alembic yet — docs/adr/0006); membership is
allowlist-derived today, with a Postgres-backed `MembershipStore` dropping in behind the same
interface when user management lands.
"""

from __future__ import annotations

from app.persistence.engine import get_engine, get_session, get_sessionmaker
from app.persistence.memberships import (
    DEFAULT_WORKSPACE_ID,
    AllowlistMembershipStore,
    MembershipStore,
    get_membership_store,
)
from app.persistence.models import (
    Base,
    ProviderModels,
    ProviderSecret,
    StoredApplication,
    StoredCV,
    StoredCvLabel,
    StoredCvReview,
    StoredMaster,
)

__all__ = [
    "DEFAULT_WORKSPACE_ID",
    "AllowlistMembershipStore",
    "Base",
    "MembershipStore",
    "ProviderModels",
    "ProviderSecret",
    "StoredApplication",
    "StoredCV",
    "StoredCvLabel",
    "StoredCvReview",
    "StoredMaster",
    "get_engine",
    "get_membership_store",
    "get_session",
    "get_sessionmaker",
]
