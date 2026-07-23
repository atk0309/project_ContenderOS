"""Tenant isolation (invariant 8): authorization is server-side and deny-by-default.

Two layers are covered:
  - the allowlist gates (`current_user` revalidation is covered in test_auth; here the
    `require_owner` admin gate + allowlist membership — every entry is an owner); and
  - per-workspace authorization (`require_workspace_owner`) against a membership store —
    including the cross-tenant deny: a member of workspace A is refused on B.
Offline — no network/DB; the store is in-memory.
"""

from __future__ import annotations

import pytest
from app.auth.allowlist import is_allowlisted
from app.auth.deps import require_owner, require_workspace_owner
from app.config import settings
from app.persistence import (
    DEFAULT_WORKSPACE_ID,
    AllowlistMembershipStore,
)
from app.schema import AuthUser
from app.schema.workspace import Membership
from fastapi import HTTPException

from tests.factories import InMemoryMembershipStore


def _user(email: str) -> AuthUser:
    return AuthUser(email=email)


# --- allowlist gates: deny-by-default + the admin gate ------------------------------------------


def test_non_allowlisted_email_is_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    """Deny-by-default: someone outside the allowlist has no access at all."""
    monkeypatch.setattr(settings, "allowlist_emails", "cand@example.com, second@example.com")
    assert is_allowlisted("stranger@example.com") is False


def test_every_allowlist_entry_is_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    """The single-user pivot: BOTH entries pass the admin gate — no reviewer tier exists."""
    monkeypatch.setattr(settings, "allowlist_emails", "cand@example.com, second@example.com")
    assert require_owner(_user("cand@example.com")).email == "cand@example.com"
    assert require_owner(_user("second@example.com")).email == "second@example.com"


def test_owner_gate_denies_non_allowlisted() -> None:
    """The admin gate refuses a de-allowlisted account — server-side, fail-closed (403)."""
    with pytest.raises(HTTPException) as exc:
        require_owner(_user("stranger@example.com"))
    assert exc.value.status_code == 403


# --- per-workspace authorization (invariant 8) --------------------------------------------------


def test_workspace_member_is_authorized() -> None:
    """A member's access to their workspace is resolved and returned."""
    store = InMemoryMembershipStore(
        [Membership(workspace_id="ws-alice", email="alice@example.com")]
    )
    membership = require_workspace_owner("ws-alice", _user("alice@example.com"), store)
    assert membership.email == "alice@example.com"
    assert membership.workspace_id == "ws-alice"


def test_member_of_one_workspace_denied_on_another() -> None:
    """The cross-tenant guarantee: Bob is a member of Alice's workspace but a stranger to
    Carol's — one workspace's data never reaches another's member."""
    store = InMemoryMembershipStore(
        [
            Membership(workspace_id="ws-alice", email="bob@example.com"),
            Membership(workspace_id="ws-carol", email="carol@example.com"),
        ]
    )
    # Allowed where he is a member...
    assert (
        require_workspace_owner("ws-alice", _user("bob@example.com"), store).workspace_id
        == "ws-alice"
    )
    # ...denied (403) where he is not — fail-closed.
    with pytest.raises(HTTPException) as exc:
        require_workspace_owner("ws-carol", _user("bob@example.com"), store)
    assert exc.value.status_code == 403


def test_workspace_gate_denies_non_member() -> None:
    """Deny-by-default: no membership row at all -> 403, never a pass-through."""
    store = InMemoryMembershipStore([])
    with pytest.raises(HTTPException) as exc:
        require_workspace_owner("ws", _user("stranger@example.com"), store)
    assert exc.value.status_code == 403


def test_allowlist_store_models_single_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """Today: one workspace owned by every allowlisted account; other workspace ids don't exist."""
    monkeypatch.setattr(settings, "allowlist_emails", "cand@example.com, second@example.com")
    store = AllowlistMembershipStore()
    assert store.is_member(DEFAULT_WORKSPACE_ID, "cand@example.com") is True
    assert store.is_member(DEFAULT_WORKSPACE_ID, "second@example.com") is True
    assert store.is_member(DEFAULT_WORKSPACE_ID, "stranger@example.com") is False
    # Deny-by-default for any workspace that does not exist yet (cross-tenant).
    assert store.is_member("some-other-ws", "cand@example.com") is False
