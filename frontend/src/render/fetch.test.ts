import { afterEach, describe, expect, it, vi } from "vitest";
import { getRenderBundle } from "./fetch";
import { sampleRenderInput } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getRenderBundle", () => {
  it("maps a 200 export bundle to a RenderInput and forwards the cookie", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(sampleRenderInput), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRenderBundle("cv-123", "session=abc");

    expect(result).toEqual({ ok: true, input: sampleRenderInput });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/workspaces/default/cv/cv-123/export"),
      { headers: { cookie: "session=abc" }, cache: "no-store" },
    );
  });

  it("maps a 409 to a blocked result carrying the blocking bullet ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ blockedBulletIds: ["b-netnew"] }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    const result = await getRenderBundle("cv-123", "session=abc");

    expect(result).toEqual({ ok: false, status: 409, blockedBulletIds: ["b-netnew"] });
  });

  it("relays other non-200 statuses (e.g. 403) as a blocked result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("forbidden", { status: 403 }))),
    );

    const result = await getRenderBundle("cv-123", "");

    expect(result).toEqual({ ok: false, status: 403, blockedBulletIds: [] });
  });

  it("returns a clean 502 (not a throw) when the backend is unreachable", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause }))),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getRenderBundle("cv-123", "session=abc");

    expect(result).toEqual({ ok: false, status: 502, blockedBulletIds: [] });
  });
});
