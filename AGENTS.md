# AGENTS.md — Repository Agent Operating Manual

Status: canonical shared guidance for coding agents (Claude Code, Codex, others). Freshness: see
`docs/agent-guidance-changelog.md` and `git log -- AGENTS.md`.

> **Two sources of truth — local validation is mandatory.**
> 1. **The local quality gate is the source of truth for code correctness.** Run
>    `node scripts/quality-gate.mjs` before declaring complete. GitHub Actions are not that gate.
> 2. **GitHub checks are the source of truth for CI and production-build mechanics** and a
>    pre-merge safety net — not a substitute for the local gate. The configured hosting provider,
>    if any, is the source of truth for an actual deployment.

## 0. Authority and sync

- Canonical for any agent that reads `AGENTS.md`. Session instructions override this file. Nested
  `AGENTS.md` files (`backend/`, `frontend/`) govern their subtree and hold only toolchain detail.
- `CLAUDE.md` must contain `@AGENTS.md` and hold only Claude Code-specific harness mechanics.
- When commands/architecture/workflow change: update this file first; mirror Claude-specific bits in
  `CLAUDE.md`; record it in `docs/agent-guidance-changelog.md` (the `guidance-self-update` rule).
- This file targets under 220 lines and **hard-fails over 32 KiB** (`scripts/check-agent-guidance.mjs`).

## 1. Operating rules

- Work from evidence in the repo. Inspect files, tests, and config before claiming.
- Before editing, check `git status --short`. Never overwrite uncommitted changes you did not create.
- No push / merge / deploy / secret rotation / destructive shell unless explicitly instructed.
- No new production dependencies without justification and a lockfile update.
- Prefer existing repo patterns over generic best practice. If ambiguous, make the safest reasonable
  assumption and continue; ask only when ambiguity blocks safe progress.
- Prefer the laziest solution that works: before writing new code or an abstraction, ask whether it
  needs to exist at all, then reach for the stdlib/platform, then an existing dependency, then one
  line. **Minimalism never trims what §2 requires** — provenance + sign-off, structured outputs,
  server-side enforcement, and validation/accessibility are load-bearing, not over-engineering.

## 2. Invariants you must not break

The contract this repo exists to protect. Full text in `docs/invariants.md`. Re-derive any wrong and
something silently breaks.

1. **Judgment is split from rendering.** AI (FastAPI) emits schema-constrained JSON; deterministic
   code (frontend) renders documents. No model ever emits a `.docx` or a finished document string.
2. **Provenance + sign-off gate.** Every tailored bullet carries `sourceId` → a real master bullet
   and `origin: verbatim | reworded | net-new`. Anything `net-new` sets `needsSignoff: true` and
   **blocks export** until the **candidate** (workspace owner) approves it. Enforced server-side;
   never trust the client.
3. **Render is stable for a pinned toolchain.** Live preview, ats-plain PDF, pretty PDF, and DOCX all
   derive from ONE template (`frontend/src/render/ResumeTemplate.tsx` + `template-tokens.ts`). Pin
   Chromium + fonts; no timestamps/locale/randomness in the render path.
4. **API keys are server-side only.** Provider keys are admin-managed, **encrypted at rest in the DB**
   (only the Fernet master key `SECRETS_ENCRYPTION_KEY` is in env), never in the client bundle or
   returned unmasked. Model ids are a DB tier→model map, not pinned env strings. See ADR 0006.
5. **Structured outputs, not prompt-and-pray.** Every agent returns provider-enforced JSON validated
   by Pydantic (`messages.parse` / `response_format`). Surface refusal/truncation/parse-fail loudly.
6. **Provider split is deliberate.** Authoring (Parser, Tailor, Spotter rewrite, Corrector, ingestion
   Extractor + Reconciler) → Claude; adjudication (Editor, Fact-Checker, Gatekeeper, ingestion Judge)
   → OpenAI. See `docs/ai-panel.md`.
7. **Concurrency is deliberately simple, per workspace.** A small set of allowlisted owner
   accounts (one person in practice) edit from their own sessions — no CRDT, no merge UI.
   Designated snapshot writes (master profile, review decisions, recruiter notes, stage) are
   last-write-wins; CV **content** writes are version-guarded (stale writers get 409), while
   destructive ops (delete) serialize on the per-CV lock instead (ADR 0009). AI review threads
   anchor to a **stable id** (`bulletId`/`itemId`/`sectionId`), never an array index or document
   offset.
8. **Tenant isolation, server-side + deny-by-default.** A user reaches only workspaces they are a
   member of (today: every allowlisted account owns the single default workspace); authorization
   is re-derived per request from the session against workspace membership AND the allowlist,
   never a client-supplied id. Non-members and de-allowlisted accounts fail closed.

