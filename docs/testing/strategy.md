# Testing Strategy

Status: active  
Last updated: 2026-07-23

## Quality gate model

**GitHub Actions are not the quality gate.** They are a pre-merge safety net + the deployment-
mechanics gate. The single command before declaring work complete:

```bash
node scripts/quality-gate.mjs
```

It exits non-zero on any failure and reports **gaps** (skipped checks needing setup) so they can't be
silently ignored. A skipped check is a gap, not a pass. `--fail-on-gap` turns gaps into failures.

## Stack

| Layer | Stack | Source of truth |
|---|---|---|
| Backend | FastAPI + Pydantic v2 (Python 3.14) | `backend/pyproject.toml` |
| Schema | Pydantic | `backend/app/schema/` |
| DB | Postgres + async SQLAlchemy (create_all; no Alembic yet — ADR 0006) | `backend/app/persistence/` |
| AI | `anthropic` + `openai` (Python) | `backend/app/ai/providers/` |
| Frontend | Next.js (App Router) + React 19, strict TypeScript 7; TypeScript 5 is isolated to the OpenAPI generator peer | `frontend/package.json`, `tsconfig.json` |
| Render | Playwright + `docx` | `frontend/src/render/` |
| API types | generated from OpenAPI | `frontend/src/lib/api/generated-types.ts` |
| Lint/format | ruff (be) / biome (fe) | `pyproject.toml`, `biome.json` |
| Test | pytest + Starlette TestClient via `httpx2` (be) / vitest (fe) | `pyproject.toml`, `vitest.config.ts` |

## Canonical commands

| Purpose | Command | Gap notes |
|---|---|---|
| Guidance check | `node scripts/check-agent-guidance.mjs` | none — Node stdlib |
| Invariant guards | `node scripts/check-invariants.mjs` | none — Node stdlib |
| Harness self-tests | `node --test scripts/*.test.mjs` (`scripts:selftest` gate step) | none — Node stdlib |
| Doc-impact lint | `node scripts/check-doc-impact.mjs [--fail-on-gap]` | needs git history |
| Backend gate | `uv run ruff check . && uv run mypy && uv run pytest` (in `backend/`) | needs `uv sync --extra dev` |
| Schema no-drift | regen OpenAPI + `pnpm gen:types`, then `git diff --exit-code` | needs both toolchains |
| Frontend gate | `pnpm lint && pnpm typecheck && pnpm test` (in `frontend/`) | needs `pnpm install` |
| Live preview verification | Playwright MCP (Claude-driven) | needs Chromium; **not** part of the gate |
| **Full local quality gate** | `node scripts/quality-gate.mjs` | `--fail-on-gap` |

## Test inventory

- `backend/tests/test_schema_roundtrip.py` — camelCase round-trip + the provenance/sign-off gate.
- `backend/tests/test_app.py` — health + the OpenAPI codegen-anchor guard (every model is emitted).
- `frontend/src/slop/heuristics.test.ts` — the deterministic AI-language detector, anchored by id.
- `frontend/src/lib/proxy.test.ts` — the server-side backend proxy: an unreachable backend
  (ECONNREFUSED) yields a logged `502` instead of an unhandled `fetch failed` that crashes the
  request/process, the query string (single-use magic-link/Entra tokens) is never logged, and a
  reachable backend passes through. Runs offline with a stubbed `global.fetch`.
- `frontend/src/render/ResumeTemplate.test.tsx` — renderer determinism: the `{master, cv}` → view-model
  join, template markup byte-stability + stable `data-bullet-id` anchoring, ats-text, and a `.docx`
  validity smoke. (PDF byte-stability + preview==PDF parity are Playwright-MCP-verified, not gated.)
  Render deps: `docx`, `playwright` (`frontend/package.json`).
- `frontend/src/render/ResumeTemplate.phone.test.tsx` (DevPR9) — the header **phone** mapping: that
  `headerOf()` carries `basics.phone` onto the `ResumeDocument` and it appears in HTML + ATS (and the
  `.docx` carries it too), with the empty-phone case producing no dangling separator. The DOCX assertion
  inflates `word/document.xml` with a dependency-free zip reader (node `zlib`) and checks the
  email → phone → link order, so a mapper that dropped phone fails the gate.
- `backend/tests/test_agents.py` — the Parser agent + `POST /ai/parse`, run offline with a fake
  `ProviderRunner` **and** a fake model resolver (no live key, no DB, no network). The gated route
  test overrides `current_user` + `get_runner` + `get_model_resolver` via `app.dependency_overrides`.
  Also asserts the error mapping: refusal→422, truncation/parse→502, missing key/tier→503 (these
  were raw 500s before the handlers landed). Backend AI deps: `anthropic`, `openai`. Route tests use
  Starlette's `TestClient` through the dev-only `httpx2` package; runtime Authlib and Resend calls
  deliberately remain on `httpx`.
