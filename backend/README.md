# Contender — backend (FastAPI)

The judgment half of the app: the AI agent panel (Claude authoring, OpenAI adjudication),
persistence, Microsoft 365 auth, and the server-side provenance/sign-off gate. It emits
schema-constrained JSON only — it never renders documents (that's the frontend service).

## Setup

```bash
uv sync --extra dev          # create the venv + install deps
cp .env.example .env         # set SECRETS_ENCRYPTION_KEY, AUTH_SECRET, DB URL, ALLOWLIST_EMAILS;
                             # provider API keys go in the owner-only Admin Menu (ADR 0006), not env
uv run uvicorn app.main:app --reload
```

## Quality gate (backend half)

```bash
uv run ruff check . && uv run mypy && uv run pytest
```

Run from the repo root with `node scripts/quality-gate.mjs` to gate both services at once.

## OpenAPI → frontend types

Pydantic (`app/schema/`) is the single source of truth. Regenerate the frontend contract after
any schema change:

```bash
uv run python -m app.export_openapi    # writes ../frontend/openapi.json
```
