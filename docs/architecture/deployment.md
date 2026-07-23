# Deployment

Status: active — seed doc  
Last updated: 2026-07-23

Update when a `*/.env.example` changes (`env-vars-changed`).

## Target

Railway: **two services from the one monorepo** + managed Postgres. One repo, deployed twice —
each Railway service sets its **Root Directory** (`backend/` or `frontend/`) and builds that subtree's
own Dockerfile. **Only the frontend is public** (ADR 0005).

- **backend** — Root Directory `backend/`, `backend/Dockerfile` (`python:3.14-slim`, uvicorn). No
  Chromium here. **No public domain** — do *not* generate one in Railway. Reachable only on the
  private network as `backend.railway.internal:8000`. **Must bind `::`** (the Dockerfile does):
  Railway's private network is IPv6-only, so a `0.0.0.0`-only listener is unreachable by the proxy.
- **frontend** — Root Directory `frontend/`, `frontend/Dockerfile` (`node:26`, Next.js) **+ Playwright
  Chromium** for the PDF render route. The build runs `pnpm gen:types && pnpm build` then
  `playwright install --with-deps chromium` — **no fallbacks**: a stale lockfile or a failed
  Chromium install fails the build rather than shipping an image whose `/api/render/pdf` breaks
  at runtime. This is the only service with a public domain.

Both Dockerfiles pin their base/tool images **immutably — version tag AND digest** (a bare version
tag still floats; invariant 3 pins the render toolchain). Dependabot's `docker` ecosystem owns the
digest bumps, and its `github-actions` ecosystem keeps the CI actions patched
(`.github/dependabot.yml`).

### Private backend + proxy (ADR 0005)

The browser talks **only** to the frontend; the Next.js server reverse-proxies `/auth/*`, `/ai/*`,
`/workspaces/*`, and `/admin/*` to `backend.railway.internal` over Railway's private network
(`frontend/src/lib/proxy.ts` + the four `[...path]/route.ts` catch-alls). Set
`BACKEND_INTERNAL_URL` on the frontend to the internal host
(e.g. `http://backend.railway.internal:8000`); it is **server-only**, never `NEXT_PUBLIC`. Because
the browser is same-origin with the frontend, the session cookie is `SameSite=Lax` and CORS is
unused. There is no reverse (backend → frontend) hop: the backend never calls the render routes
(ADR 0010 retired that idea), so no internal render URL is configured.

## Logging