## 3. Repository snapshot

Monorepo, two deployables + a root harness. Before editing, verify the layout matches `git ls-files`.

- `backend/` — FastAPI (Python 3.14). `app/schema/` is the **single source of truth** (Pydantic).
  `app/ai/{providers,agents}`, `app/routes/`, `app/persistence/`, `app/auth/`. Toolchain: uv, ruff,
  mypy, pytest. See `backend/AGENTS.md`.
- `frontend/` — Next.js (App Router) UI **+ the deterministic renderer**. `src/render/` (the one
  template + render routes), `src/app/` (screens), `src/slop/` (client-side heuristics),
  `src/lib/api/generated-types.ts` (generated from backend OpenAPI). Toolchain: pnpm, biome, tsc,
  vitest, Playwright MCP. See `frontend/AGENTS.md`.
- `scripts/` — `quality-gate.mjs`, `check-agent-guidance.mjs`, `check-invariants.mjs`,
  `check-doc-impact.mjs`, `install-hooks.mjs`, `hooks/pre-push`.
- `docs/` — invariants, architecture, ADRs, ai-panel, testing strategy, agent-guidance changelog.

## 4. Local quality gate

The single command before declaring complete:

```bash
node scripts/quality-gate.mjs
```

Runs: guidance check → invariant guards (`check-invariants.mjs`: invariants 2, 3, 4, 5, 6, 8 +
design fidelity; 1 & 7 deliberately not machine-guarded) →
scripts self-tests (`node --test scripts/*.test.mjs`) → doc-impact lint (**worktree mode**: sees
uncommitted + untracked work too; an unmet rule reports as GAP) → backend gate (ruff/mypy/pytest) →
schema sync (regen OpenAPI + TS, fail on drift) → frontend gate (biome/tsc/vitest). Exit codes:
0 all pass · 1 any FAIL (or any GAP under `--fail-on-gap`) · 2 gaps in warn mode. `--fail-on-gap`
treats skipped checks as failures. **A skipped check is a gap, not a pass — never claim a skipped
check passed.**

## 5. Canonical commands

| Purpose | Command |
|---|---|
| Backend deps | `uv sync --extra dev` (in `backend/`) |
| Frontend deps | `pnpm install` (in `frontend/`) |
| Regen API types | `uv run python -m app.export_openapi` then `pnpm gen:types` |
| Install pre-push hook (one-time) | `node scripts/install-hooks.mjs` |
| Doc-impact rules | `node scripts/check-doc-impact.mjs --list-rules` |
| **Full local quality gate** | `node scripts/quality-gate.mjs` |

## 6. Live preview verification (Playwright MCP)

Vitest in node does not exercise the layout engine, the print-to-PDF path, or anything visual. This
product's value is a CV a recruiter reads and a PDF that matches the preview byte-for-byte. For any
non-trivial UI or render change (workspace layout, the preview template, a render route, a review
surface): start the frontend dev server, drive the affected route end-to-end, and verify the visual
+ interactive result **and that the rendered PDF matches the preview**. Report which routes and
which states (loading / empty / populated / error / needs-sign-off) you verified. Playwright MCP is
a verification layer, **not** part of the gate. If unavailable, report a verification gap.

## 7. Frontend rules

See `frontend/AGENTS.md`. Load-bearing: the `ResumeTemplate` is shared by preview AND PDF — a change
to it changes the exported document (invariant 3). Types come from `generated-types.ts`; never
hand-write a CV/Review interface. Heuristics run client-side on keystroke. Match the design tokens,
keyboard focus, reduced-motion; Tracker + review notes must work on iPhone width.

## 8. Backend rules

See `backend/AGENTS.md`. Keep business logic in `app/`; route handlers stay thin. AI calls go through
`app/ai/providers/`. Enforce auth, **per-workspace ownership/isolation** (invariant 8), and the
**provenance gate server-side**. Model ids resolve from the admin-managed DB tier→model map (ADR
0006), never env-pinned. Do not swallow agent errors. Log agent id, provider, model, tokens,
latency, outcome.

## 9. AI provider & agent rules

- Authoring agents → Claude; adjudication → OpenAI (invariant 6). Provider keys + per-tier model ids
  are admin-managed (DB-encrypted; ADR 0006) — agents declare a tier, resolved at call time, not env.
- Structured outputs enforced by the provider; Pydantic validates. The slop detector runs
  deterministic heuristics first (frontend), model pass second (Spotter). Frame it as voice-matching,
  never "beat the AI detector."
- Adding/changing an agent's contract is a `docs/ai-panel.md` change (`ai-agent-change` rule).

## 10. Security

- Never commit secrets, tokens, or real CV/personal data. Use placeholders like `<API_KEY>`.
- API keys server-side only (invariant 4) — `check-invariants.mjs` fails the gate if a provider-key
  identifier appears under `frontend/src/`.
