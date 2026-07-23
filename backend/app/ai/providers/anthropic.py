"""Anthropic (Claude) wrapper — the authoring side of the panel.

Uses the SDK's structured-output helper `messages.parse(output_format=...)`, so a malformed
response is impossible: typed Pydantic out, or an explicit error
(`AsyncMessages.parse` → `ParsedMessage.parsed_output`; SDK version: see uv.lock).

The client is built from a key the caller supplies (the Admin Menu stores it encrypted in the DB,
see providers/clients.py) — never from a module-level env singleton.

NOTE: Opus 4.8 rejects sampling params (`temperature`/`top_p`/`top_k`) — sending one is a 400. No
sampling params are sent; determinism comes from the structured-output contract, not sampling.
"""

from __future__ import annotations

import time
from typing import TypeVar

from anthropic import AsyncAnthropic
from anthropic.types import MessageParam
from pydantic import BaseModel

from app.ai.providers.base import (
    DEFAULT_MAX_TOKENS,
    AgentParseError,
    AgentRefusal,
    AgentTruncated,
    Document,
    Outcome,
    log,
)

TOut = TypeVar("TOut", bound=BaseModel)


def make_anthropic_client(api_key: str) -> AsyncAnthropic:
    return AsyncAnthropic(api_key=api_key)


async def list_anthropic_models(client: AsyncAnthropic) -> list[str]:
    """Model ids the key can access, filtered to Claude chat models (best-effort — existence is not
    structured-output capability; the Admin Menu says as much)."""
    page = await client.models.list(limit=1000)
    return [m.id for m in page.data if m.id.startswith("claude-")]


async def run_claude[TOut: BaseModel](
    *,
    client: AsyncAnthropic,
    model: str,
    system: str,
    user: str,
    output: type[TOut],
    document: Document | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    agent_id: str,
) -> TOut:
    # Multimodal: when a document (a PDF) is supplied, send it as a base64 `document` content block
    # ahead of the text prompt. `messages.parse` still enforces the structured output, so the PDF +
    # output_format travel in one call (see ADR 0007). Annotating `list[MessageParam]` keeps the
    # block literals checked against the SDK's content-block TypedDicts.
    if document is None:
        messages: list[MessageParam] = [{"role": "user", "content": user}]
    else:
        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": document.data_b64,
                        },
                    },
                    {"type": "text", "text": user},
                ],
            }
        ]
    started = time.monotonic()
    try:
        resp = await client.messages.parse(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            output_format=output,
        )
    except Exception as exc:
        # An SDK-raised failure (BadRequestError, rate limit, connection) logged nothing before —
        # surface the outcome so the agent-call log covers the error path too (AGENTS §8).
        #
        # This deliberately INCLUDES pydantic.ValidationError raised from inside `messages.parse`:
        # the SDK validates every text block regardless of stop_reason (anthropic 0.116.0,
        # lib/_parse/_response.py:16-20 `parse_text` → TypeAdapter.validate_json, applied
        # unconditionally by `parse_response` :49-72 via the parser closure in
        # resources/messages/messages.py), so the partial JSON of a max_tokens TRUNCATION raises
        # the exact same ValidationError as a schema-invalid complete answer. stop_reason is
        # unreachable on this raise path, so classifying it `schema-parse-fail` (or converting to
        # AgentParseError) could mislabel a truncation — and AgentParseError is in ingest's
        # `_FALLBACK_ERRORS`, which would add a billed PDF-fallback retry on truncations that
        # text-only would truncate again. `outcome=error err=ValidationError` is the honest signal;
        # the original exception propagates unchanged (pre-classification downstream behavior).
        latency_ms = round((time.monotonic() - started) * 1000)
        log.warning(
            "agent_call provider=anthropic agent=%s model=%s latency_ms=%s outcome=error err=%s",
            agent_id,
            model,
            latency_ms,
            type(exc).__name__,
        )
        raise
    latency_ms = round((time.monotonic() - started) * 1000)
    # Classified outcome mirrors the raise below — the raw `stop=` field stays alongside it.
    outcome: Outcome
    if resp.stop_reason == "refusal":
        outcome = "refusal"
    elif resp.stop_reason == "max_tokens":
        outcome = "truncation"
    elif resp.parsed_output is None:
        outcome = "schema-parse-fail"
    else:
        outcome = "ok"
    log.info(
        "agent_call provider=anthropic agent=%s model=%s in=%s out=%s latency_ms=%s stop=%s "
        "outcome=%s",
        agent_id,
        model,
        resp.usage.input_tokens,
        resp.usage.output_tokens,
        latency_ms,
        resp.stop_reason,
        outcome,
    )
    if resp.stop_reason == "refusal":
        raise AgentRefusal(f"Claude refused the request (model={model})")
    if resp.stop_reason == "max_tokens":
        raise AgentTruncated(f"Claude hit max_tokens before finishing (model={model})")
    parsed = resp.parsed_output
    if parsed is None:
        raise AgentParseError(f"Claude returned no schema-valid output (model={model})")
    return parsed
