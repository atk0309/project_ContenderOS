"""Fernet encryption for provider API keys at rest.

Thin by design — no business logic. The master key comes from `settings.fernet_key`, which fails
closed outside development (config.py). Fernet is authenticated (HMAC) + versioned, so a tampered or
wrong-key token raises rather than returning garbage.
"""

from __future__ import annotations

from cryptography.fernet import Fernet

from app.config import settings


def _fernet() -> Fernet:
    return Fernet(settings.fernet_key.encode())


def encrypt_secret(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt_secret(token: bytes) -> str:
    """Decrypt a stored key. Raises `cryptography.fernet.InvalidToken` if the master key changed
    since the value was written; the caller (`providers/clients._stored_key`) wraps that as
    `ProviderKeyUndecryptable` → 503 ("re-enter the key in the admin menu")."""
    return _fernet().decrypt(token).decode()


def last4(plaintext: str) -> str:
    """A masked hint for display — never the full key. Returns the last 4 chars (or the whole string
    if it's somehow shorter, which a real key never is)."""
    return plaintext[-4:] if len(plaintext) >= 4 else plaintext
