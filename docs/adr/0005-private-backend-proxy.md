# ADR 0005: Private backend behind the Next.js proxy

Status: accepted  
Date: 2026-06-18

## Context

Contender is a private, two-person tool with a real CV (and provider API keys, the AI panel, and
the provenance gate) behind it. The auth gate (ADR-adjacent, see `security.md`) protects access, but
the FastAPI backend was still a second public service on Railway — directly reachable by the browser
(`NEXT_PUBLIC_API_BASE`) and therefore by anyone on the internet, gated only by the cookie check.
The operator asked to keep the backend off the public internet so only the frontend can reach it.

Railway provides **private networking**: services in a project reach each other over an internal
`*.railway.internal` host that is not routable from the public internet — and crucially not from a
browser. So "browser talks to backend directly" and "backend is private" are mutually exclusive.

## Decision

Make the **frontend the only public service**. The browser talks only to the frontend origin; the
Next.js *server* reverse-proxies `/auth/*` and `/ai/*` to the backend over Railway's private network
(`BACKEND_INTERNAL_URL`, server-only, never `NEXT_PUBLIC`). The backend has **no public domain**.

## Options considered

- **Backend public, behind the gate (status quo)** — simplest, nothing to build; rejected because it
  leaves the backend (keys, agents, gate) on the public internet, protected by a single cookie check.
- **Public domain firewalled to the frontend** — Railway has no per-service IP allowlist on public
  domains, so not available.
- **Private backend + Next proxy (chosen)** — backend off the public internet; the browser is
  same-origin with the frontend, so the session cookie is `SameSite=Lax` and CORS disappears. Cost:
  a thin proxy layer (`lib/proxy.ts` + `app/{auth,ai}/[...path]/route.ts`) that must stream (SSE) and
  pass `Set-Cookie` + 3xx through, and the auth redirect URLs move to the frontend domain.

## Consequences

- The only public surface is the frontend; provider keys / AI panel / provenance gate are never
  directly reachable. Smaller attack surface (invariant 4 reinforced).
- Cookie simplifies to `SameSite=Lax`, `COOKIE_SECURE=true`; CORS becomes defensive-only.
- Browser-facing redirects move to the frontend: magic-link callback and the **Entra redirect URI**
  are now `<FRONTEND_BASE_URL>/auth/entra/callback` (re-register in Entra). `API_BASE_URL` is gone.
- The proxy must stream the upstream body so the coming SSE review fan-out passes through unbuffered;
  route handlers run on the **Node** runtime (the Edge runtime can't reach internal IPv6 hosts).
- Local dev is identical to prod: set `BACKEND_INTERNAL_URL` to the dev backend; the browser stays
  same-origin via the proxy.

## Links

`frontend/src/lib/proxy.ts`, `frontend/src/app/{auth,ai}/[...path]/route.ts`,
`docs/architecture/security.md`, `docs/architecture/deployment.md`, ADR 0001, `docs/invariants.md`.
