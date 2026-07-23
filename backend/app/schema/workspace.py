"""Tenancy entities (invariant 8).

A `Workspace` is one isolated space; a `Membership` joins a user to a workspace. Post-pivot every
allowlisted account is an owner, so membership is a boolean fact — a row means access, absence
means none (deny-by-default). Every owned entity (CV / Application / Review) carries a
`workspaceId`, and every query + authorization check is scoped by it — server-side,
deny-by-default. See `docs/architecture/security.md`.
"""

from __future__ import annotations

from app.schema.common import CamelModel


class Workspace(CamelModel):
    """One isolated tenant. `ownerEmail` is the account that created it; rows scope to `id`."""

    id: str
    owner_email: str
    name: str


class Membership(CamelModel):
    """A user's access to one workspace. Absence of a row == no access (deny-by-default)."""

    workspace_id: str
    email: str
