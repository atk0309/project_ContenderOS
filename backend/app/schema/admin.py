"""Admin Menu wire models (owner-only). The provider API key and per-tier model assignments are
managed here. These are the OPENAPI source of truth for the frontend's generated types.

Security: a status model NEVER carries the secret — only `isSet` + a `last4` hint. The key flows in
one direction (browser → encrypted DB) via `SetProviderKeyRequest`; it is never returned.
"""

from __future__ import annotations

from app.schema.common import CamelModel, Provider, UtcDateTime


class ProviderKeyStatus(CamelModel):
    """Masked key status — never the secret itself."""

    provider: Provider
    is_set: bool
    last4: str | None = None
    updated_at: UtcDateTime | None = None


class ProviderModelStatus(CamelModel):
    """Cached available models + the per-tier assignments for one provider."""

    provider: Provider
    available_models: list[str] = []
    tier_strong: str | None = None
    tier_fast: str | None = None
    tier_cheap: str | None = None
    synced_at: UtcDateTime | None = None


class AdminProviderStatus(CamelModel):
    """Everything the Admin Menu needs to render one provider's card: key status + model config.
    Flat (not nested) so the frontend reads one object per provider."""

    provider: Provider
    is_set: bool
    last4: str | None = None
    updated_at: UtcDateTime | None = None
    available_models: list[str] = []
    tier_strong: str | None = None
    tier_fast: str | None = None
    tier_cheap: str | None = None
    synced_at: UtcDateTime | None = None


class AdminStatus(CamelModel):
    """The whole settings page in one GET — one entry per provider."""

    providers: list[AdminProviderStatus]


class SetProviderKeyRequest(CamelModel):
    """Write-only: the raw API key. Validated by listing models before it is stored."""

    api_key: str


class SyncModelsResponse(CamelModel):
    provider: Provider
    available_models: list[str]
    synced_at: UtcDateTime


class SetTiersRequest(CamelModel):
    """Assign a real model id to each tier (None to leave a tier unset). Validated server-side
    against the cached available-models list."""

    strong: str | None = None
    fast: str | None = None
    cheap: str | None = None
