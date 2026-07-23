import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyToBackend } from "./proxy";

// Minimal NextRequest stand-in: proxyToBackend only touches method, headers, nextUrl.search, and
// arrayBuffer(). Casting keeps the test focused on the proxy's failure/success branching.
function fakeRequest(method = "GET", search = ""): NextRequest {
  return {
    method,
    headers: new Headers(),
    nextUrl: { search },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as NextRequest;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("proxyToBackend", () => {
  it("returns a 502 (not a throw) when the upstream connection is refused", async () => {
    // Shape mirrors Node's undici "fetch failed" -> AggregateError(ECONNREFUSED) seen in prod logs.
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause }))),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await proxyToBackend(fakeRequest("GET"), "auth", ["me"]);

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ detail: "Upstream backend unavailable" });
  });

  it("does not log the query string (single-use tokens) on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await proxyToBackend(fakeRequest("GET", "?token=secret-magic-link"), "auth", ["callback"]);

    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret-magic-link");
  });

  it("passes the upstream response through when the backend is reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    const res = await proxyToBackend(fakeRequest("GET"), "auth", ["me"]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
