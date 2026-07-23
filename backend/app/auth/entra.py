"""Microsoft Entra ID (M365) sign-in via Authlib OIDC. Dormant until the AUTH_MICROSOFT_ENTRA_ID_*
env is set — `entra_configured()` gates the routes, which return 503 until then. Transient OAuth
state (state/nonce) rides the Starlette session cookie."""

from __future__ import annotations

from authlib.integrations.starlette_client import OAuth

from app.config import settings

oauth = OAuth()
_registered = False


def entra_configured() -> bool:
    return bool(
        settings.auth_microsoft_entra_id_id
        and settings.auth_microsoft_entra_id_secret
        and settings.auth_microsoft_entra_id_tenant_id
    )


def init_entra() -> None:
    """Register the Entra OIDC client once if configured; no-op otherwise (safe to recall)."""
    global _registered
    if _registered or not entra_configured():
        return
    tenant = settings.auth_microsoft_entra_id_tenant_id
    oauth.register(
        name="entra",
        client_id=settings.auth_microsoft_entra_id_id,
        client_secret=settings.auth_microsoft_entra_id_secret,
        server_metadata_url=(
            f"https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration"
        ),
        client_kwargs={"scope": "openid email profile"},
    )
    _registered = True
