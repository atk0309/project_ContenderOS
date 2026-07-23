# AGENTS.md — backend (FastAPI)

Nested guidance for the `backend/` subtree. The root `AGENTS.md` holds the invariants and the
cross-service quality gate; this file holds only backend toolchain + rules. Session instructions
and the root file override this where they conflict.

## Stack

FastAPI + Pydantic v2, async SQLAlchemy + asyncpg (Postgres), Authlib (Entra ID). Python 3.14 (pinned by backend/.python-version — local, CI, and Docker all resolve the same interpreter).
Package/venv via `uv`. Lint/format `ruff`, typecheck `mypy --strict`, test `pytest`.

## Commands

| Purpose | Command |
|---|---|
| Install deps | `uv sync --extra dev` |
| Lint / format | `uv run ruff check .` / `uv run ruff format .` |
| Typecheck | `uv run mypy` |
| Test | `uv run pytest` |
| Export OpenAPI for the frontend | `uv run python -m app.export_openapi` |
| Backend gate (what root gate runs) | `uv run ruff check . && uv run mypy && uv run pytest` |

## Rules

- **Pydantic is the single source of truth** (`app/schema/`). Never hand-write a parallel shape.
  Changing `app/schema/**` means regenerating `frontend/openapi.json` + the frontend types
  (`uv run python -m app.export_openapi`) in the same change — the `schema-contract` doc rule
  enforces it.
- Route handlers stay thin; logic lives in `app/`. AI calls go only through `app/ai/providers/`;
  new agents register in `app/ai/agents/registry.py` and are documented in `docs/ai-panel.md`.
- Enforce auth, **per-workspace ownership/isolation** (invariant 8), and the **provenance/sign-off
  gate** server-side. The sign-off gate is `TailoredCV.needs_signoff()` (`app/schema/tailored.py`);
  `export_cv` (`app/routes/cv.py`) refuses with **409** while it is true (locked by the export-409
  tests in `tests/test_cv.py`). Never trust client-supplied `origin` / `needsSignoff` /
  scores — and never a client-asserted identity: membership + the allowlist are re-derived from
  the session per request.
- Surface agent failures (refusal / truncation / schema-parse-fail) explicitly — a silent failure
  that ships a malformed CV is worse than a loud one. Log agent id, provider, model, tokens,
  latency, outcome.
- Provider keys + model ids are admin-managed (DB-encrypted keys, per-tier model selection — ADR
  0006); the only provider secret in env is `SECRETS_ENCRYPTION_KEY`. Agents declare a tier, not a
  model string; `/admin/*` is owner-gated (`require_owner`).
- Tests run offline — no live provider keys, no live DB. Use fakes.
