"""Passwordless magic-link login. Stateless: a short-lived itsdangerous-signed token carries the
email — no DB (strict single-use can come with persistence). Delivery via Resend (httpx)."""

from __future__ import annotations

import logging

import httpx
from itsdangerous import BadData, URLSafeTimedSerializer

from app.config import settings

log = logging.getLogger("contender.auth")


def _serializer() -> URLSafeTimedSerializer:
    # Built per call so the secret is resolved at use (and fails closed outside dev) rather than
    # frozen at import; the same key signs the session cookie (see config.signing_secret).
    return URLSafeTimedSerializer(settings.signing_secret, salt="contender-magic")


def make_magic_token(email: str) -> str:
    return _serializer().dumps(email.strip().lower())


def read_magic_token(token: str) -> str | None:
    """The signed email if the token is valid and unexpired (≤ magic_ttl_seconds), else None."""
    try:
        email = _serializer().loads(token, max_age=settings.magic_ttl_seconds)
    except BadData:
        return None
    return email if isinstance(email, str) else None


async def send_magic_email(*, to: str, link: str) -> None:
    """Email the sign-in link via Resend. Without a key (dev), log the link instead of sending."""
    if not settings.resend_api_key:
        log.warning(
            "RESEND_API_KEY unset — magic link for %s: %s",
            to.replace("\r", "").replace("\n", ""),
            link.replace("\r", "").replace("\n", ""),
        )
        return
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.resend_from,
                "to": [to],
                "subject": f"Your {settings.app_name} sign-in link",
                "html": (
                    f"<p>Sign in to {settings.app_name}:</p>"
                    f'<p><a href="{link}">Sign in</a></p>'
                    "<p>This link expires in 15 minutes. "
                    "If you didn't request it, ignore this email.</p>"
                ),
            },
        )
        resp.raise_for_status()
