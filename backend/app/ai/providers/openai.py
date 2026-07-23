"""OpenAI wrapper — the adjudication side of the panel.

Uses the Responses API structured-output helper `responses.parse(text_format=...)` → `output_parsed`
(SDK version: see uv.lock). The client is built from a key the caller supplies (Admin Menu →
encrypted DB), never an env singleton.

No sampling params are sent: dynamic model selection can land on reasoning (o-series) models that
reject them. Determinism comes from the structured-output contract, not sampling.
"""

from __future__ import annotations

import time
from typing import TypeVar

from openai import AsyncOpenAI
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

# Best-effort capability filter: keep chat/reasoning families, drop non-text endpoints. A heuristic
# that can rot as the catalogue changes — paired with clean runtime errors + Admin Menu copy.
_CHAT_PREFIXES = ("gpt-", "chatgpt", "o1", "o3", "o4")
_DROP_TOKENS = (
    "embedding",
    "whisper",
    "tts",
    "dall-e",
    "image",
    "audio",
    "realtime",
    "transcribe",
    "moderation",
    "search",
)


def make_openai_client(api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(api_key=api_key)


async def list_openai_models(client: AsyncOpenAI) -> list[str]:
    """Model ids the key can access, filtered to chat/reasoning families (best-effort)."""
    page = await client.models.list()
    out = [
        m.id
        for m in page.data
        if m.id.startswith(_CHAT_PREFIXES) and not any(tok in m.id for tok in _DROP_TOKENS)
    ]
    return sorted(out)


async def run_openai[TOut: BaseModel](
    *,
    client: AsyncOpenAI,
    model: str,
    system: str,
    user: str,
    output: type[TOut],
    document: Document | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    agent_id: str,
) -> TOut:
    # `document` is accepted for ProviderRunner uniformity but NOT forwarded: the OpenAI
    # adjudicators are text-only (the PDF is read by the Claude Extractor, invariant 6). It is a
    # no-op here so any agent routes through one runner signature.
    _ = document
    started = time.monotonic()
    try:
        resp = await client.responses.parse(
            model=model,
            instructions=system,
            input=user,
            text_format=output,
            max_output_tokens=max_tokens,
        )
    except Exception as exc:
        # An SDK-raised failure logged nothing before — surface the outcome on the error path too
        # (AGENTS §8).
        #
        # This deliberately INCLUDES pydantic.ValidationError raised from inside `responses.parse`:
        # the SDK validates every `output_text` part regardless of `response.status` (openai
        # 2.44.0, lib/_parsing/_responses.py:53-77 `parse_response` → `parse_text` :142-153
        # model_parse_json; refusal parts are skipped unparsed :65-67, but an `incomplete`
        # response's partial JSON IS validated — no status gate like the chat-completions path's
        # LengthFinishReasonError, _completions.py:99-103; verified unchanged in 2.45.0, which only
        # adds passthrough output types). `status` is unreachable on this raise
        # path, so classifying it `schema-parse-fail` (or converting to AgentParseError) could
        # mislabel a max_output_tokens truncation. `outcome=error err=ValidationError` is the
        # honest signal; the original exception propagates unchanged.
        latency_ms = round((time.monotonic() - started) * 1000)
        log.warning(
            "agent_call provider=openai agent=%s model=%s latency_ms=%s outcome=error err=%s",
            agent_id,
            model,
            latency_ms,
            type(exc).__name__,
        )
        raise
    latency_ms = round((time.monotonic() - started) * 1000)
    usage = resp.usage
    # Classified outcome mirrors the raise precedence below (incomplete → refusal-part → parsed
    # None) — the raw `status=` field stays alongside it. A content_filter-incomplete classifies
    # as truncation because AgentTruncated is what is raised for any incomplete status.
    outcome: Outcome
    if resp.status == "incomplete":
        outcome = "truncation"
    elif any(
        getattr(part, "type", None) == "refusal"
        for item in resp.output
        for part in getattr(item, "content", None) or []
    ):
        outcome = "refusal"
    elif resp.output_parsed is None:
        outcome = "schema-parse-fail"
    else:
        outcome = "ok"
    log.info(
        "agent_call provider=openai agent=%s model=%s in=%s out=%s latency_ms=%s status=%s "
        "outcome=%s",
        agent_id,
        model,
        usage.input_tokens if usage else 0,
        usage.output_tokens if usage else 0,
        latency_ms,
        resp.status,
        outcome,
    )
    if resp.status == "incomplete":
        reason = resp.incomplete_details.reason if resp.incomplete_details else "unknown"
        raise AgentTruncated(f"OpenAI response incomplete (model={model}, reason={reason})")
    for item in resp.output:
        for part in getattr(item, "content", None) or []:
            if getattr(part, "type", None) == "refusal":
                raise AgentRefusal(f"OpenAI refused the request (model={model})")
    parsed = resp.output_parsed
    if parsed is None:
        raise AgentParseError(f"OpenAI returned no schema-valid output (model={model})")
    return parsed
