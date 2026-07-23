"""Encryption round-trip + the fail-closed master key. Offline."""

from __future__ import annotations

import pytest
from app.config import settings
from app.persistence.crypto import decrypt_secret, encrypt_secret, last4
from cryptography.fernet import Fernet, InvalidToken


def test_encrypt_round_trip() -> None:
    secret = "synthetic-secret-value-123456"
    token = encrypt_secret(secret)
    assert token != secret.encode()  # not stored in the clear
    assert decrypt_secret(token) == secret


def test_decrypt_wrong_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    token = encrypt_secret("synthetic-rotate-me")
    # Rotate the master key, then decrypting the old token must fail loudly (→ 503 upstream).
    monkeypatch.setattr(settings, "secrets_encryption_key", Fernet.generate_key().decode())
    with pytest.raises(InvalidToken):
        decrypt_secret(token)


def test_last4() -> None:
    assert last4("synthetic-key-abcd1234") == "1234"
    assert last4("ab") == "ab"  # never raises on a short value


def test_dev_fallback_is_a_valid_fernet_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "secrets_encryption_key", "")
    monkeypatch.setattr(settings, "environment", "development")
    Fernet(settings.fernet_key.encode())  # must not raise


def test_fernet_key_fails_closed_outside_dev(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "secrets_encryption_key", "")
    monkeypatch.setattr(settings, "environment", "production")
    with pytest.raises(RuntimeError):
        _ = settings.fernet_key


def test_malformed_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "secrets_encryption_key", "not-a-valid-fernet-key")
    monkeypatch.setattr(settings, "environment", "production")
    with pytest.raises(RuntimeError):
        _ = settings.fernet_key
