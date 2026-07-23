# ADR 0001: Split — FastAPI backend + Next.js frontend

Status: accepted  
Date: 2026-06-18

## Context

The product is AI-heavy (a multi-agent panel, async fan-out, SSE streaming). The operator wants the
backend and frontend kept as separate codebases (a workflow preference, mirroring another project).
A source harness existed as an all-TypeScript Next.js single service, but its **invariants** are
architecture-level and provider/runtime-agnostic.

## Decision

Two deployables in one private monorepo: a **FastAPI (Python)** backend for the agent panel,
persistence, auth, and the provenance gate; a **Next.js** frontend for the design-true UI **and** the
deterministic renderer. The frontend holds no business logic — all AI/data/auth is the backend.

## Options considered

- **All-TypeScript Next.js single service** — fastest to ship, no cross-language sync; rejected
  because the operator wants the split and Python is a strong fit for heavy async agent orchestration
  + Pydantic structured outputs.
- **FastAPI + Vite SPA + a separate Node render sidecar (3 services)** — purest separation, leanest
  bundle; rejected for ship-fast: triples the deploy surface and forces template sharing across a
  sidecar (see ADR 0002).
- **FastAPI + Next.js-as-frontend (chosen)** — 2 services; the renderer co-locates with the template
  so preview = PDF with no extra service; clean FE/BE separation.

## Consequences

- Cross-language schema risk is real → killed by ADR 0004 (Pydantic → OpenAPI → TS).
- The harness governance becomes per-service with a root orchestrator (`scripts/quality-gate.mjs`).
- Auth centralises in FastAPI (http-only cookie), CORS/SameSite per `security.md`.

## Links

`docs/invariants.md`, ADR 0002, ADR 0004, `docs/architecture/overview.md`.
