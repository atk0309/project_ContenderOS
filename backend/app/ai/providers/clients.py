"""Provider SDK clients built from the DB-stored (encrypted) keys.

Agents/routes never construct an SDK client directly — they get one here, built from the key the
owner saved in the Admin Menu. Small process-level singletons avoid re-decrypting + re-instantiating
on every call; the Admin Menu calls `invalidate_client` when a provider's key changes or is deleted.

(Single-process Railway deploy is the norm. A multi-replica deploy would need a TTL/pubsub so a key
change on one replica reaches the others — out of scope; noted in docs/adr/0006.)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from cryptography.fernet import InvalidToken

from app.ai.providers.anthropic import list_anthropic_models, make_anthropic_client
from app.ai.providers.base import ProviderKeyMissing, ProviderKeyUndecryptable
from app.ai.providers.openai import list_openai_models, make_openai_client
from app.persistence.crypto import decrypt_secret
from app.persistence.models import ProviderSecret
from app.schema.common import Provider

if TYPE_CHECKING:
    from anthropic import AsyncAnthropic
    from openai import AsyncOpenAI
    from sqlalchemy.ext.asyncio import AsyncSession

_anthropic: AsyncAnthropic | None = None
_openai: AsyncOpenAI | None = None


async def _stored_key(session: AsyncSession, provider: Provider) -> str:
    row = await session.get(ProviderSecret, provider.value)
    if row is None:
        raise ProviderKeyMissing(provider)
    try:
        return decrypt_secret(row.ciphertext)
    except InvalidToken as exc:
        # Master key rotated/corrupted: a config fault, not a 500. → ProviderConfigError → 503.
        raise ProviderKeyUndecryptable(provider) from exc


async def get_anthropic_client(session: AsyncSession) -> AsyncAnthropic:
    global _anthropic
    if _anthropic is None:
        _anthropic = make_anthropic_client(await _stored_key(session, Provider.anthropic))
    return _anthropic


async def get_openai_client(session: AsyncSession) -> AsyncOpenAI:
    global _openai
    if _openai is None:
        _openai = make_openai_client(await _stored_key(session, Provider.openai))
    return _openai


def invalidate_client(provider: Provider) -> None:
    """Drop the cached client so the next call rebuilds it from the current stored key."""
    global _anthropic, _openai
    if provider is Provider.anthropic:
        _anthropic = None
    else:
        _openai = None


async def list_models_for_key(provider: Provider, api_key: str) -> list[str]:
    """Validate a raw key by listing models with it (used before storing). A provider rejection
    raises the SDK's error, surfaced upstream as 400/502 — nothing is stored on failure."""
    if provider is Provider.anthropic:
        return await list_anthropic_models(make_anthropic_client(api_key))
    return await list_openai_models(make_openai_client(api_key))