- Frontend Next and Vitest worker processes disable Node 26's experimental web-storage global.
  The vendored `docx` browser bundle probes `localStorage` during import, but neither build/render
  code nor node-environment tests need it; disabling the unused API avoids warning noise and
  stateful local-storage files without changing document output.
- `backend/tests/test_providers.py` — the native-PDF plumbing (ADR 0007): with a mocked Anthropic
  client, `run_claude` builds a `document` content block + text block (vs a plain string) and
  forwards a per-agent `max_tokens`, all without a billed call. The real acceptance of a PDF block +
  `output_format` is a `TEST_ANTHROPIC_KEY`/`TEST_ANTHROPIC_MODEL`/`TEST_PDF_PATH`-gated **live
  spike** (skipped by default — a declared verification gap, not a pass, until run with a real key).
  PR-E adds two more skip-by-default live spikes: the **Claude Reconciler** (`WorkReconciliation`,
  `TEST_ANTHROPIC_*`) and the **OpenAI Judge** (`JudgeReport` via `responses.parse`, `TEST_OPENAI_*` —
  the first live OpenAI structured-output call in the repo). Both are **RUN & GREEN** against real
  keys (2026-06-25), proving the schemas compile on the live APIs — they remain skip-by-default in CI.
  **PR-0 (review panel)** adds five more skip-by-default spikes validating the review wire schemas
  before the agents are built: `EditorReport` / `FactCheckReport` / `GatekeeperVerdict` via
  `responses.parse` (`TEST_OPENAI_*`) and `SlopReport` + a Corrector→`TailoredCV` round-trip via
  `messages.parse` (`TEST_ANTHROPIC_*`). The driver is the schemas' OPTIONAL density (`suggested_revision`,
  `source_id`, defaulted lists) — the same shape that 400'd the Extractor. **RUN & GREEN** (2026-06-27):
  both providers accept the schemas as-is, so no `RawBasics`-style internal-container redesign was needed.
- `backend/tests/test_crypto.py` — Fernet round-trip, masked `last4`, wrong-key `InvalidToken`, and
  the fail-closed/valid-dev/ malformed `SECRETS_ENCRYPTION_KEY` behaviour (`cryptography`).
- `backend/tests/test_admin.py` — the owner-only `/admin/*` routes against an in-process SQLite DB
  (`conftest.sqlite_maker`): owner 200 / non-allowlisted 403 (the `require_owner` re-check, past an
  overridden `current_user` — an autouse fixture allowlists OWNER) / no-session 401; masked GET never leaks the
  secret; validate-then-commit key save (bad key → 400, nothing stored); 409 on sync-with-no-key and
  tiers-with-no-models; 422 on an unknown tier model; key rotation/delete invalidates the cached
  client. Provider list calls are faked — offline. Deps: `sqlalchemy`, `aiosqlite` (dev).
- `backend/tests/test_model_resolution.py` — the DB tier resolver (returns the id / `ModelTierUnset`
  when unset) and `/ai/parse` → 503 when the tier is unset (SQLite + fake runner).
- `backend/tests/test_auth.py` — the auth gate (allow **and** deny): `is_allowlisted`
  allowed/rejected (every entry is an owner — the second entry gets the same owner wire shape),
  magic-token signed round-trip + expiry, `/auth/me` and `/ai/parse` 401 without a session, the
  magic callback logs an allowlisted address in and rejects others, **live revocation**
  (de-allowlist mid-session → next request exactly **403**), the **legacy-cookie back-compat**
  (a stored `role` key is ignored; `login_user` writes the legacy-compatible value for rollback
  safety), and `/auth/entra/login` returns 503 while M365 is unconfigured. Runs offline (no Resend/Entra calls). Auth deps:
  `authlib`, `itsdangerous`, `httpx` (`backend/pyproject.toml`).
- `backend/tests/test_logging_config.py` — the `JsonFormatter` (`app/logging_config.py`): JSON output
  carries `level`/`message`/`logger`/`time`, exception records keep the rendered traceback, and
  `LOG_FORMAT=console` yields a plain non-JSON line. Stdlib only (`json`, `logging`) — offline.
