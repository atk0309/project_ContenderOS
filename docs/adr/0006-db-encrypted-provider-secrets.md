# ADR 0006: Admin-managed provider config (DB-encrypted keys + dynamic model tiers)

Status: accepted  
Date: 2026-06-18

## Context

Provider API keys and model ids were env-only (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_*`, …). For a
2-seat private app the operator wants to manage them from an in-app **Admin Menu**, not the Railway
dashboard, and to pick models from the provider's *live* catalogue rather than pinned strings that
go stale. This touches invariants 4 (keys server-side) and 5/6 (model pinning).

## Decision

- **Keys move to the DB, encrypted at rest** (Fernet). The only provider secret left in env is the
  master key `SECRETS_ENCRYPTION_KEY` (fail-closed outside development, like `AUTH_SECRET`). Keys are
  **write-only** from the UI: typed in the browser, sent over the same-origin proxy, encrypted
  server-side, and **never returned** — the API exposes only `isSet` + a masked `last4`.
- **Models are dynamic.** Saving a key validates it by calling the provider's list-models endpoint
  and caches the result; the owner assigns each **tier** (`strong`/`fast`/`cheap`) from that live
  list. Agents declare a *tier*, resolved to a concrete model id at call time
  (`app/ai/agents/registry.py`). No model string is pinned in code.
- **Persistence is minimal.** Two tables (`provider_secrets`, `provider_models`) created via
  `Base.metadata.create_all` on startup. **No Alembic yet** (see below).

## Options considered

- **Keep keys in env** — simplest, but the operator can't manage them in-app and rotation means a
  redeploy. Rejected: it's the explicit product ask.
- **Plaintext keys in Postgres** — simpler than encryption, relies solely on DB-at-rest. Rejected:
  cheap to encrypt (Fernet, already in the lockfile via authlib), and defence-in-depth is warranted
  for third-party credentials.
- **Encrypted keys in Postgres + dynamic tiers (chosen)** — keys never leave the server in the
  clear, the master key is the single env secret, models reflect reality. Cost: a DB layer and a
  startup master-key requirement.
- **Alembic from day one** — full migration history. Rejected for now: two additive tables, two
  users, one deployer. `create_all` is the laziest correct choice (AGENTS §1).

## Consequences

- **Invariant 4 is reworded** (not weakened): keys are still server-side-only — *never bundled in
  client JS, never persisted client-side, never returned unmasked, encrypted at rest* — but they no
  longer "live in the FastAPI env"; the master key does. **Invariants 5/6**: model ids are resolved
  from the DB tier map, still "config not code."
- **Fail-closed startup**: outside development the app refuses to boot without `SECRETS_ENCRYPTION_KEY`
  and `DATABASE_URL`. Rotating the master key invalidates stored keys (re-enter in the menu).
- **Schema changes are additive-only** (new tables / nullable columns) applied by `create_all` on
  deploy; any destructive or shape-changing migration is **manual** until Alembic is adopted —
  adopting Alembic is the trigger to revisit this decision.
- **Misconfiguration is a 503, not a 500.** Missing key / unset tier / decrypt failure map to 503
  ("fix it in the admin menu"); provider rejection/network → 502; refusal → 422; truncation/parse →
  502 (a model that can't do structured output lands here cleanly). Handlers in `app/main.py`.
- `models.list()` returns everything the key can access (not all structured-output capable) — the
  list is filtered best-effort + the UI states the capability caveat.

## Links

- `backend/app/persistence/{engine,models,crypto,provider_store}.py`, `app/ai/providers/clients.py`
- `backend/app/routes/admin.py`, `frontend/src/app/admin/`
- Invariants 4/5/6 (`docs/invariants.md`); `docs/architecture/{data-model,api,security,deployment}.md`
- ADR 0005 (private backend proxy — how the browser reaches `/admin/*`).
