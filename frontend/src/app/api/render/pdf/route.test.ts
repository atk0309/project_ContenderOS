import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleRenderInput } from "@/render/fixtures";

// Fake Playwright: capture the cookies injected into the browser context (the auth handoff).
const h = vi.hoisted(() => {
  const addCookies = vi.fn();
  const pdf = vi.fn(async () => Buffer.from("PDF-BYTES"));
  const goto = vi.fn(async () => {});
  const emulateMedia = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const newPage = vi.fn(async () => ({ goto, emulateMedia, pdf }));
  const newContext = vi.fn(async () => ({ addCookies, newPage }));
  const launch = vi.fn(async () => ({ newContext, close }));
  return { addCookies, launch, newContext };
});

vi.mock("playwright", () => ({ chromium: { launch: h.launch } }));

import { GET } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function okExportFetch() {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(sampleRenderInput), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("GET /api/render/pdf", () => {
  it("injects the caller's session cookie into the Playwright context after the gate precheck", async () => {
    vi.stubGlobal("fetch", okExportFetch());
    const req = new Request("http://localhost:3000/api/render/pdf?cvId=cv-1", {
      headers: { cookie: "session=tok; other=x" },
    });

    const res = await GET(req);

    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(h.addCookies).toHaveBeenCalledTimes(1);
    expect(h.addCookies).toHaveBeenCalledWith([
      { name: "session", value: "tok", url: "http://localhost:3000" },
      { name: "other", value: "x", url: "http://localhost:3000" },
    ]);
  });

  it("relays a 409 from the gate WITHOUT launching Chromium", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ blockedBulletIds: ["b2"] }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const req = new Request("http://localhost:3000/api/render/pdf?cvId=cv-1", {
      headers: { cookie: "session=tok" },
    });

    const res = await GET(req);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: "render blocked", blockedBulletIds: ["b2"] });
    expect(h.launch).not.toHaveBeenCalled();
  });
});