- `backend/tests/test_tenancy.py` — tenant isolation (invariant 8): deny-by-default allowlist
  membership (every entry is an owner), the `require_owner` admin gate, and **per-workspace**
  authorization — `require_workspace_owner` against an in-memory `MembershipStore`, including the
  **cross-tenant deny** (a member of workspace A gets 403 on B). Offline — no network/DB.
  The pinned deny matrix: signed-out → **401** · authenticated non-allowlisted (incl. live
  revocation) → **403** · cross-workspace → **403/404 fail-closed** · gate column: **owner**.
- `backend/tests/test_provenance.py` — the server-side provenance gate (invariant 2), pure functions:
  a valid `sourceId` keeps its origin and clears sign-off; an unknown/None `sourceId` (even when the
  model claims `verbatim`) is **nulled and forced `net-new` + `needsSignoff`**; `validate_stable_ids`
  raises `DuplicateStableId` on a colliding bullet id.
- `backend/tests/test_tailor.py` — the Tailor agent, offline with a fake `ProviderRunner` +
  resolver — agent-level only (the stateless `POST /ai/tailor` was removed; route-level tailoring
  coverage lives in `test_cv.py`). Asserts `run_tailor` applies the provenance gate to the model's
  output (a bogus-source bullet comes back `net-new`/nulled/`needsSignoff`).
- `backend/tests/test_cv.py` — the workspace CV routes against SQLite (`sqlite_maker`) with a fake
  Tailor + in-memory `MembershipStore`. Create now seeds a **stored master** (`PUT .../master`) then
  `POST .../cv` with only `{jobSpec}` — the master is loaded server-side — and a tailor with **no
  stored master → 404**: create → preview → sign off → export happy path; **export 409
  while a net-new bullet is unsigned**; idempotent re-sign-off; unknown bullet → 422; and tenant
  isolation — a non-member → 403 and a `(workspace, cv)` mismatch → 404. Also the **inline edit**
  route (`POST .../cv/{id}/edit`): a grounded verbatim bullet becomes `reworded` (ungated); a net-new
  edit stays gated; editing a signed-off net-new bullet **re-requires** sign-off; an unrelated edit
  does **not** clobber another bullet's sign-off (the per-bullet re-ground guard); blank/whitespace/
  oversized text → 422; cross-tenant → 404; non-owner → 403; and a **stale `baseVersion` edit or
  sign-off → 409** (client-visible optimistic concurrency: a first write bumps the version, a second
  writer still on the old version is rejected). The **cv_labels** write + **dashboard list**: the AI
  route persists a `cv_labels` row from the parsed job while a keyless draft writes none; `GET .../cv`
  returns `CvSummary[]` (owner-gated), is workspace-scoped (a `ws2` CV/label never leaks into
  `default`), surfaces the joined job label (null for a keyless draft), and reflects `needsSignoff`
  flipping after sign-off. **Delete** (`DELETE .../cv/{id}`): an owner delete removes the CV, its
  `cv_labels` row, and its list entry; a non-member → 403; a cross-tenant delete → 404 and the real
  row survives.
- `backend/tests/test_applications.py` — application tracking (PR1) against SQLite with a fake Tailor
  + in-memory `MembershipStore`. Apply happy paths: a signed-off **AI CV** (title/company from
  `cv_labels`, timeline seeded at `applied`, CV vanishes from the active list) and a **keyless draft**
  with a dialog-supplied title; the first event carries the note. The **apply gate + validation**:
  needs-sign-off → **409 `ExportBlocked`**; stale `baseVersion` → **409 `stale`**; double-apply → **409
  `alreadyApplied`** (the unique-constraint backstop, not a 500); no resolvable title → **422**;
  whitespace-only title → **422** (NonBlank); unknown CV → **404**. **Locking**: an applied CV refuses
  `edit`/`signoff`/`apply`/`delete` with **409 `cvLocked`**, and `list_cvs` excludes it.
  **List/read/by-cv** (an applied CV returns its `ApplicationSummary`; an **unapplied** CV — and a
  deleted one — returns **200 with JSON `null`**, not 404, so the workspace's on-every-load probe
  never logs a red console error),
  the **stage pipeline** (valid advance appends + persists across a re-read; invalid stage → **422**),
  and the **delete cascade** (application + CV both gone). **Tenant isolation** (invariant 8): a
  stranger is **403** on every verb, and a `default` application is unreachable through
  `ws2` (id-keyed reads/mutations → **404**; the owner-scoped `by-cv` probe → **200 `null`**, the same
  information-free body an unapplied CV returns, so `null` carries no foreign data). The per-CV advisory lock (`lock_cv`) is a no-op on SQLite, so this suite does NOT
  exercise apply-vs-edit serialization — that's a Postgres-only guarantee, shipped as
  `backend/tests/test_concurrency.py`: a `TEST_POSTGRES_URL`-gated test (an edit that starts while
  an apply's transaction holds `lock_cv` queues behind it, then fails closed with `CVLocked`, and
  the frozen CV is byte-identical). CI runs it against a Postgres service container; locally it
  SKIPS visibly (pytest `-ra`) unless you point `TEST_POSTGRES_URL` at a Postgres DB — a skip is
  a gap, not a pass (AGENTS §4). `test_cv.py` / `test_applications.py` also cover
  the **`cv_job_specs`** snapshot (PR-1a): create persists the full JobSpec, a keyless draft persists
  none, cv-delete and application-delete both remove it, and a cross-tenant read returns `None`.
