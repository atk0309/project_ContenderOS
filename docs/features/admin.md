# Feature: Admin Menu (provider keys + model tiers)

Status: shipped (open items live under Known limitations)  
Last updated: 2026-07-03

> The design/route mechanics live elsewhere — this page is the user-facing flows only. Contract:
> [ADR 0006](../adr/0006-db-encrypted-provider-secrets.md) (admin-managed provider config); routes:
> `docs/architecture/api.md` §Admin; reskin + named divergences: `docs/architecture/design-system.md`
> §Admin editor (C3).

## Purpose

Provider API keys and model choices are runtime, owner-managed state — never env vars or client
code (invariant 4). This screen (`/admin`) is where the owner pastes each provider's key
(stored DB-encrypted, write-only) and assigns a model to each tier, unlocking the AI routes.

## User-facing behaviour

- **Route `/admin`** (every allowlisted account is an owner). Every `/admin/*` API route mounts
  behind `require_owner` (non-allowlisted → 403, the defense-in-depth re-check); the screen is
  linked from the rail and from the "Set up AI" pill.
- **Per-provider cards (Anthropic, OpenAI):** paste a key → it is **validated against the live
  provider before storing** (a rejected key → 400, nothing stored; the field clears on save and the
  card only ever shows a masked is-set status — keys are write-only). **Sync models** pulls the
  provider's model list (409 "Set the provider key first" when keyless); **tier assignment** maps
  `strong`/`fast`/`cheap` to a synced model id (409 "Sync models first"; a model id not in the
  synced list → 422). The API also supports key delete (`DELETE .../key`), but the screen has no
  delete control — replace a key by pasting a new one.
- **AI-readiness linkage:** the rail's "AI ready" / "Set up AI" pill and the Workspace's
  Tailor/Review gating derive from this screen's state (`GET /admin/providers` → key set + a
  strong-tier model per needed provider). Until a **required** provider is configured, the AI
  routes that preflight it return **503** (tailor → Anthropic; the review fan-out → both; ingest →
  Anthropic) — this screen is the fix the 503 points at. Advisory paths never block: the ingestion
  Judge (OpenAI) degrades to "suggestions unavailable" instead of 503ing the run.
- **"Reviewer powers" grid is a skin-only preview** (invariant 2): the per-agent
  active/strictness/blocking controls are local state wired to no endpoint, labelled
  "Preview · not enforced" with a not-saved caveat — only the owner's sign-off blocks export,
  and there is no per-agent strictness store.
- States: loading / forbidden (non-owner) / per-card busy (key / sync / tiers single-flight) /
  key-rejected 400 / sync-409 / tier-422 / saved.

## Implementation

- `frontend/src/app/(app)/admin/page.tsx` (+ the `/admin/[...path]` proxy route). Backend:
  `backend/app/routes/admin.py`, key crypto in `app/persistence/crypto.py` (Fernet via
  `SECRETS_ENCRYPTION_KEY`). See ADR 0006 for the design; `deployment.md` §First-run bootstrap for
  the production walk-through.

## Data model

- `provider_secrets` (encrypted key per provider) + `provider_models` (tier→model map + the cached
  synced model list) — global tables, deliberately not workspace-scoped. Wire models:
  `AdminStatus` / `AdminProviderStatus` / `ProviderKeyStatus` / `ProviderModelStatus` /
  `SyncModelsResponse` / `SetTiersRequest`. See `docs/architecture/data-model.md`.

## Tests

- Backend `backend/tests/test_admin.py` — owner-only, key validate/store/mask, sync + tier flows,
  the 400/409/422 arms. Frontend behaviour is Playwright-verified (the C3 reskin rubric).

## Decisions & trade-offs

- **Keys are write-only + DB-encrypted** (ADR 0006): no reveal, no "kept on this device"; rotating
  `SECRETS_ENCRYPTION_KEY` invalidates stored keys (re-enter them in the menu).
- **Tiers, not pinned models:** agents declare a tier; the owner can swap models without a deploy.
  Tiers are strong-only today (see `docs/ai-panel.md` §Model selection).

## Known limitations & follow-ups

- [ ] "Reviewer powers" stays a non-persisted preview until a real per-agent policy store exists.
- [ ] Assigning `fast`/`cheap` has no effect until an agent declares a non-strong tier.
- [ ] No key-delete control in the UI (the `DELETE` route exists; pasting a new key replaces).
