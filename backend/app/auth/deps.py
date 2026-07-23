"""Auth dependencies (invariants 2/4/8).

- `current_user` — gate routes from the session cookie (401 if missing) AND revalidate the
  allowlist per request (403 if the email was removed — live revocation, fail-closed).
- `require_owner` — the admin gate (defense-in-depth: re-checks the allowlist).
- `require_workspace_owner` — authorize a *specific* workspace, server-side + deny-by-default:
  membership is re-derived from the membership store per request, never the client.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status

from app.auth.allowlist import is_allowlisted
from app.auth.session import get_session_user
from app.persistence import MembershipStore, get_membership_store
from app.schema import AuthUser
from app.schema.workspace import Membership


def current_user(request: Request) -> AuthUser:
    user = get_session_user(request)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    # Revalidate the allowlist on EVERY request: a valid session whose email was since removed
    # from ALLOWLIST_EMAILS fails closed with a 403 (the pinned revocation contract) — a cookie
    # is never a grant on its own.
    if not is_allowlisted(user.email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowlisted")
    return user


def require_owner(user: AuthUser = Depends(current_user)) -> AuthUser:
    """The admin gate. Every allowlisted account is an owner (single-user pivot), so this re-checks
    the allowlist — defense-in-depth over `current_user`'s revalidation, kept as a distinct named
    gate so admin routes stay visibly owner-gated."""
    if not is_allowlisted(user.email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Owner only")
    return user


def require_workspace_owner(
    workspace_id: str,
    user: AuthUser = Depends(current_user),
    store: MembershipStore = Depends(get_membership_store),
) -> Membership:
    """Authorize access to one workspace (invariant 8) — every member is an owner post-pivot, so
    this is THE workspace gate (the old member/owner split collapsed into it).

    Re-derives membership for *this* workspace from the store every request — never from a
    client-supplied id. Non-member -> 403 (unauthenticated already 401'd by `current_user`).
    `workspace_id` binds from the route path when used as a dependency.
    """
    if not store.is_member(workspace_id, user.email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this workspace"
        )
    return Membership(workspace_id=workspace_id, email=user.email)