- `backend/tests/test_review.py` — the **review fan-out** (`POST .../cv/{id}/review`, PR-2a) against
  SQLite + in-memory `MembershipStore`. The AI is faked at **two seams**: the Tailor (seeding a CV at
  create) via `get_runner`/`get_model_resolver`; the review panel via the **`get_panel_runner_builder`**
  override (the fan-out's `build_panel_runner` calls `get_*_client` directly, bypassing
  `dependency_overrides`). Covers: the blocking arm returns the **full bundle** (all four reports +
  `failures`); the **ats score clamp** (100/0); a **needs-sign-off CV is still reviewable** (200, not
  409); a **no-job draft** runs only Fact-Checker + Spotter (`gatekeeper`/`editor` null); thread
  grounding to real anchors. **Degrade (dec #5 / invariant 5):** a per-agent refusal/parse-fail — and
  a constructed `openai`/`anthropic` `APIError` (the distinct-classes case) — lands in `failures`
  (blocking) / an `AgentDone(ok=false)` (stream), **200**, not 422/502; a non-expected bug propagates
  (not swallowed); an **unset tier → 503** in the preflight. **SSE arm:** one `AgentReport`+`AgentDone`
  per agent, terminal `RunDone`, **no `X-Run-Id`**; a setup/bug failure ends in `RunDone(ok=false)`.
  **Concurrency seam (R2, offline guard only — prod-safety needs the live drive):** a 4-party barrier
  proves `run_review` fans out concurrently, and `build_panel_runner` is shown session-free (the pair
  works after the session closes; the client stubs are asserted actually called). An **unexpected bug
  in one member** is shown to **cancel + await** its siblings before re-raising (PR #35 Codex P2 — no
  billed call leaks past the failure). **Tenant isolation** (invariant 8): stranger **403**,
  cross-tenant / unknown id **404**, stale `baseVersion` **409**. **Persisted runs (ADR 0013):** the
  blocking-arm persist roundtrip (+ a forced save-failure → **200** + bundle + `X-Review-Saved:
  false`, nothing stored); the SSE-arm persist at settle (a degraded run persists its `failures[]`);
  a **forced save-failure that DIRTIES the session** (a NOT-NULL violation at commit, not a clean
  raise) WITH an existing older row → the old row is tombstoned + `RunDone(ok=true,
  detail="save_failed")`, exercising the rollback-before-tombstone ordering; a re-run resets
  decisions; **nothing persists** on stale-409 / 503-preflight / unknown-CV; `GET .../review`
  200-null when absent and 200-null (not 500) for a junk stored bundle; the `PUT .../review/decisions`
  roundtrip + **404** no-run + **422** over-bounds + **409** cvVersion mismatch; real-shaped
  (uuid-hex) thread keys fit the 512-char bound; tenancy allow **and** deny (owner **200** /
  stranger **403** / cross-workspace GET → null with zero foreign data, PUT → **404**); and
  the lifecycle deletes (CV, application) plus `delete_review` no-row no-op; that **apply RESOLVES**
  (not deletes) the review (ADR 0014 — row kept at N, applied ids in `resolvedAnchorIds`, decisions
  preserved), no-ops against a `save_failed` (no-row) review, and that a stale post-apply settle at
  the kept version is refused by the `save_review` live-CV guard (`ReviewSuperseded`, no resurrection).
- `backend/tests/test_corrector.py` — the **Corrector apply path** (`POST .../cv/{id}/apply`, PR-3)
  against SQLite + in-memory `MembershipStore`. The AI is faked at **two seams**: the Tailor (seeding a
  CV) via `get_runner`/`get_model_resolver`; the Corrector via the **`get_authoring_runner_builder`**
  override (the route's `build_authoring_runner` calls `get_*_client`/`get_model_resolver` directly,
  like the panel builder), whose runner returns **crafted per-bullet revisions** (`CorrectedBullets`,
  DevPR29) via `_set_corrector({bulletId: text}, extra=[...])` so each test drives the server-authority
  guards from the model OUTPUT. Covers: the **happy path** (only the accepted bullet rewords +
  re-grounds, unaccepted bullets byte-stable, `version`+1 / `parentVersion`); a verbatim
  **SlopThread/FactCheckThread** echo (extra fields) is accepted (`AcceptedThread` `extra="ignore"`),
  not 422'd. **Provenance:** an already-signed-off **net-new unaccepted** bullet **stays signed off**
  (the cv-wide-derive regression); a reword on a **net-new** accepted bullet **stays gated** (the
  per-bullet revision carries no `sourceId`, so grounding-past-sign-off is unexpressible); **overstatement
  on a real source** does **not** re-gate (the Fact-Checker's job). **Per-bullet guards (422):** a
  **missing** revision for an accepted bullet (splice `StructureViolation`), a **duplicate** revision
  id (route `_revisions_map`), and blank / oversized (`MAX_BULLET_LEN`) text. **Ignored (200):** an
  **extra/unknown** revision id (real-but-unaccepted bullet, or a ghost id) is dropped — never spliced.
  (The old whole-CV structure-drift cases — added / dropped / moved / re-parented bullet, changed
  `item.sourceId` / section `type` — are removed: the text-only per-bullet output can't express them.)
  **Preflight before the billed LLM:** stale `baseVersion` / applied-CV → **409** and **no** Corrector
  call (asserted); empty / non-bullet / dead-anchor threads → **422**. **Tenant isolation:**
  stranger **403**, cross-tenant **404**. The `CorrectedBullets` schema's real-API acceptance
  is a `test_providers.py` live spike (`test_run_claude_live_corrector_spike`, TEST_ANTHROPIC_KEY-gated).
  The lock/concurrency guarantee is Postgres-only (the live drive, AGENTS §6), not this SQLite suite.
- `backend/tests/test_master.py` — the workspace master routes against SQLite + in-memory
  `MembershipStore`: `GET` **200-null** when unset (probe parity with the review-latest GET —
  never a first-run 404), `PUT`→`GET` round-trip, non-member → 403,
  **cross-tenant** read/write → 403, and `validate_master_ids`
  422s (duplicate work id, `:`-bearing id, blank highlight id).
- `backend/tests/test_ingest.py` — the ingestion spine (PR-B1) against SQLite with a fake runner
  returning a canned `ExtractedProfile`: paste → review bundle of net-new proposals, empty-text 422,
  tier-unset 503, **owner-gated** (non-member 403), unknown run 404, a `ws2` run unreachable
  through `default` (cross-tenant 404), the one-open-run 409, accept-all → **apply builds the master**
  (and it becomes the stored master), the optimistic-lock 409, bulk-accept of an unknown id 404, the
  first-run incomplete-identity 422, the staleness 409 (a manual `PUT /master` mid-run), and discard
  freeing the workspace. **PR-C (PDF upload)**: the `POST .../ingest/file` happy path (pypdf-built PDF
  via `PdfWriter`, the stored `filename`/`sourceType`), upload tenancy parity (owner 200,
  non-member 403), `sourceType=pasted`/non-PDF/unreadable → 422, too-many-pages → 413, the one-open-run
  409; the `_extract` native→text-only fallback matrix (fall back on parse error, propagate when both
  fail, no retry on empty `doc_text` / refusal / truncation); the `pdf_text` guard (page/byte caps,
  unreadable bytes); the **PR-E1** route paths (import into an existing master reconciles — a differing
  basics field is a `correction`, equal is suppressed; bulk-accept can't sweep a correction → 422; an
  existing master with no work still reconciles basics deterministically; `run_ingest` skips the
  Reconciler when there's no extracted work to match); the **PR-E2** advisory Judge — join
  (omitted/unknown proposalId → needs-review) and degrade (any provider error → a visible
  needs-review, the run still reaching review); and a 503-after-run-row (a key-build failure
  post-`create_run` → run `failed`, not wedged).
- `backend/tests/test_reconcile.py` — PR-E reconciliation as pure functions (no DB/runner): the work
  Reconciler output is supplied directly. `build_reconciled_proposals` re-grounding (unmatched →
  net-new; matched → one enrich per NEW highlight, present suppressed; pure-duplicate → zero;
  dangling/out-of-range/duplicate match → demote; basics empty→fill / equal→suppress / different→
  correction). `apply_accepted` enrich (id-preserving append, `{wid}:{hid}` audit, multi-enrich live
  dedup, target-gone → conflict + partial) and correction (overwrite when current matches, stale →
  conflict, an edited `fieldPath` can't retarget). Plus a re-tailor regression: an enrich-appended
  highlight is a valid `derive_provenance` sourceId.
- `backend/tests/test_draft.py` — the deterministic verbatim draft (`build_verbatim_draft`) + the
  keyless `POST .../cv/from-master`: every bullet `verbatim` → zero net-new, all three
  (`work`/`skills`/`education`) sections present, `validate_stable_ids` passes even when a `work.id`
  equals an `education.id` or a highlight id repeats across entries (id namespacing); the route
  persists and **exports without sign-off** (200, not 409), and 404s with no stored master.
- `frontend/src/app/(app)/master/logic.test.tsx` — the Master editor's pure form-draft layer (node env):
  `draftFromMaster` → `toMaster` round-trips the sample byte-for-byte and **keeps stable work/highlight
  ids**; `toMaster` rejects an empty draft with required-field errors, trims scalars + splits
  tags/keywords, and **preserves `certificates` verbatim**; `newId` never contains the `:` delimiter.
  The chip/read-stack helpers (S7): `addSkillFromInput`/`addLanguageFromInput` (case-insensitive +
  trimmed dedupe, blank no-op, existing rows untouched), `chipLabel`, `educationSummary` (degree/org/
  dates + all-blank flag), and `firstInvalidEntry` (Save-error auto-open target — Skills→Education→
  Languages order, education reports the offending field).
- `frontend/src/app/(app)/workspace/logic.test.tsx` — the Workspace screen's pure logic (node env, no DOM):
  the request builders (`/ai/parse`, `/workspaces/{id}/cv`, `…/edit`, `…/signoff`, `…/review` via
  the SSE `reviewStreamRequest`, gated export urls) emit the right paths/bodies; selectors
  `collectUnsignedBulletIds` / `editableItems` pick the right bullets; `dirtyBulletIds` / `overlayDrafts`
  apply unsaved drafts purely; and the overlay flows through the real `ResumeTemplate` so the live
  preview matches what edits show. The **review** core is unit-tested here too: `reduceReviewBundle`
  (merge by the populated field not `agentId`, coalesce, dedup failures), `agentState` (pending-until-
  settled — no false flash), `collectThreads`/`threadKey` (stable + anchorKind-distinct)/routing/
  `orphanedThreads`/`anchorLabel`, and `failureLabel` (real `Agent*`/SDK class names → owner phrases,
  generic fallback). `reviewReady` (both-providers) is covered in `frontend/src/lib/ai-readiness.test.ts`.
  The **PR-4 apply core** is unit-tested here too: `decide` (immutable toggle/clear), `reviewedText
  Snapshot` + `staleReviewBulletIds` (saved-text drift OR dirty; **edited-then-reverted is live again**;
  new-since-review not stale), the **shared** `isAcceptableThread` + `acceptedThreads` (editable bullet
  + non-stale + **supported-fact-check excluded** + orphan-excluded; multiple-per-bullet kept;
  decisions-survive-a-one-bullet-save), `canApplyCorrections` (≥1 accepted, dirty/busy block, **not**
  sign-off), and `applyFeedbackRequest`. The **honest same-line apply** (Fix 3) adds `bulletMarkers`
  (`actionableCount`/`verifiedCount` — a supported fact-check tallied separately, not in the fix count),
  `isSupportedFactCheck`, and `foldSameBulletDecisions` (the batch path folds an accepted bullet's
  non-rejected siblings so none is silently dropped). The **durable derived Diff** (ADR 0015) adds
  `diffChangedBulletsFromSnapshot` (cumulative from a baseline map; net-new bullets skipped). The **S4
  review-persistence core** (ADR 0013) is here too:
  the `reviewLatestRequest` (GET) + `saveDecisionsRequest` (PUT — encoded ids, whole-snapshot +
  `cvVersion` body) builders, `checklistFromBundle` (bundle report field → backend agent id —
  `slop`→`spotter`, `factCheck`→`fact-checker`; populated→`done`, `failures[]`→`failed`, never-ran→
  `absent`, **fed through `agentState`/`agentRosterStatus` to prove a rehydrated roster equals the
  settled-live one**), `threadKey` **determinism across a persist→restore JSON round-trip** (restored
  decisions re-attach; the `acceptedThreads` projection is identical pre-navigation vs after restore),
  `decide` → the PUT payload is the **post-toggle snapshot**, and `staleReviewBulletIds` over a
  **restored** `reviewedText` flagging exactly the drifted bullet. **ADR 0016 (drifted review stays
  visible)** adds paraphrase-proof REGION-carrier render tests: per-scenario `ReviewPanel` renders
  (absent / fresh / drifted ± verdict ± restored ± accepts) assert the count of the canonical
  `STALE_REVIEW_PHRASE` AND a derived `/re-run/i` total against the explicit allowlist (the trigger
  label, ThreadList per-agent error copy, `applyDisabledReason`, the dirty hint, the
  gatekeeper-unavailable fallback), the governed captions render NOTHING at zero accepts (no empty
  `<p>`), `TopbarVerdict`/`VerdictCard` carry the phrase in their accessible name with a visible
  "Out of date" chip, `VerdictPill` stale desaturates chrome only (label ink untouched), and the
  `GatekeeperView` stale banner is that region's single carrier. The **Applied fix state** adds the
  pure `gatekeeperFixes` builder (resolved / unresolved / summary-anchored / **cross-kind anchorId
  collision never reads applied** / whole-bullet supersession / stale-unapplied-no-tag / gatekeeper-
  source filter) plus `GatekeeperView` Applied-row renders (✓ chip shown, no "Open in Workspace" on
  that row; the "N applied" tail + row srOnly collapse under the stale banner). **B1 (new-application
  flow):**
  `withPostingUrl` (trim,
  blank→null, no input mutation, overrides a prior URL), `isSafeHttpUrl` (http(s) only — no
  javascript:/data: href), and `newApplicationError` (404 → master; 503 → Admin; 502 → transient
  retry; other ApiError → unwrapped FastAPI `{detail}`; non-ApiError → generic). The list / modal /
  drawer UI is hook + effect heavy → Playwright-verified (§6), not unit-rendered. The review components
  (`ReviewPanel`/`ThreadList`/`ThreadCard`/
  `ReviewInlineBadge`) are **thin renderers** — coverage is these logic tests + `renderToStaticMarkup`
  smoke tests (per-agent failed/empty/thread states + the `ThreadCard` accept/reject render), plus the
  live Playwright drive (§6); no separate component test file. **PR-4 Playwright (§6, REQUIRED):**
  tailor → review → accept a bullet note → **Apply corrections** → preview shows the reworded text, ids
  intact, version bumped → a corrected net-new bullet needs sign-off → sign off → export; **visual
  parity** preview vs `/api/render/pdf` (not byte, invariant 3); the per-bullet lifecycle (save one
  bullet → only its notes stale, the rest keep Accept); a supported fact-check shows no Accept; the
  cvLocked redirect; 390px incl. the accept→apply scroll round-trip.
- `frontend/src/app/(app)/ingest/logic.test.ts` — the Ingest screen's pure logic (node env, no DOM): the
  request builders (list/read/decide/bulk/apply/discard + the two SSE stream builders) emit the right
  paths/bodies and URL-encode run/proposal ids; selectors `openRun` / counts / `extractedNothing`
  classify runs correctly; **`orderedProposals` preserves input order independent of status** (the
  stable-identity invariant); the `seedDraft` → `draftToContent` round-trip is loss-free per unit kind
  (list split/trim/empty-drop, empty `endDate`/`level` → null) and **keeps the basics `fieldPath`**
  (the server allowlist key); `isProposalDirty` / `editedContent` / `dirtyPendingProposalIds` flag
  only genuinely-changed pending drafts (the guard that stops bulk-accept committing un-saved edits);
  `parseDetail` pulls a FastAPI `{detail}` out of a raw `ApiError` message. **PR-C**: `uploadStreamRequest`
  builds the multipart call with no content-type override (browser sets the boundary) + `sourceType=cv-pdf`;
  `isPdfFile`/`isFileTooLarge` guards; and `ingestErrorMessage` preserves the 502 + 422-detail-passthrough
  copy and adds the 413 case. The SSE spine itself now lives in `src/lib/sse.ts` (below); the ingest
  logic re-exports it, so these tests are unchanged.
- `frontend/src/lib/sse.test.ts` — the **shared SSE spine** (PR-2-pre, extracted from ingest so the
  review fan-out reuses it; node env): `splitSseFrames` keeps the trailing partial across reads;
  `parseSseFrame` ignores keepalive comments / non-data / non-JSON frames; `reduceChecklist` appends in
  first-seen order with last-event-wins status and collapses a failed→re-run retry; `consumeSseStream`
  (against a stubbed `fetch` + a `ReadableStream`) drives `onEvent` per frame, returns `run_done` (with
  its `resultRef`, or the `X-Run-Id` fallback), maps a non-ok preflight to `http_error`, and an EOF with
  no terminal event to `dropped` carrying the run id. Plus the **`AgentChecklist`** UI primitive
  (`src/ui/AgentChecklist.tsx`): renders the single `aria-live` status sentence + per-agent glyphs/labels
  and shows the Stop hatch only once the stream is live (static glyphs, no spinner — reduced-motion).
- `frontend/src/app/(app)/applications/logic.test.ts` — the Applications tracker's pure logic (node
  env, no DOM): the request builders (apply/list/read/by-cv/stage/delete) emit the right paths/methods/
  bodies and URL-encode ids + the workspace; `applicationLabel` ("Company — Title", else title);
  and the 409-body parsers — `conflictCode` reads `{code}` (stale/alreadyApplied/cvLocked)
  and is null for the needs-sign-off `ExportBlocked` body or non-JSON, `blockedBulletIds` reads the
  gate body — so the Workspace apply handler branches on a machine code, never prose.
- `frontend/src/lib/ai-readiness.test.ts` — the AI-readiness derivation (node env): `tailorReady` is
  true iff the Anthropic provider has a key set AND a strong-tier model (the condition the shell uses to
  lead with Tailor / nudge to Admin). Cases: key+strong → ready; key-no-strong / unset key / openai-only
  / empty list → not ready.
- `frontend/src/render/fetch.test.ts` — `getRenderBundle`: maps a 200 export to a `RenderInput` while
  forwarding the session cookie, maps a 409 to a blocked result carrying the blocking bullet ids, and
  relays other non-200s. Offline with a stubbed `global.fetch`.
- `frontend/src/app/api/render/pdf/route.test.ts` — the PDF auth handoff: after the gate precheck the
  route **injects the caller's session cookie into the Playwright context**, and a 409 from the gate
  is relayed **without launching Chromium**. Playwright is mocked — offline.
- `frontend/src/ui/contrast.test.ts` — the **computed-contrast suite** (node env): parses
  `globals.css` (top-level `:root`/`[data-theme]` blocks merged in cascade order, one-level `var()`
  resolution, `#rrggbb` + `oklch(L C H)` → sRGB via the OKLab matrices) and asserts the WCAG floors
  design-system.md §Computed contrast documents — essential text ≥4.5:1 (`--text`/`--text-2` on
  `--bg`/`--panel`, `--ink-warn` on all three surfaces, `--on-accent`, the light-`--ok`-on-`--panel`
  4.51 knife-edge), the badge glyph ink on all seven identities (six `--rv-*` + `agent`-on-accent),
  and the full Switch non-text matrix ≥3:1 (every checked-track colour in use × knob-body-or-
  opaque-ring × the `--panel` host, plus the OFF-track pairs). **Calibrated against known sRGB
  references** (white/black 21:1, `#767676`-on-white 4.54 just-passes, `#777777` 4.48 just-fails,
  the oklch black/white endpoints), never against its own pipeline's output; failures name the
  token pair and the computed ratio. The parser never composites alpha — opaque tokens only (the
  reason `--switch-knob-ring` is opaque by contract).

## What to test as the app grows

- The provenance/sign-off gate: a net-new bullet blocks export until approved (allow + deny).
- Stable anchoring: a Corrector reorder leaves surviving threads correct; deleted ⇒ orphaned.
- Render stability: identical JSON renders identical PDF/DOCX for the pinned toolchain.
- Agent schema conformance: each agent's output parses against its Pydantic schema.
- Auth allowlist: allowed accounts in, everyone else out (allow + deny).
- Tenant isolation with a real DB: when `persistence/` gets a Postgres-backed `MembershipStore`,
  re-point `test_tenancy.py` at it and add row-level scoping tests (every query filtered by
  `workspaceId`). The cross-tenant deny is already enforced against the in-memory store today.
- Invariant guards (`check-invariants.mjs`): the export route keeps its `needs_signoff()` gate +
  a 409 test (invariant 2); no clock/RNG/locale source anywhere in the render path — `src/render/`,
  `/print`, the render API routes — and no chrome `var(--…)` in the paper tokens (invariant 3); no
  provider-key identifier or key-shaped literal under `frontend/src/` or `next.config.ts`
  (invariant 4); no raw completion call-sites under `backend/app/` and `.parse(` intact in both
  wrappers (invariant 5); every agent's `provider=Provider.<x>` literal matches the canonical map
  (invariant 6); every `{workspace_id}` route carries `require_workspace_*` + `test_tenancy.py`
  exists (invariant 8); tokens-only chrome in `src/{app,ui,lib,slop}` (design fidelity, ADR 0011).
  Invariants 1 and 7 are deliberately not machine-guarded (no cheap static signature — grep
  proxies would be noise). The guards' own fixtures live in `scripts/check-invariants.test.mjs`
  (`scripts:selftest` gate step).