- **Tenant isolation (invariant 8):** authorize every workspace access server-side, deny-by-default,
  against session-derived membership AND the allowlist (revalidated per request — a de-allowlisted
  account fails closed with 403), never a client-supplied id. For any auth / ownership / tenancy
  change add explicit allow **and** cross-tenant deny tests, and update
  `docs/architecture/security.md`.
- Production deployments must configure an authentication path and the server-side allowlist before
  accepting real CV data. Keep every CV-bearing route behind that deny-by-default gate — never
  expose real CV data on an ungated path.

## 11. Git, PR, and GitHub Actions

- Inspect `git status --short` before editing and before summarising. Do not stage/commit/push/open
  PRs unless explicitly asked. Concise conventional commits (`feat:`, `fix:`, `chore:`, `docs:`).
- GitHub Actions are deployment-mechanics + safety net, not the code-correctness gate.

## 12. Documentation contract

Docs live under `/docs`; treat docs as deliverables in the same change as the code. Use the
`_template.md` files for ADRs, features, runbooks. Keep `docs/index.html` and `docs/README.md` in
sync; add links for new feature docs, ADRs, runbooks, diagrams.

## 13. Completion checklist

- Code implemented; tests added/updated for new/changed behaviour.
- `node scripts/quality-gate.mjs` run; result known; gaps listed with the command that closes each.
- UI/render changes: live-preview verification (§6) performed; verified routes/states listed.
- `/docs` updated per the Doc-impact checklist; semantic drift checked; `index.html` + `README.md`
  link new docs. `AGENTS.md`/`CLAUDE.md` updated only if durable guidance changed, with a changelog
  entry. No secrets introduced; `git status --short` reviewed.
- Final response: changed files, docs touched, commands run, pass/fail/gap per command, risks.

## 14. Doc-impact checklist

Walk this on every change. `scripts/check-doc-impact.mjs` enforces the same rules; table and lint
stay 1:1 (`node scripts/check-doc-impact.mjs --list-rules`).

| Change type | Required doc updates | Rule id |
|---|---|---|
| Modified `backend/app/schema/**` | `docs/architecture/data-model.md` | `schema-change` |
| Modified `backend/app/schema/**` | regen `frontend/openapi.json` + `frontend/src/lib/api/generated-types.ts` | `schema-contract` |
| Added `backend/app/routes/*.py` | `docs/architecture/api.md` | `new-api-route` |
| Added/changed `backend/app/ai/agents/*.py` | `docs/ai-panel.md` | `ai-agent-change` |
| Modified `backend/app/ai/providers/*.py` | `docs/architecture/api.md` | `provider-change` |
| Modified `frontend/src/render/**` | `docs/architecture/renderer.md` | `render-change` |
| Modified `backend/app/auth/**` | `docs/architecture/security.md` | `auth-change` |
| Modified `backend/app/persistence/**` (workspace/ownership/isolation queries) | `docs/architecture/security.md` | `tenancy-change` |
| Modified a `*/.env.example` | `docs/architecture/deployment.md` | `env-vars-changed` |
| Added a backend `tests/test_*.py` or frontend `*.test.ts(x)` | `docs/testing/strategy.md` | `new-test-suite` |
| Added/removed a dependency in `backend/pyproject.toml` or `frontend/package.json` | `docs/architecture/overview.md` **or** `docs/testing/strategy.md` | `dependency-change` |
| Added `docs/diagrams/*.mmd` | link from `index.html` **and** `README.md` | `new-diagram` |
| Added `docs/adr/*.md` (excl. `_template.md`) | link from `index.html` **and** `README.md` | `adr-added` |
| Modified `AGENTS.md`/`CLAUDE.md`/nested AGENTS/`scripts/**`/`.github/workflows/**` | `docs/agent-guidance-changelog.md` | `guidance-self-update` |

**Escape hatch.** If a trigger lights but the doc legitimately doesn't move, add a commit trailer
`Docs-Impact-Ack: <rule-id> <reason>` **on the commit that lights the rule** — the lint ignores
acks riding other commits, bare acks without a reason, and acks for still-uncommitted work.
Use sparingly; the lint records it in git history.

## 15. Self-update protocol

Update guidance only when the change is durable. Order: `AGENTS.md` → `CLAUDE.md` (Claude-specific
only) → `docs/agent-guidance-changelog.md` entry → run the gate. If you add a doc-impact trigger, add
the rule to `scripts/check-doc-impact.mjs` in the **same commit**; the §14 table and the lint's
`RULES` must stay 1:1. The `pre-push` hook enforces guidance + doc-impact on push; never bypass with
`--no-verify` unless explicitly told.
