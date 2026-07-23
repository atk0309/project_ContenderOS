"""Auth endpoints: magic-link (Resend) + M365 SSO (Entra OIDC), both converging on the session
cookie. The account allowlist is enforced here, server-side (every entry is an owner). Keys never
reach the client.
"""

from __future__ import annotations

import logging
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request, status
from starlette.responses import RedirectResponse, Response

from app.auth.allowlist import is_allowlisted
from app.auth.deps import current_user
from app.auth.entra import entra_configured, init_entra, oauth
from app.auth.magic import make_magic_token, read_magic_token, send_magic_email
from app.auth.session import login_user, logout_user
from app.config import settings
from app.schema import AuthUser, MagicRequest, OkResponse

log = logging.getLogger("contender.auth")

router = APIRouter(prefix="/auth", tags=["auth"])


def _signin_redirect(error: str) -> RedirectResponse:
    """Bounce back to the sign-in screen with an error code the page maps to a friendly banner.
    303 so the browser re-issues a GET (never re-POSTs) and the failed URL leaves history."""
    return RedirectResponse(f"{settings.frontend_base_url}/sign-in?error={error}", status_code=303)


@router.get("/me", response_model=AuthUser)
def me(user: AuthUser = Depends(current_user)) -> AuthUser:
    return user


@router.post("/logout", response_model=OkResponse)
def logout(request: Request) -> OkResponse:
    logout_user(request)
    return OkResponse()


@router.post("/magic/request", response_model=OkResponse)
async def magic_request(body: MagicRequest) -> OkResponse:
    """Email a sign-in link IF the address is allowlisted. Always returns ok — never reveal who is
    on the allowlist."""
    if is_allowlisted(body.email):
        token = make_magic_token(body.email)
        # Points at the public frontend, which proxies /auth/* to the private backend.
        link = f"{settings.frontend_base_url}/auth/magic/callback?token={token}"
        try:
            await send_magic_email(to=body.email.strip().lower(), link=link)
        except Exception:
            # A mailer hiccup must not change the response: a 500 here (only reachable for
            # allowlisted addresses) would turn this endpoint into an allowlist oracle. Log and
            # still return ok so allowlisted and non-allowlisted paths are indistinguishable.
            log.exception("magic-link delivery failed for an allowlisted address")
    return OkResponse()


@router.get("/magic/callback")
def magic_callback(token: str, request: Request) -> RedirectResponse:
    email = read_magic_token(token)
    if email is None or not is_allowlisted(email):
        return _signin_redirect("link")
    login_user(request, email=email)
    return RedirectResponse(f"{settings.frontend_base_url}/", status_code=303)


@router.get("/entra/login")
async def entra_login(request: Request) -> Response:
    init_entra()
    if not entra_configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "M365 sign-in is not configured")
    # The public frontend URL (proxied to the backend); must match the URI registered in Entra.
    redirect_uri = f"{settings.frontend_base_url}/auth/entra/callback"
    try:
        return cast(Response, await oauth.entra.authorize_redirect(request, redirect_uri))
    except Exception:
        # Starting the OIDC dance can fail before we ever reach Microsoft (e.g. the discovery
        # document can't be fetched). This is a top-level browser navigation, so a raw 500 here is
        # saved by the browser as a "login" file instead of showing anything — send the user back to
        # a sign-in screen they can retry, and log the real cause for diagnosis.
        log.exception("Entra SSO could not be initiated")
        return _signin_redirect("sso")


@router.get("/entra/callback")
async def entra_callback(request: Request) -> RedirectResponse:
    init_entra()
    if not entra_configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "M365 sign-in is not configured")
    try:
        token = await oauth.entra.authorize_access_token(request)
    except Exception:
        # State mismatch, declined consent, token-exchange/network failure — never a raw 500 on the
        # return leg (the browser would download it as a "callback" file). Back to sign-in with a
        # clear message; the underlying cause is logged.
        log.exception("Entra SSO callback failed")
        return _signin_redirect("sso")
    claims = token.get("userinfo") or {}
    email = str(claims.get("email") or claims.get("preferred_username") or "").strip().lower()
    if not email or not is_allowlisted(email):
        return _signin_redirect("not_allowed")
    login_user(request, email=email)
    return RedirectResponse(f"{settings.frontend_base_url}/", status_code=303)
