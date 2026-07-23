"""An `Agent` is a pinned config exposed as a typed function — not a framework abstraction. It binds
a provider + tier (model resolved at call time from the admin-managed DB map, ADR 0006) + output
schema + system prompt + an input builder. See docs/ai-panel.md."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

from pydantic import BaseModel

from app.ai.providers.base import DEFAULT_MAX_TOKENS
from app.schema.common import Provider, Tier

TCtx = TypeVar("TCtx")
TOut = TypeVar("TOut", bound=BaseModel)


@dataclass(frozen=True)
class Agent[TCtx, TOut: BaseModel]:
    id: str
    description: str
    provider: Provider
    # The capability tier this agent wants. Resolved to a concrete model id at call time from the
    # Admin Menu's DB config (see agents/registry.py) — no model string is pinned in code.
    tier: Tier
    output: type[TOut]
    system: Callable[[], str]
    build_input: Callable[[TCtx], str]
    # Per-agent structured-output budget. Defaults to DEFAULT_MAX_TOKENS; raise it for an agent
    # whose output is large (e.g. the Extractor over a full multi-page CV).
    max_tokens: int = DEFAULT_MAX_TOKENS