Railway colours each log line by which **stream** it came from. Uvicorn writes every level
(including `INFO`) to **stderr**, so without configuration routine lifecycle lines ("Application
startup complete", "Started server process", "Shutting down") show up red as "error" in the log
viewer even though nothing failed.

The backend ships structured **JSON** logging so Railway parses the real `level` from the payload
instead of the stream. Uvicorn applies it at boot via `--log-config log_config.json` (in the
Dockerfile CMD), so even its earliest lines are JSON. The formatter is `app/logging_config.py`
(stdlib only — no dependency). The `LOG_FORMAT` env var selects the format: `json` (structured) or
`console` (readable plain lines); empty derives from `ENVIRONMENT` (console in development, json
otherwise). Local dev gets readable logs by default; Railway gets JSON.

## Playwright / Chromium (known gotcha)

The PDF renderer needs Chromium system deps not in the default image (`libnss3` et al.). The
frontend Dockerfile runs `playwright install --with-deps chromium`, or `render/pdf` fails at runtime
with a missing-library error. Pin the Chromium version and bundle fonts so PDFs are stable
(invariant 3).

## Environment variables

See `backend/.env.example` and `frontend/.env.example` for the full contract. Set each on the
respective Railway service. (`RENDER_INTERNAL_BASE` is gone from the frontend contract — it
described a backend render client that was never built, ADR 0010; a stale Railway var with that
name is inert.)

**Provider keys + model ids are NOT env vars** — they're managed in the owner-only Admin Menu
(encrypted in the DB; ADR 0006). Legacy `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `*_MODEL_*` env
vars have no Settings fields anymore; unknown env keys are ignored (`extra="ignore"`), so stale
Railway vars with those names are harmless. Two backend vars are required outside development (the
app **fails closed** at startup without them):

- **`SECRETS_ENCRYPTION_KEY`** — the Fernet master key that encrypts the stored provider keys. The
  only provider secret left in env. Generate with
  `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
  Rotating it invalidates stored keys (re-enter them in the menu).
- **`DATABASE_URL`** — point at the managed Postgres: `DATABASE_URL=${{ Postgres.DATABASE_URL }}`
  works directly (the app normalizes the `postgresql://` scheme to `postgresql+asyncpg://`).

### First-run bootstrap (after the DB phase deploys)

Provision the managed Postgres + set the two vars above **before** deploying this change, or the
container fails to start by design. Then, once up: sign in as the owner → open `/admin` → for each
provider, paste the API key (it's validated + the model list is pulled) → assign a model to each
tier (`strong`/`fast`/`cheap`). Until a provider's key + the needed tier are set, the AI routes that
use it return **503** ("configure the provider in the admin menu") — correct fail-closed behaviour.

## CI and protecting `main`

`.github/workflows/ci.yml` runs `node scripts/quality-gate.mjs --fail-on-gap` (both service gates +
the schema no-drift check) on every PR and on push to `main`. **CI does not deploy** — it's the
safety net. A Railway project deploys only after an operator connects and configures it.

`.github/workflows/codeql.yml` separately scans both `python` and `javascript-typescript` with the
`security-extended` query suite on PRs, pushes to `main`, and a weekly schedule. Keep that workflow
enabled anywhere the `main` ruleset requires CodeQL; a CodeQL rule with no producing workflow leaves
the repository protected in name but without an analysis result.

To make deploys to `main` trustworthy, do **both**:

1. **Branch protection on `main`** (GitHub → Settings → Branches → add rule for `main`): require a
   pull request before merging, require the **`gate`** status check and CodeQL analysis to pass, and
   block direct/force pushes. Now red code cannot reach `main`.
2. **Railway: wait for CI** — in the Railway service settings, enable "Wait for CI" / check-suite
   gating so Railway only deploys a commit whose GitHub checks passed. (Belt-and-braces for any
   direct-to-`main` path.)

Flow: branch → PR → CI `gate` runs → must be green to merge → merge to `main` → Railway deploys the
green commit. Each Railway service deploys from its own Dockerfile, selected by the service's
**Root Directory** in the Railway dashboard — there is deliberately **no `railway.toml`**: the
config-as-code schema describes a single deployment per file, so a root multi-`[[services]]` file
was never parsed by Railway and could only drift from the real dashboard setup.

## Auth setup

Both sign-in paths are server-side; see `security.md` for the model. Required on the **backend**
service: `AUTH_SECRET` (`openssl rand -hex 32` — signs the session cookie **and** magic tokens;
the app **fails closed** without it outside `ENVIRONMENT=development`), `ALLOWLIST_EMAILS` (every
entry is an owner account; removing an entry revokes that account with a **403** on its next
request), `FRONTEND_BASE_URL` (the public frontend URL — the base for all browser redirects),
and the cookie pair (`COOKIE_SAMESITE=lax`/`COOKIE_SECURE=true`). On the **frontend**:
`BACKEND_INTERNAL_URL` (the private backend host). There is no `API_BASE_URL`/`NEXT_PUBLIC_API_BASE`
in the private-backend topology.

- **Magic link (Resend).** Set `RESEND_API_KEY` and `RESEND_FROM` (must be a Resend-verified domain
  to deliver to arbitrary inboxes). With no key the link is logged, not sent (dev only). The emailed
  link points at `<FRONTEND_BASE_URL>/auth/magic/callback` (proxied to the backend).
- **M365 SSO (Entra).** Optional. The app boots without it; the Entra routes fail closed (**503**)
  until all three `AUTH_MICROSOFT_ENTRA_ID_*` vars are set, while magic-link remains the other
  sign-in path. Register an app in your Entra tenant and set the redirect URI to
  **`<FRONTEND_BASE_URL>/auth/entra/callback`** (it must match exactly).

See `backend/.env.example` and `frontend/.env.example` for the full contract.
