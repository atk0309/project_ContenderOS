# Architecture Overview

Status: active — seed doc  
Last updated: 2026-07-03

## What it is

A private, **single-user** CV-tailoring cockpit: every allowlisted account is an owner of the one
workspace (the human-reviewer concept is gone — the AI panel is the only reviewer). Two
deployables:

- **Backend** (`backend/`, FastAPI) — the judgment half: the multi-agent panel (Claude authoring,
  OpenAI adjudication), persistence, Microsoft 365 auth, and the server-side provenance gate. Emits
  schema-constrained JSON only.
- **Frontend** (`frontend/`, Next.js) — the design-true UI **and** the deterministic renderer. One
  React `ResumeTemplate` drives both the live preview and the Playwright print-to-PDF; DOCX comes
  from the same JSON. Holds no business logic — all AI/data/auth is the backend.

Postgres for persistence. Two model providers (Anthropic + OpenAI). Session-cookie auth gates every
AI / workspace / admin route — both sign-in paths (magic-link via Resend, M365 SSO via Entra)
converge on the one server-signed session cookie; only health, the schema-export anchor, and the
sign-in/sign-out surface itself are unauthenticated (see `security.md`).

## The core principle

Judgment is split from rendering (invariant 1). AI emits typed JSON (`backend/app/schema/`);
deterministic code renders documents (`frontend/src/render/`). Same JSON → stable PDF/DOCX for a
pinned toolchain. Models never *emit* document bytes — a source PDF may be *read* by the ingestion
Extractor (ADR 0007), but no model produces a `.docx` / finished document. See `docs/invariants.md`.

## Components

- **Backend** — `app/schema/` (Pydantic source of truth), `app/ai/{providers,agents}` (the review
  fan-out orchestrator is `agents/review.py`), `app/routes/`, `app/persistence/`, `app/auth/`.
- **Frontend** — `src/render/` (the one template + render routes), `src/app/` (screens; the authed set
  lives under the `(app)/` shell route group), `src/ui/` (shared presentational primitives — Button /
  IconButton / Card / PageHeader / Field / Banner / Tag / Switch / Segmented / Gauge / VerdictPill /
  AgentBadge / AgentChecklist / StageDots, plus `colors.ts` the single agent-identity + verdict-colour
  source; previewed
  at the dev-only `/design` route), `src/slop/` (client-side heuristics), `src/lib/api/`
  (generated types + client).
- **Persistence** — Postgres, ten tables (`jsonb` document blobs where the entity is a document;
  scalar rows elsewhere, except `provider_models`' cached model list — a JSON column): `stored_masters`,
  `cv_job_specs`, `stored_cvs` + the scalar
  `cv_labels`, `cv_reviews` (the persisted latest review run — the AI review threads live inside its
  `ReviewBundle` JSON, never a table of their own), `stored_applications`, the ingestion pair
  `ingestion_runs` / `ingestion_proposals` (ADR 0007/0008), and the global (not workspace-scoped)
  admin provider config `provider_secrets` / `provider_models` (ADR 0006). Column detail:
  `data-model.md` §Storage models (the current source).

## Schema contract

Pydantic is the single source of truth (ADR 0004). FastAPI emits OpenAPI → `openapi-typescript`
generates the frontend types. The gate fails on drift. See `schema-pipeline.md`.

## Runtime dependencies

(Keep current — `dependency-change` doc rule.) Backend: fastapi, pydantic, pydantic-settings,
uvicorn, anthropic, openai, sqlalchemy[asyncio], asyncpg, cryptography (Fernet — provider-key
encryption, ADR 0006), authlib, itsdangerous, httpx, python-multipart (PDF-upload form parsing),
pypdf (PDF→text for the ingest audit/evidence copy + the upload page/size guard — NOT the extraction
path, which is Claude's native document block, ADR 0007); dev adds aiosqlite (offline test DB). No
Alembic yet (`create_all`). Frontend: next, react, react-dom (+ docx/playwright in the render phase).

## Diagrams

Still open (as of 2026-07-03 — no diagram exists yet): add a system-context diagram under
`docs/diagrams/system-context.mmd` and link it from `README.md` + `index.html` (the `new-diagram`
doc rule).
