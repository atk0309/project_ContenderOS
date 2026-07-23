"""The account allowlist. Every `ALLOWLIST_EMAILS` entry is an owner account (single-user pivot);
anyone else is denied. Enforced server-side — never trust the client."""

from __future__ import annotations

from app.config import settings


def is_allowlisted(email: str) -> bool:
    """Deny-by-default: only allowlisted emails may sign in or hold a live session."""
    return email.strip().lower() in settings.allowlist
