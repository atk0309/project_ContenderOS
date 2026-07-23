/**
 * Shared SSE spine for the streaming agent runs (ingestion, and the review fan-out). The backend
 * emits per-agent progress events (`schema/sse.py`) under `Accept: text/event-stream`; this is the
 * generic, surface-agnostic client: frame splitting, frame parsing, the per-agent checklist reducer,
 * and the fetch-stream reader loop. Surface-specific bits (agent labels, the result GET, the copy)
 * stay with each screen. Pure + DOM-free, so it's unit-testable in the node vitest env.
 */
import type { Schemas } from "@/lib/api/client";

/**
 * The per-agent progress events a stream emits. No generated union exists (the streaming routes
 * return a bare `StreamingResponse`, so FastAPI can't introspect a body schema — the members are
 * pinned into OpenAPI via `meta.SchemaBundle`); build the union from the members. Wire keys are
 * camelCase (`agentId`, `resultRef`).
 */
export type SseEvent =
  | Schemas["AgentStarted"]
  | Schemas["AgentProgress"]
  | Schemas["AgentDone"]
  // The review fan-out emits this when each adjudicator lands (the ingest stream never does). A
  // streaming review consumer (PR-2b) merges its one populated report field into its ReviewBundle.
  | Schemas["AgentReport"]
  | Schemas["RunDone"];

/**
 * Split a decoded SSE buffer on the `\n\n` frame delimiter, returning the COMPLETE frames and the
 * trailing partial (carried to the next chunk — a multi-byte char or a frame can split across reads).
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts, rest };
}

/**
 * Parse one SSE frame to an event, or null for a heartbeat/comment (`: keepalive`) or any frame with
 * no `data:` line / unparseable JSON. (`data:` may carry a leading space — `slice(5).trim()`.)
 */
export function parseSseFrame(frame: string): SseEvent | null {
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        return JSON.parse(line.slice(5).trim()) as SseEvent;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export type AgentStatus = "running" | "done" | "failed";
/** The live checklist: first-seen order + last-event-wins status per agentId. */
export type Checklist = { order: string[]; status: Record<string, AgentStatus> };
export const emptyChecklist = (): Checklist => ({ order: [], status: {} });

/**
 * Apply one agent event to the checklist (immutably). First sighting appends to `order`; status is
 * last-event-wins, so a retry that re-emits a started/done for the same agent collapses correctly.
 * Non-checklist events (agent_report, run_done) leave it unchanged.
 */
export function reduceChecklist(c: Checklist, ev: SseEvent): Checklist {
  if (ev.type === "agent_started" || ev.type === "agent_done") {
    const next: AgentStatus = ev.type === "agent_started" ? "running" : ev.ok ? "done" : "failed";
    return {
      order: c.order.includes(ev.agentId) ? c.order : [...c.order, ev.agentId],
      status: { ...c.status, [ev.agentId]: next },
    };
  }
  return c;
}

/** Outcome of consuming an SSE stream (or its pre-flight HTTP error). */
export type StreamOutcome =
  | { kind: "http_error"; status: number; detail: string }
  | { kind: "run_done"; ok: boolean; resultRef: string | null }
  // EOF / abort / read error with no terminal run_done; `runId` (the X-Run-Id header) lets the caller
  // load the exact run anyway, even a terminal `failed` one.
  | { kind: "dropped"; runId: string | null };

/**
 * Open the streaming POST and drive `onEvent` per SSE frame until `run_done`. A non-stream response
 * (a pre-flight 4xx/5xx) returns http_error; an aborted/dropped stream returns "dropped" (the caller
 * recovers via the run id). A streaming TextDecoder + carried buffer handle a frame or multi-byte
 * char split across reads.
 */
export async function consumeSseStream(
  call: { path: string; init?: RequestInit },
  signal: AbortSignal,
  onEvent: (ev: SseEvent) => void,
): Promise<StreamOutcome> {
  let res: Response;
  try {
    res = await fetch(call.path, { ...call.init, credentials: "include", signal });
  } catch {
    return { kind: "dropped", runId: null }; // aborted/failed before any response (no run id yet)
  }
  if (!res.ok) {
    return { kind: "http_error", status: res.status, detail: await res.text().catch(() => "") };
  }
  const runId = res.headers.get("x-run-id"); // available before the body — survives a dropped stream
  if (!res.body) return { kind: "dropped", runId };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        const ev = parseSseFrame(frame);
        if (!ev) continue;
        onEvent(ev);
        if (ev.type === "run_done") {
          return { kind: "run_done", ok: ev.ok, resultRef: ev.resultRef ?? runId };
        }
      }
    }
  } catch {
    return { kind: "dropped", runId }; // abort or network drop → load the exact run
  }
  return { kind: "dropped", runId }; // EOF with no run_done
}
