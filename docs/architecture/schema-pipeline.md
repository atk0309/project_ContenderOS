# Schema Pipeline — Pydantic → OpenAPI → TypeScript

Status: active — seed doc  
Last updated: 2026-07-03

Pydantic is the single source of truth (ADR 0004). The frontend never hand-writes a CV/JobSpec/
Review interface — it imports generated types. One language boundary, one direction, machine-checked.

## Pipeline

1. Backend models live in `backend/app/schema/` (camelCase wire via `CamelModel`).
2. `uv run python -m app.export_openapi` builds the `FastAPI` object (no server, no DB) and writes
   the document to `frontend/openapi.json` (sorted keys → stable diffs). Completeness comes from the
   real typed routes (most models reach the document as request/response types) plus the
   `/meta/schema` codegen anchor (`SchemaBundle`), which pins models no route references yet.
3. `pnpm gen:types` runs `openapi-typescript ./openapi.json -o ./src/lib/api/generated-types.ts`.
4. The frontend consumes `components["schemas"]` via `src/lib/api/client.ts` (`Schemas` type).

## Drift guard

- Both artifacts (`frontend/openapi.json`, `frontend/src/lib/api/generated-types.ts`) are committed.
- The `schema-contract` doc-impact rule lights when `backend/app/schema/**` changes and requires both
  artifacts to move in the same change.
- The quality gate's **schema:no-drift** step regenerates both and runs `git diff --exit-code` — a
  Pydantic change that wasn't regenerated fails the gate.

## Rules

- Don't edit `generated-types.ts` by hand (biome-ignored; regenerate instead).
- Explicit `operation_id`s turned out not to be needed: the frontend consumes
  `components["schemas"]` only (never the operations), so generated operation names carry no weight.
- JSON-schema numeric/length constraints (e.g. `atsMatchScore` 0–100) are **not** enforced by the
  model — validate server-side after parse.
