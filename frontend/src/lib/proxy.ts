// Server-side reverse proxy: browser -> Next.js -> FastAPI over Railway's PRIVATE network.
// The backend has no public domain; the frontend is the only public surface. This keeps the
// browser same-origin (cookie SameSite=Lax, no CORS) and the provider keys / AI panel / provenance
// gate off the public internet. Runs only in Node route handlers (never shipped to the client).
import type { NextRequest } from "next/server";

// Internal-only; NOT NEXT_PUBLIC, so it never reaches the client bundle. In prod this is the
// Railway internal host (e.g. http://backend.railway.internal:8000); locally, the dev backend.
// Exported so server-side render fetches (render/fetch.ts) reach the backend the same way.
export const BACKEND = process.env.BACKEND_INTERNAL_URL ?? "http://127.0.0.1:8000";

// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1); content-length/encoding are recomputed
// by the runtime from the (possibly decoded) body, so dropping them avoids a mismatch.
const STRIP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);

/**
 * Forward `req` to `${BACKEND}/${prefix}/${path}` preserving method, query, body, and cookies, and
 * stream the upstream response straight back (works for JSON and SSE alike). `redirect: "manual"`
 * lets the backend's 303s (magic-link / Entra callbacks) reach the browser with their Set-Cookie.
 */
export async function proxyToBackend(
  req: NextRequest,
  prefix: string,
  path: string[],
): Promise<Response> {
  const url = `${BACKEND}/${prefix}/${path.join("/")}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch (err) {
    // Upstream connection failure (backend down/unreachable, ECONNREFUSED, DNS). Don't let it throw
    // unhandled and take the request — or the process — down; log and return a clean 502 Bad
    // Gateway. Log only prefix+path, never req.nextUrl.search: magic-link/Entra callbacks carry
    // single-use tokens in the query string.
    console.error(`proxy: upstream ${req.method} ${prefix}/${path.join("/")} failed`, err);
    return new Response(JSON.stringify({ detail: "Upstream backend unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP.has(key.toLowerCase()) && key.toLowerCase() !== "set-cookie") out.set(key, value);
  });
  // Headers.forEach collapses multiple Set-Cookie into one; re-append each separately. (getSetCookie
  // is cast for older TS DOM libs that don't declare it; it exists on the undici runtime Headers.)
  const setCookies = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  for (const cookie of setCookies?.call(upstream.headers) ?? []) out.append("set-cookie", cookie);

  return new Response(upstream.body, { status: upstream.status, headers: out });
}
