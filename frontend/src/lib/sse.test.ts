import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChecklist } from "@/ui/AgentChecklist";
import {
  type Checklist,
  consumeSseStream,
  emptyChecklist,
  parseSseFrame,
  reduceChecklist,
  type SseEvent,
  splitSseFrames,
} from "./sse";

const enc = new TextEncoder();
const streamResponse = (chunks: string[], headers: Record<string, string> = {}): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
};

const signal = () => new AbortController().signal;
const ev = (e: SseEvent) => e;

describe("sse frame parsing", () => {
  it("splitSseFrames returns complete frames and carries the trailing partial", () => {
    const a = splitSseFrames("data: {}\n\ndata: {}\n\ndata: par");
    expect(a.frames).toEqual(["data: {}", "data: {}"]);
    expect(a.rest).toBe("data: par");
    expect(splitSseFrames("data: half")).toEqual({ frames: [], rest: "data: half" });
  });

  it("parseSseFrame parses data lines, ignores keepalives and junk", () => {
    expect(parseSseFrame('data: {"type":"run_done","ok":true,"resultRef":"r1"}')).toEqual({
      type: "run_done",
      ok: true,
      resultRef: "r1",
    });
    expect(parseSseFrame('data:{"type":"agent_started","agentId":"editor"}')).toEqual({
      type: "agent_started",
      agentId: "editor",
    });
    expect(parseSseFrame(": keepalive")).toBeNull();
    expect(parseSseFrame("event: x")).toBeNull();
    expect(parseSseFrame("data: not json")).toBeNull();
  });
});

describe("reduceChecklist", () => {
  it("appends in first-seen order with last-event-wins status", () => {
    let c = emptyChecklist();
    c = reduceChecklist(c, ev({ type: "agent_started", agentId: "editor" }));
    c = reduceChecklist(c, ev({ type: "agent_done", agentId: "editor", ok: true }));
    c = reduceChecklist(c, ev({ type: "agent_started", agentId: "gatekeeper" }));
    expect(c.order).toEqual(["editor", "gatekeeper"]);
    expect(c.status).toEqual({ editor: "done", gatekeeper: "running" });
    // A non-agent event leaves it unchanged (same reference).
    expect(reduceChecklist(c, ev({ type: "run_done", ok: true, resultRef: "r1" }))).toBe(c);
  });

  it("marks a failed agent and collapses a retry (failed then re-run → done)", () => {
    let c = emptyChecklist();
    c = reduceChecklist(c, ev({ type: "agent_done", agentId: "spotter", ok: false }));
    expect(c.status.spotter).toBe("failed");
    c = reduceChecklist(c, ev({ type: "agent_started", agentId: "spotter" }));
    c = reduceChecklist(c, ev({ type: "agent_done", agentId: "spotter", ok: true }));
    expect(c.order).toEqual(["spotter"]);
    expect(c.status.spotter).toBe("done");
  });
});

describe("consumeSseStream", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drives onEvent per frame and returns run_done with its resultRef", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse(
          [
            'data: {"type":"agent_started","agentId":"editor"}\n\n',
            'data: {"type":"agent_done","agentId":"editor","ok":true}\n\ndata: {"type":"run_done","ok":true,"resultRef":"r1"}\n\n',
          ],
          { "x-run-id": "run-1" },
        ),
      ),
    );
    const seen: string[] = [];
    const outcome = await consumeSseStream(
      { path: "/x", init: { method: "POST" } },
      signal(),
      (e) => seen.push(e.type),
    );
    expect(seen).toEqual(["agent_started", "agent_done", "run_done"]);
    expect(outcome).toEqual({ kind: "run_done", ok: true, resultRef: "r1" });
  });

  it("falls back to the X-Run-Id when run_done carries no resultRef", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse(['data: {"type":"run_done","ok":false}\n\n'], { "x-run-id": "run-9" }),
      ),
    );
    const outcome = await consumeSseStream({ path: "/x" }, signal(), () => {});
    expect(outcome).toEqual({ kind: "run_done", ok: false, resultRef: "run-9" });
  });

  it("returns http_error on a non-ok preflight (no stream)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    const outcome = await consumeSseStream({ path: "/x" }, signal(), () => {});
    expect(outcome).toEqual({ kind: "http_error", status: 503, detail: "nope" });
  });

  it("returns dropped (with run id) on EOF without a terminal run_done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse(['data: {"type":"agent_started","agentId":"editor"}\n\n'], {
          "x-run-id": "run-2",
        }),
      ),
    );
    const outcome = await consumeSseStream({ path: "/x" }, signal(), () => {});
    expect(outcome).toEqual({ kind: "dropped", runId: "run-2" });
  });
});

describe("AgentChecklist", () => {
  const checklist: Checklist = {
    order: ["editor", "spotter"],
    status: { editor: "done", spotter: "running" },
  };

  it("renders the status line, per-agent labels + glyphs, and the Stop hatch when live", () => {
    const html = renderToStaticMarkup(
      createElement(AgentChecklist, {
        checklist,
        statusLine: "Reviewing your CV…",
        label: (id: string) => (id === "editor" ? "Editor" : "AI-language"),
        onCancel: () => {},
        cancelLabel: "Stop",
      }),
    );
    expect(html).toContain("Reviewing your CV…");
    expect(html).toContain("Editor");
    expect(html).toContain("AI-language");
    expect(html).toContain("✓"); // editor done
    expect(html).toContain("Stop"); // escape hatch shown once live
    expect(html).toContain('aria-live="polite"');
  });

  it("hides the checklist + Stop before the first event (empty order)", () => {
    const html = renderToStaticMarkup(
      createElement(AgentChecklist, {
        checklist: emptyChecklist(),
        statusLine: "",
        label: (id: string) => id,
        busyLabel: "Starting…",
        onCancel: () => {},
      }),
    );
    expect(html).toContain("Starting…");
    expect(html).not.toContain("<li");
    expect(html).not.toContain("button");
  });
});
