"""Session state rides Starlette's signed-cookie session (SessionMiddleware, secret = AUTH_SECRET).
We stash only the authenticated user; the cookie is http-only + SameSite/Secure per settings. No DB.
"""

from __future__ import annotations

from starlette.requests import Request

from app.config import settings
from app.schema import AuthUser


def login_user(request: Request, *, email: str) -> None:
    e = email.strip().lower()
    # Rollback shim: write a legacy-COMPATIBLE vestigial `role` key ("owner" only for the FIRST
    # allowlist entry, matching the pre-pivot resolve_role exactly) so rolling back to old code
    # restores exactly the old semantics — a blanket "owner" write would grant the second account
    # /admin under the old `require_owner`. New code never reads it; removed next release.
    allow = settings.allowlist
    legacy_role = "owner" if allow and e == allow[0] else "reviewer"
    request.session["user"] = {"email": e, "role": legacy_role}


def logout_user(request: Request) -> None:
    request.session.pop("user", None)


def get_session_user(request: Request) -> AuthUser | None:
    data = request.session.get("user")
    if not data:
        return None
    # Back-compat: only `email` is read. Older cookies (and the rollback shim above) carry a
    # `role` key — deliberately IGNORED; post-pivot every allowlisted account is the owner and
    # `AuthUser.role` is a vestigial constant.
    return AuthUser(email=data["email"])
