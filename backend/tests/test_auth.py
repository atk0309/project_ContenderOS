"""Auth gate: the allowlist (every entry is an owner), magic-link round-trip, live revocation
(403), the legacy-cookie back-compat, M365 dormant-until-configured, and that protected routes
require a session. Offline — no Resend/Entra network. https base_url so the Secure session cookie
persists across requests in the TestClient."""

from __future__ import annotations

import asyncio

import pytest
from app.auth.allowlist import is_allowlisted
from app.auth.magic import make_magic_token, read_magic_token, send_magic_email
from app.auth.session import get_session_user, login_user
from app.config import settings
from app.main import app
from fastapi.testclient import TestClient
from starlette.requests import Request


@pytest.fixture
def allowlisted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "allowlist_emails", "owner@example.com, rev@example.com")


def test_is_allowlisted(allowlisted: None) -> None:
    assert is_allowlisted("owner@example.com") is True
    assert is_allowlisted("REV@example.com") is True  # case-insensitive
    assert is_allowlisted("stranger@example.com") is False


def test_magic_token_roundtrip() -> None:
    token = make_magic_token("Owner@Example.com")
    assert read_magic_token(token) == "owner@example.com"  # normalized
    assert read_magic_token("not-a-real-token") is None


def test_dev_magic_link_log_strips_line_breaks(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(settings, "resend_api_key", "")
    with caplog.at_level("WARNING", logger="contender.auth"):
        asyncio.run(
            send_magic_email(
                to="owner@example.com\r\nforged-recipient",
                link="https://example.test/magic\r\nforged-entry",
            )
        )
    message = caplog.records[-1].getMessage()
    assert "\r" not in message
    assert "\n" not in message
    assert "forged-recipient" in message
    assert "forged-entry" in message


def test_me_requires_session() -> None:
    client = TestClient(app, base_url="https://testserver")
    assert client.get("/auth/me").status_code == 401


def test_ai_routes_require_session() -> None:
    client = TestClient(app, base_url="https://testserver")
    assert client.post("/ai/parse", json={"rawText": "x"}).status_code == 401


def test_magic_callback_logs_in_allowlisted(allowlisted: None) -> None:
    client = TestClient(app, base_url="https://testserver")
    token = make_magic_token("owner@example.com")
    res = client.get(f"/auth/magic/callback?token={token}", follow_redirects=False)
    assert res.status_code == 303
    me = client.get("/auth/me")  # session cookie now set
    assert me.status_code == 200
    # `role` is the vestigial deploy-skew constant — always "owner"; removed next release.
    assert me.json() == {"email": "owner@example.com", "role": "owner"}


def test_second_allowlisted_email_is_owner(allowlisted: None) -> None:
    """Every allowlist entry is an owner (single-user pivot): the SECOND entry signs in and gets
    the same owner wire shape — no reviewer tier exists."""
    client = TestClient(app, base_url="https://testserver")
    token = make_magic_token("rev@example.com")
    res = client.get(f"/auth/magic/callback?token={token}", follow_redirects=False)
    assert res.status_code == 303
    me = client.get("/auth/me")
    assert me.status_code == 200
    assert me.json() == {"email": "rev@example.com", "role": "owner"}


def test_magic_callback_rejects_non_allowlisted(allowlisted: None) -> None:
    client = TestClient(app, base_url="https://testserver")
    token = make_magic_token("stranger@example.com")
    res = client.get(f"/auth/magic/callback?token={token}", follow_redirects=False)
    assert res.status_code == 303
    assert "/sign-in" in res.headers["location"]
    assert client.get("/auth/me").status_code == 401  # no session granted


def test_revoked_mid_session_is_403(allowlisted: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """The pinned revocation contract: a valid session whose email is REMOVED from the allowlist
    fails closed with exactly 403 on its next request — a cookie is never a grant on its own."""
    client = TestClient(app, base_url="https://testserver")
    token = make_magic_token("rev@example.com")
    client.get(f"/auth/magic/callback?token={token}", follow_redirects=False)
    assert client.get("/auth/me").status_code == 200  # signed in
    monkeypatch.setattr(settings, "allowlist_emails", "owner@example.com")  # revoke rev@
    assert client.get("/auth/me").status_code == 403


def test_login_user_writes_legacy_compatible_role(allowlisted: None) -> None:
    """The rollback shim: the stored session keeps the OLD role semantics (first entry "owner",
    rest "reviewer") so rolling back to pre-pivot code restores exactly the old behaviour."""
    req = Request({"type": "http", "session": {}})
    login_user(req, email="Owner@Example.com")
    assert req.session["user"] == {"email": "owner@example.com", "role": "owner"}
    login_user(req, email="rev@example.com")
    assert req.session["user"] == {"email": "rev@example.com", "role": "reviewer"}


def test_get_session_user_ignores_legacy_role_key() -> None:
    """Back-compat: a pre-pivot cookie stored `role: "reviewer"`; the read path ignores it — only
    `email` is read, and `AuthUser.role` is the vestigial constant "owner"."""
    req = Request(
        {"type": "http", "session": {"user": {"email": "rev@example.com", "role": "reviewer"}}}
    )
    user = get_session_user(req)
    assert user is not None
    assert user.email == "rev@example.com"
    # The stored legacy key never surfaces — the wire value is the vestigial constant.
    assert user.model_dump(by_alias=True)["role"] == "owner"


def test_entra_login_503_when_unconfigured() -> None:
    client = TestClient(app, base_url="https://testserver")
    assert client.get("/auth/entra/login", follow_redirects=False).status_code == 503


class _StubOAuth:
    """Stands in for the Authlib OAuth registry so the Entra handlers can be exercised offline,
    without real credentials or a network round-trip to Microsoft."""

    def __init__(self, entra: object) -> None:
        self.entra = entra


def test_entra_login_redirects_to_signin_when_start_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    # Configured, but kicking off the OIDC flow blows up (e.g. discovery doc unreachable). A raw 500
    # here is what the browser saves as a "login" file — assert we redirect to sign-in instead.
    monkeypatch.setattr("app.routes.auth.entra_configured", lambda: True)
    monkeypatch.setattr("app.routes.auth.init_entra", lambda: None)

    class _Entra:
        async def authorize_redirect(self, request: object, redirect_uri: str) -> None:
            raise RuntimeError("discovery document unreachable")

    monkeypatch.setattr("app.routes.auth.oauth", _StubOAuth(_Entra()))
    client = TestClient(app, base_url="https://testserver")
    res = client.get("/auth/entra/login", follow_redirects=False)
    assert res.status_code == 303
    assert "/sign-in?error=sso" in res.headers["location"]


def test_entra_callback_redirects_to_signin_on_oauth_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from authlib.integrations.starlette_client import OAuthError

    monkeypatch.setattr("app.routes.auth.entra_configured", lambda: True)
    monkeypatch.setattr("app.routes.auth.init_entra", lambda: None)

    class _Entra:
        async def authorize_access_token(self, request: object) -> None:
            raise OAuthError(error="mismatching_state")

    monkeypatch.setattr("app.routes.auth.oauth", _StubOAuth(_Entra()))
    client = TestClient(app, base_url="https://testserver")
    res = client.get("/auth/entra/callback?state=x&code=y", follow_redirects=False)
    assert res.status_code == 303
    assert "/sign-in?error=sso" in res.headers["location"]
    assert client.get("/auth/me").status_code == 401  # no session granted


def test_signing_secret_fails_closed_outside_dev(monkeypatch: pytest.MonkeyPatch) -> None:
    # With a real secret, use it regardless of environment.
    monkeypatch.setattr(settings, "auth_secret", "real-secret")
    monkeypatch.setattr(settings, "environment", "production")
    assert settings.signing_secret == "real-secret"
    # No secret in dev: a known fallback is fine (local convenience).
    monkeypatch.setattr(settings, "auth_secret", "")
    monkeypatch.setattr(settings, "environment", "development")
    assert settings.signing_secret
    # No secret outside dev: refuse to start with a public signing key.
    monkeypatch.setattr(settings, "environment", "production")
    with pytest.raises(RuntimeError):
        _ = settings.signing_secret


def test_magic_request_opaque_on_mailer_failure(
    allowlisted: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(**_: object) -> None:
        raise RuntimeError("resend is down")

    monkeypatch.setattr("app.routes.auth.send_magic_email", _boom)
    client = TestClient(app, base_url="https://testserver")
    # Allowlisted address + failing mailer must still return ok (no allowlist oracle).
    res = client.post("/auth/magic/request", json={"email": "owner@example.com"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
