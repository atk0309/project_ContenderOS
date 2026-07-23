# ADR 0004: Pydantic is the single source of truth; TS is generated

Status: accepted  
Date: 2026-06-18

## Context

A split FE/BE introduces a language boundary. Maintaining parallel Pydantic (Python) and Zod
(TypeScript) schemas guarantees drift — a field added on one side and forgotten on the other ships a
broken contract.

## Decision

**Pydantic is the single source of truth.** FastAPI emits OpenAPI from the models;
`openapi-typescript` generates `frontend/src/lib/api/generated-types.ts`. The frontend imports those
types and never hand-writes a CV/JobSpec/Review interface. Zod, if used at all, is a thin local guard
for the slop-heuristic input and optimistic edits — not a parallel schema.

## Options considered

- **Parallel Pydantic + Zod** — rejected: guaranteed drift, double maintenance.
- **Generate TS from OpenAPI (chosen)** — one source, one direction, machine-checked. The
  `schema-contract` doc rule + the gate's no-drift step keep them in lockstep.

## Consequences

- `frontend/openapi.json` + `generated-types.ts` are committed; the gate regenerates and fails on
  drift.
- `origin` / `needsSignoff` / sign-off remain server-derived and are never trusted from the client,
  regardless of the shared types.

## Links

`docs/architecture/schema-pipeline.md`, `backend/app/export_openapi.py`,
`frontend/src/lib/api/client.ts`.
