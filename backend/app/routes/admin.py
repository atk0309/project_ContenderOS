"""Admin Menu endpoints (owner-only).

Provider API keys are entered here — write-only, never returned (only a masked `last4` + `isSet`),
encrypted at rest. Models are polled live from the provider and assigned per tier. Every handler is
gated by `require_owner`. See docs/architecture/api.md.
"""

from __future__ import annotations

from anthropic import APIError as AnthropicAPIError
from fastapi import APIRouter, Depends, HTTPException, status
from openai import APIError as OpenAIAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_owner
from app.persistence import provider_store
from app.persistence.engine import get_session
from app.persistence.provider_store import KeyNotSet, ModelsNotSynced, UnknownModel
from app.schema import (
    AdminProviderStatus,
    AdminStatus,
    ProviderKeyStatus,
    ProviderModelStatus,
    SetProviderKeyRequest,
    SetTiersRequest,
    SyncModelsResponse,
)
from app.schema.common import Provider

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_owner)])


@router.get("/providers", response_model=AdminStatus)
async def list_providers(session: AsyncSession = Depends(get_session)) -> AdminStatus:
    return await provider_store.get_status(session)


@router.put("/providers/{provider}/key", response_model=AdminProviderStatus)
async def set_key(
    provider: Provider,
    body: SetProviderKeyRequest,
    session: AsyncSession = Depends(get_session),
) -> AdminProviderStatus:
    """Validate the key by listing models, then store it + cache the list atomically. A key the
    provider rejects → 400, and nothing is stored."""
    try:
        return await provider_store.set_key(session, provider, body.api_key)
    except (AnthropicAPIError, OpenAIAPIError) as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"{provider.value} rejected the key"
        ) from exc


@router.delete("/providers/{provider}/key", response_model=ProviderKeyStatus)
async def delete_key(
    provider: Provider, session: AsyncSession = Depends(get_session)
) -> ProviderKeyStatus:
    return await provider_store.delete_key(session, provider)


@router.post("/providers/{provider}/sync-models", response_model=SyncModelsResponse)
async def sync_models(
    provider: Provider, session: AsyncSession = Depends(get_session)
) -> SyncModelsResponse:
    try:
        return await provider_store.sync_models(session, provider)
    except KeyNotSet as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Set the provider key first") from exc
    except (AnthropicAPIError, OpenAIAPIError) as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"{provider.value} could not be reached"
        ) from exc


@router.put("/providers/{provider}/models", response_model=ProviderModelStatus)
async def set_tiers(
    provider: Provider,
    body: SetTiersRequest,
    session: AsyncSession = Depends(get_session),
) -> ProviderModelStatus:
    try:
        return await provider_store.set_tiers(session, provider, body)
    except ModelsNotSynced as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Sync models first") from exc
    except UnknownModel as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
