// Thin fetch wrapper for the FastAPI backend. Auth rides an http-only cookie, so every call
// includes credentials. Request/response shapes come from the GENERATED types (never hand-written).
import type { components } from "./generated-types";

/** Every backend model, keyed by name — the single source of truth, generated from OpenAPI. */
export type Schemas = components["schemas"];

// Same-origin: the browser only ever talks to the frontend, which proxies /auth/* and /ai/* to the
// private backend (see lib/proxy.ts). Relative paths keep the session cookie SameSite=Lax and need
// no CORS. The cookie still rides every call, hence credentials: "include".
const API_BASE = "";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, detail || res.statusText);
  }
  return (await res.json()) as T;
}
