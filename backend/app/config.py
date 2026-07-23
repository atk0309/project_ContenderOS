"""Runtime configuration — service, database, auth, and session settings.

Provider API keys and model ids do NOT live here: keys are stored encrypted in the DB and models
are picked per tier in the owner-only Admin Menu (ADR 0006). The only provider secret in env is
`SECRETS_ENCRYPTION_KEY`, the Fernet master key that encrypts the stored keys at rest.

Secrets are read from the environment only — never hard-coded, never sent to the client.
"""

from __future__ import annotations

from typing import Literal

from cryptography.fernet import Fernet
from pydantic_settings import BaseSettings, SettingsConfigDict

# A fixed, PUBLIC, dev-only Fernet key so the test suite and local runs work without setup. It is
# safe precisely because it is public: never used outside ENVIRONMENT=development (see fernet_key).
_DEV_FERNET_KEY = "qwhBp6hwCiHPL1V612zUELBdw67ibp_uQqm6avN39JU="


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- service ---
    app_name: str = "Contender"
    environment: str = "development"
    # Comma-separated frontend origins allowed to call the API with credentials.
    cors_origins: str = "http://localhost:3000"
    # Log output format: "json" (structured, for Railway) or "console" (readable, for local dev).
    # Empty = derive from environment (see log_format_resolved). Honoured by app/logging_config.py.
    log_format: str = ""

    # Master key that encrypts the DB-stored provider keys (Fernet) — the only provider secret left
    # in env. Generate one with the Fernet.generate_key() helper shown in .env.example.
    secrets_encryption_key: str = ""

    # --- database ---
    database_url: str = ""

    # --- auth (Microsoft Entra ID) ---
    auth_secret: str = ""
    auth_microsoft_entra_id_id: str = ""
    auth_microsoft_entra_id_secret: str = ""
    auth_microsoft_entra_id_tenant_id: str = ""
    # Comma-separated allowlist: only these accounts may sign in. Every entry is an owner.
    allowlist_emails: str = ""

    # --- session cookie ---
    session_cookie_name: str = "contender_session"
    session_ttl_seconds: int = 60 * 60 * 24 * 14  # 14 days
    cookie_secure: bool = True  # set false only for plain-http local dev
    # "lax" is right for the private-backend topology: the browser is same-origin with the frontend
    # (which proxies to the backend), so the cookie is same-site. Use "none" only if the browser
    # ever calls the backend cross-site directly.
    cookie_samesite: Literal["lax", "strict", "none"] = "lax"

    # --- magic-link login (Resend) ---
    resend_api_key: str = ""
    resend_from: str = "Contender <onboarding@resend.dev>"
    magic_ttl_seconds: int = 60 * 15  # 15 minutes

    # --- public URL (the single public surface) ---
    # All browser-facing redirects (magic-link callback, Entra redirect URI) point here. The backend
    # has no public domain of its own in the private-backend topology — the frontend proxies to it.
    frontend_base_url: str = "http://localhost:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def log_format_resolved(self) -> Literal["json", "console"]:
        """The effective log format. An explicit `LOG_FORMAT` wins; otherwise default to readable
        `console` in development and structured `json` elsewhere (so Railway parses levels)."""
        raw = self.log_format.strip().lower()
        if raw in ("json", "console"):
            return raw  # type: ignore[return-value]
        return "console" if self.environment == "development" else "json"

    @property
    def allowlist(self) -> list[str]:
        return [e.strip().lower() for e in self.allowlist_emails.split(",") if e.strip()]

    @property
    def signing_secret(self) -> str:
        """The key that signs the session cookie AND magic-link tokens. Required outside
        development: a public fallback would let anyone mint a session cookie (even owner) and walk
        straight through the gate, so we fail closed rather than start with a known secret."""
        if self.auth_secret:
            return self.auth_secret
        if self.environment == "development":
            return "dev-insecure-not-for-production"
        raise RuntimeError(
            f"AUTH_SECRET must be set outside development (environment={self.environment!r}); "
            "refusing to start with a public signing key."
        )

    @property
    def fernet_key(self) -> str:
        """The master key that encrypts provider API keys at rest. Like `signing_secret` it fails
        closed outside development — but it CANNOT reuse that string: Fernet needs a url-safe base64
        32-byte key. In development we fall back to a fixed public key so tests + local runs work
        without setup. The configured key is validated (a malformed key fails loudly, not at the
        first decrypt)."""
        key = self.secrets_encryption_key or (
            _DEV_FERNET_KEY if self.environment == "development" else ""
        )
        if not key:
            raise RuntimeError(
                f"SECRETS_ENCRYPTION_KEY must be set outside development "
                f"(environment={self.environment!r}); refusing to start without a key to encrypt "
                "stored provider secrets."
            )
        try:
            Fernet(key.encode())
        except (ValueError, TypeError) as exc:
            raise RuntimeError(
                "SECRETS_ENCRYPTION_KEY is not a valid Fernet key (expected url-safe base64, 32 "
                'bytes). Generate one: python -c "from cryptography.fernet import Fernet; '
                'print(Fernet.generate_key().decode())"'
            ) from exc
        return key

    def require_database_url(self) -> str:
        """The DB URL, failing closed outside development (the app cannot work without persistence
        once the Admin Menu owns provider config). In development an empty URL is allowed — the
        persistence layer is simply skipped (offline tests, no Postgres)."""
        if self.database_url:
            return self.database_url
        if self.environment == "development":
            return ""
        raise RuntimeError(
            f"DATABASE_URL must be set outside development (environment={self.environment!r})."
        )


settings = Settings()
