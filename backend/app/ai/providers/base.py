"""Provider-agnostic plumbing for the agent panel.

Agents never import an SDK directly — they call through a `ProviderRunner`. The default runner
(registry.py) routes to the per-provider wrappers (Anthropic now; OpenAI in P3). Failures are
surfaced loudly: a silent malformed CV is worse than a loud error (backend/AGENTS.md §Rules).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal, Protocol, TypeVar

from pydantic import BaseModel

from app.schema.common import Provider, Tier

log = logging.getLogger("contender.ai")

TOut = TypeVar("TOut", bound=BaseModel)

# The classified `outcome=` vocabulary every `agent_call` log line carries. The classification
# mirrors what the wrapper raises (AgentRefusal/AgentTruncated/AgentParseError → the first four;
# any other SDK-raised failure → "error"), so the log and the surfaced exception never disagree.
Outcome = Literal["ok", "refusal", "truncation", "schema-parse-fail", "error"]

# Default structured-output budget. A per-agent override (`Agent.max_tokens`) raises it for agents
# whose output is large — the Extractor over a multi-page CV is the one most likely to truncate.
DEFAULT_MAX_TOKENS = 8000


@dataclass(frozen=True)
class Document:
    """A PDF handed to a multimodal-capable provider (Claude) as a base64 document content block
    alongside the text prompt — provider-neutral plumbing, not a wire model. Text-only providers
    (the OpenAI adjudicators) ignore it. `data_b64` is the base64-encoded PDF bytes; PDF is the only
    document type the ingestion pipeline takes today."""

    data_b64: str


class AgentError(RuntimeError):
    """Base for agent-call failures."""


class AgentRefusal(AgentError):
    """The model declined the request (stop_reason='refusal')."""


class AgentTruncated(AgentError):
    """The model hit max_tokens before completing the structured output."""


class AgentParseError(AgentError):
    """The provider returned no schema-valid parsed output."""


class ProviderConfigError(RuntimeError):
    """The provider is not configured for use. Surfaced as 503 — the fix is in the Admin Menu, not
    a retry. Distinct from AgentError (a live call that failed)."""


class ProviderKeyMissing(ProviderConfigError):
    """No API key stored for the provider."""

    def __init__(self, provider: Provider) -> None:
        self.provider = provider
        super().__init__(f"No API key set for {provider.value}. Add it in the admin menu.")


class ProviderKeyUndecryptable(ProviderConfigError):
    """The stored key can't be decrypted — the master key (SECRETS_ENCRYPTION_KEY) changed or the
    ciphertext is corrupt. A config fault, not a client one → 503, re-enter the key."""

    def __init__(self, provider: Provider) -> None:
        self.provider = provider
        super().__init__(
            f"Stored {provider.value} key can't be decrypted (the encryption key changed). "
            "Re-enter it in the admin menu."
        )


class ModelTierUnset(ProviderConfigError):
    """No model assigned to the (provider, tier) an agent asked for."""

    def __init__(self, provider: Provider, tier: Tier) -> None:
        self.provider = provider
        self.tier = tier
        super().__init__(
            f"No model assigned for {provider.value}/{tier.value}. Assign one in the admin menu."
        )


class ProviderRunner(Protocol):
    """Run a system+user prompt against a provider with a Pydantic output schema, returning the
    validated instance. Structured outputs are provider-enforced — never prompt-and-pray."""

    async def __call__(
        self,
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[TOut],
        document: Document | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        agent_id: str,
    ) -> TOut: ...
