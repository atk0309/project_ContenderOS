"""Shared Server-Sent-Events spine for the streaming agent routes.

One generator drives any streamed agent pipeline: it owns a FRESH session (the request-scoped
session is torn down once the response finishes and isn't concurrency-safe), hands that session to
an injected `execute` coroutine that runs the pipeline and emits events through a queue, relays each
event to the client, and stops at the terminal `RunDone`. A 15s `: keepalive` comment stops proxies
idling the connection; the `finally` cancels the task on the way out, so a client disconnect stops
billed provider work. `execute` owns ALL session-bound setup AND the terminal-`RunDone` guarantee —
this module stays pipeline-agnostic (ingest's run, the review fan-out, …).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine
from typing import Any

from fastapi import Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.schema.sse import RunDone, SseEvent

# Streaming-progress sink: the pipeline emits per-agent start/done/report events through this.
# Defined here (the spine's home) and imported by every caller; the identical alias in
# `agents/ingest.py` is left untouched so this stays a pure-additive module touching no agent file.
ProgressEmit = Callable[[SseEvent], Awaitable[None]]

# The session-bound pipeline body. Receives the generator's fresh session + the progress sink; it
# must emit a terminal `RunDone` (success or failure) so the stream always ends. Typed as a
# Coroutine (not a bare Awaitable) so `asyncio.create_task` accepts it.
ExecuteCoro = Callable[[AsyncSession, ProgressEmit], Coroutine[Any, Any, None]]


def wants_stream(request: Request) -> bool:
    """SSE only when the client explicitly negotiates it — keyed on the media TYPE, not header
    presence (every client sends `Accept: */*`, so 'has an Accept header' would sweep the JSON
    callers + the whole test suite into the stream branch)."""
    return "text/event-stream" in request.headers.get("accept", "")


def stream_sse(
    *,
    run_id: str | None,
    stream_maker: async_sessionmaker[AsyncSession],
    execute: ExecuteCoro,
) -> StreamingResponse:
    """Stream a pipeline as Server-Sent Events. The pipeline runs as a task owning a FRESH session
    from `stream_maker` (the request-scoped session is torn down once the response finishes and
    isn't concurrency-safe). The injected `execute` builds its own session-bound dependencies and
    guarantees a terminal `RunDone`; this loop relays events until that `RunDone`, with a 15s
    keepalive and a task-cancel on disconnect. `run_id` is echoed as `X-Run-Id` for recovery; pass
    `None` for a transient stream (no persisted run to reload), which omits the header."""

    async def event_stream() -> AsyncIterator[str]:
        async with stream_maker() as session:
            queue: asyncio.Queue[SseEvent] = asyncio.Queue()
            task = asyncio.create_task(execute(session, queue.put))
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15)
                    except TimeoutError:
                        # If the task ended WITHOUT enqueuing a terminal RunDone (a bug, or a
                        # BaseException that escaped its except), synthesize one so the stream can't
                        # keepalive forever. Race-free in the single-thread loop: a queued event
                        # fulfils queue.get() before the timeout, and there's no await between the
                        # timeout and this check. Never fires for callers that honor the contract.
                        if task.done():
                            done = RunDone(ok=False, detail="stream_ended_without_terminal")
                            yield f"data: {done.model_dump_json(by_alias=True)}\n\n"
                            break
                        yield ": keepalive\n\n"
                        continue
                    yield f"data: {event.model_dump_json(by_alias=True)}\n\n"
                    if isinstance(event, RunDone):
                        break
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    # X-Run-Id lets a client whose stream drops BEFORE `RunDone` load the exact run (even a terminal
    # `failed` one the open-run recovery list would miss). A transient stream has no persisted run,
    # so it passes `run_id=None` and omits the header — the frontend SSE consumer otherwise treats a
    # `run_done` without `resultRef` as `resultRef = X-Run-Id`, minting a fake id.
    if run_id is not None:
        headers["X-Run-Id"] = run_id
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)
