/**
 * Server-only: fetch the gate-checked render bundle for a CV from the private backend.
 *
 * The renderer needs {master, cv}; the backend's owner-only `GET /workspaces/{ws}/cv/{id}/export`
 * returns it ONLY when the provenance gate is clear (invariant 2) — otherwise a 409 listing the
 * bullets still awaiting sign-off. This forwards the caller's session cookie (auth is server-side;
 * the cookie never leaves the server) and reuses the same backend base URL as the proxy. Never
 * imported into a client component (it reads BACKEND_INTERNAL_URL and forwards cookies — like
 * lib/proxy.ts, it only ever runs in Node server components / route handlers).
 */
import type { components } from "@/lib/api/generated-types";
import { BACKEND } from "@/lib/proxy";
import type { RenderInput } from "./model";

// One workspace today (the backend seeds `default`); resolved server-side, never client-trusted.
// TODO: thread a real workspace id through once multi-workspace lands.
export const DEFAULT_WORKSPACE_ID = "default";

type ExportBlocked = components["schemas"]["ExportBlocked"];

export type RenderFetch =
  | { ok: true; input: RenderInput }
  | { ok: false; status: number; blockedBulletIds: string[] };

function logField(value: unknown): string {
  return String(value)
    .replace(/\n/g, "")
    .replace(/[\r\u2028\u2029]/g, "");
}

/**
 * Fetch {master, cv} for `cvId`, forwarding `cookieHeader` for auth. `ok:false` carries the upstream
 * status (409 = needs sign-off, with the blocking bullet ids; 401/403/404 otherwise) so callers can
 * render a blocked state or relay the status without producing an artifact. An unreachable backend
 * (bad `BACKEND_INTERNAL_URL`, ECONNREFUSED) becomes a clean `502` — mirroring `lib/proxy.ts`, so the
 * export paths fail consistently instead of throwing a Next 500.
 */
export async function getRenderBundle(
  cvId: string,
  cookieHeader: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<RenderFetch> {
  const url = `${BACKEND}/workspaces/${encodeURIComponent(workspaceId)}/cv/${encodeURIComponent(cvId)}/export`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: "no-store",
    });
  } catch (err) {
    // Upstream connection failure (backend down/unreachable, ECONNREFUSED, DNS). Log the workspace +
    // cv id only — never the cookie. Don't let it bubble as a Next 500; relay a clean 502.
    console.error(
      "render fetch: upstream export failed workspace=%s cv=%s error=%s",
      logField(workspaceId),
      logField(cvId),
      logField(err),
    );
    return { ok: false, status: 502, blockedBulletIds: [] };
  }

  if (res.ok) {
    return { ok: true, input: (await res.json()) as RenderInput };
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as Partial<ExportBlocked>;
    return { ok: false, status: 409, blockedBulletIds: body.blockedBulletIds ?? [] };
  }
  return { ok: false, status: res.status, blockedBulletIds: [] };
}
