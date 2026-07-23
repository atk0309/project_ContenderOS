"""Admin Menu store: the encrypted provider key + cached models + tier assignments.

Routes stay thin (AGENTS §8) — this holds the data logic. Lightweight exceptions distinguish the
admin error paths (no key / no synced models / unknown model) so the route maps clean status codes
without leaking a raw 500.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.ai.providers.anthropic import list_anthropic_models
from app.ai.providers.clients import (
    get_anthropic_client,
    get_openai_client,
    invalidate_client,
    list_models_for_key,
)
from app.ai.providers.openai import list_openai_models
from app.persistence.crypto import encrypt_secret, last4
from app.persistence.models import ProviderModels, ProviderSecret
from app.schema import (
    AdminProviderStatus,
    AdminStatus,
    ProviderKeyStatus,
    ProviderModelStatus,
    SetTiersRequest,
    SyncModelsResponse,
)
from app.schema.common import Provider

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class KeyNotSet(Exception):
    """An operation needs a stored key first (→ 409 in the admin route)."""


class ModelsNotSynced(Exception):
    """An operation needs a synced model list first (→ 409 in the admin route)."""


class UnknownModel(Exception):
    """A tier was assigned a model id not in the cached available list (→ 422)."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        super().__init__(f"{model_id!r} is not in the provider's available models")


async def _provider_status(session: AsyncSession, provider: Provider) -> AdminProviderStatus:
    secret = await session.get(ProviderSecret, provider.value)
    pm = await session.get(ProviderModels, provider.value)
    return AdminProviderStatus(
        provider=provider,
        is_set=secret is not None,
        last4=secret.last4 if secret else None,
        updated_at=secret.updated_at if secret else None,
        available_models=pm.available_models if pm else [],
        tier_strong=pm.tier_strong if pm else None,
        tier_fast=pm.tier_fast if pm else None,
        tier_cheap=pm.tier_cheap if pm else None,
        synced_at=pm.synced_at if pm else None,
    )


async def get_status(session: AsyncSession) -> AdminStatus:
    return AdminStatus(providers=[await _provider_status(session, p) for p in Provider])


def _prune_tiers(pm: ProviderModels, models: list[str]) -> None:
    """Null any tier assignment no longer in the available list (e.g. after a key rotation changed
    what the key can access). A pruned tier then surfaces as ModelTierUnset -> 503, not a provider
    error at call time."""
    available = set(models)
    if pm.tier_strong is not None and pm.tier_strong not in available:
        pm.tier_strong = None
    if pm.tier_fast is not None and pm.tier_fast not in available:
        pm.tier_fast = None
    if pm.tier_cheap is not None and pm.tier_cheap not in available:
        pm.tier_cheap = None


async def set_key(session: AsyncSession, provider: Provider, api_key: str) -> AdminProviderStatus:
    """Validate-then-commit: list models with the submitted key first (a bad key raises before we
    store anything), then persist the key AND cache the list in one transaction."""
    models = await list_models_for_key(provider, api_key)
    ciphertext = encrypt_secret(api_key)
    secret = await session.get(ProviderSecret, provider.value)
    if secret is None:
        session.add(
            ProviderSecret(provider=provider.value, ciphertext=ciphertext, last4=last4(api_key))
        )
    else:
        secret.ciphertext = ciphertext
        secret.last4 = last4(api_key)
    pm = await session.get(ProviderModels, provider.value)
    if pm is None:
        pm = ProviderModels(provider=provider.value, available_models=models)
        session.add(pm)
    else:
        pm.available_models = models
    _prune_tiers(pm, models)  # drop tier assignments the rotated key can no longer serve
    await session.commit()
    invalidate_client(provider)  # next call rebuilds the client from the new key
    return await _provider_status(session, provider)


async def sync_models(session: AsyncSession, provider: Provider) -> SyncModelsResponse:
    """Manual refresh of the cached model list with the stored key. No stored key → KeyNotSet."""
    if await session.get(ProviderSecret, provider.value) is None:
        raise KeyNotSet
    if provider is Provider.anthropic:
        models = await list_anthropic_models(await get_anthropic_client(session))
    else:
        models = await list_openai_models(await get_openai_client(session))
    pm = await session.get(ProviderModels, provider.value)
    if pm is None:
        pm = ProviderModels(provider=provider.value, available_models=models)
        session.add(pm)
    else:
        pm.available_models = models
    _prune_tiers(pm, models)  # a refresh that drops a model clears any tier pointing at it
    await session.commit()
    return SyncModelsResponse(provider=provider, available_models=models, synced_at=pm.synced_at)


async def set_tiers(
    session: AsyncSession, provider: Provider, tiers: SetTiersRequest
) -> ProviderModelStatus:
    pm = await session.get(ProviderModels, provider.value)
    if pm is None or not pm.available_models:
        raise ModelsNotSynced
    for value in (tiers.strong, tiers.fast, tiers.cheap):
        if value is not None and value not in pm.available_models:
            raise UnknownModel(value)
    pm.tier_strong = tiers.strong
    pm.tier_fast = tiers.fast
    pm.tier_cheap = tiers.cheap
    await session.commit()
    return ProviderModelStatus(
        provider=provider,
        available_models=pm.available_models,
        tier_strong=pm.tier_strong,
        tier_fast=pm.tier_fast,
        tier_cheap=pm.tier_cheap,
        synced_at=pm.synced_at,
    )


async def delete_key(session: AsyncSession, provider: Provider) -> ProviderKeyStatus:
    """Clear the key AND its cached models, and drop the cached client."""
    secret = await session.get(ProviderSecret, provider.value)
    if secret is not None:
        await session.delete(secret)
    pm = await session.get(ProviderModels, provider.value)
    if pm is not None:
        await session.delete(pm)
    await session.commit()
    invalidate_client(provider)
    return ProviderKeyStatus(provider=provider, is_set=False)
