"""Membership lookup — the single chokepoint for *who may touch which workspace* (invariant 8).

Authorization is re-derived from this on every request; the client never asserts membership. Today
there is one implicit workspace (`DEFAULT_WORKSPACE_ID`) and every allowlisted account owns it
(single-user pivot) — so isolation is enforceable and testable now, before any database exists.
If multi-workspace ever lands, swap `AllowlistMembershipStore` for a Postgres-backed
`MembershipStore` that queries memberships by workspace id; the authorization dependency in
`app/auth/deps.py` does not change.
"""

from __future__ import annotations

from typing import Protocol

from app.auth.allowlist import is_allowlisted

DEFAULT_WORKSPACE_ID = "default"


class MembershipStore(Protocol):
    """Resolve whether a user may touch a workspace. `False` means *not a member* — deny."""

    def is_member(self, workspace_id: str, email: str) -> bool: ...


class AllowlistMembershipStore:
    """Today's reality: one workspace (`DEFAULT_WORKSPACE_ID`) owned by every allowlisted account.
    Any other workspace id resolves to `False` — it does not exist yet, which is exactly the
    cross-tenant deny that invariant 8 requires."""

    def is_member(self, workspace_id: str, email: str) -> bool:
        return workspace_id == DEFAULT_WORKSPACE_ID and is_allowlisted(email)


def get_membership_store() -> MembershipStore:
    """FastAPI dependency: the active membership store. Override in tests via
    `app.dependency_overrides`; swap for a DB-backed implementation when persistence lands."""
    return AllowlistMembershipStore()
