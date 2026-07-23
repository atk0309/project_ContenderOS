# Project Documentation

Source of truth for project documentation. Agents update it as they build. Every meaningful change
should leave this directory more accurate than it found it. If implementation and docs disagree,
investigate and fix — lying docs are worse than missing docs.

## Start here

- [Invariants](invariants.md) — the contract that must not break.
- [Architecture overview](architecture/overview.md)
- [AI panel](ai-panel.md) — the product's reviewer agents + how agents are defined.
- [Testing strategy](testing/strategy.md) — the local quality-gate contract.
- [Agent guidance changelog](agent-guidance-changelog.md)

## Local quality gate

Run `node scripts/quality-gate.mjs` before declaring non-trivial work complete. GitHub Actions are
**not** the agent quality gate. See the [testing strategy](testing/strategy.md).

## Architecture

- [Overview](architecture/overview.md) — components, the judgment/rendering split.
- [Data model](architecture/data-model.md) — schemas, storage, versioning, stable ids.
- [API and integrations](architecture/api.md) — route handlers, the agent endpoints, the providers.
- [Security](architecture/security.md) — M365 auth, the allowlist, the provenance gate.
- [Deployment](architecture/deployment.md) — Railway (2 services), Chromium, env vars.
- [Observability](architecture/observability.md) — agent-call logging, per-job cost.
- [Renderer](architecture/renderer.md) — the single-template preview=PDF guarantee.
- [Schema pipeline](architecture/schema-pipeline.md) — Pydantic → OpenAPI → TypeScript.
- [Design system](architecture/design-system.md) — the fidelity contract: tokens, type, motion, the agent-identity map, the machine guard + per-screen rubric. Canonical mockups vendored in [`design/`](design/).

## Decisions

- [ADR 0001: Split — FastAPI + Next.js](adr/0001-split-fastapi-frontend.md)
- [ADR 0002: Renderer — Next.js co-located](adr/0002-renderer-nextjs-colocated.md)
- [ADR 0003: Stable-id anchoring](adr/0003-stable-bullet-id-anchoring.md)
- [ADR 0004: Pydantic source of truth](adr/0004-pydantic-source-of-truth.md)
- [ADR 0005: Private backend behind the Next.js proxy](adr/0005-private-backend-proxy.md)
- [ADR 0006: DB-encrypted provider keys + dynamic model tiers](adr/0006-db-encrypted-provider-secrets.md)
- [ADR 0007: Native PDF ingestion via Claude document blocks](adr/0007-native-pdf-extraction.md)
- [ADR 0008: Ingestion reconciliation — classify-by-index, server-built, two-phase grounding](adr/0008-ingestion-reconciliation.md)
- [ADR 0009: Application tracking — derived CV lock + immutable applied snapshot](adr/0009-application-lock-cv-immutability.md)
- [ADR 0010: AI Review Panel — transient reviews, workspace-scoped grounded routes, JobSpec snapshot](adr/0010-review-panel-transient-grounded.md)
- [ADR 0011: Design system as a verifiable contract; Gatekeeper/Diff as transient per-CV views](adr/0011-design-system-and-transient-views.md)
- [ADR 0012: 3-pane workspace + in-paper editing via a preview-only interactive template](adr/0012-workspace-3pane-and-in-paper-editing.md)
- [ADR 0013: Persisted review runs (latest-only snapshot), decoupled from history](adr/0013-persisted-review-runs.md)
- [ADR 0014: Incremental apply — resolve the applied note, keep the rest](adr/0014-incremental-apply-keeps-surviving-notes.md)
- [ADR 0015: The Diff is durable by derivation from the review baseline](adr/0015-durable-derived-diff.md)
- [ADR 0016: A drifted review stays visible — stale-marked, never hidden](adr/0016-drifted-review-stays-visible.md)
- [ADR template](adr/_template.md)

## Features

- [Workspace](features/workspace.md) — a home dashboard lists your tailored CVs (reload-safe, open by URL); tailor or draft a CV, edit bullets live against the preview, sign off net-new, export.
- [Master editor](features/master.md) — build/maintain the canonical CV at `/master`: a keyless structured form (stable provenance ids, chip clouds, validated full-replace Save) with "Add source" opening the import modal.
- [Profile ingestion](features/ingest.md) — build the master profile from a pasted CV / LinkedIn document or an uploaded PDF: the Extractor proposes, the Reconciler matches an existing master (advisory Judge badges), the owner accepts/declines/edits inline, and the master is built server-side (runs as the Master editor's "Add source" modal).
- [App shell & navigation](features/navigation.md) — a persistent left rail binds the authed screens (one nav for the one kind of account, Admin finally linked), one shared session, and an AI-readiness signal; the render path (`/print`) and `/sign-in` stay shell-free.
- [Application tracking](features/applications.md) — "Applied" locks the exact CV you sent to a job (immutable), moves it out of the work area, and files it on the Applications page with a status pipeline + timeline.
- [Admin Menu](features/admin.md) — the provider setup: paste keys (validated, DB-encrypted, write-only), sync models, assign tiers; unlocks the AI routes (ADR 0006).

## Runbooks

- [Local stack + live Playwright verification](runbooks/local-stack-and-ingest-verification.md) — stand up the whole stack locally on SQLite + console magic-link (no Postgres/email/SSO), seed a key, drive the Master editor's "Add source" import modal via Playwright MCP, tear down cleanly.

## Templates

- [Feature documentation template](features/_template.md)
- [Runbook template](runbooks/_template.md)

## Diagrams

Canonical Mermaid sources live under `diagrams/`. Add links here and in `index.html` when you add one.
