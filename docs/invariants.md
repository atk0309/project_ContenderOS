# Invariants — the contract that must not break

These are load-bearing. The split (FastAPI backend + Next.js frontend) changes the *shape* of the
system but not these. Re-derive any one wrong and something silently breaks.

1. **Judgment is split from rendering.** AI (backend) emits schema-constrained JSON; deterministic
   code (frontend) renders documents. No model ever produces a `.docx` or a finished document string.
   This is the one thing the project exists to prevent.

2. **Provenance + sign-off gate.** Every tailored bullet has `sourceId` → a real `MasterProfile`
   bullet and `origin ∈ {verbatim, reworded, net-new}`. `net-new ⇒ needsSignoff = true`, which
   **blocks export** until the **candidate** (the workspace owner) approves it. The gate is the
   `needs_signoff()` property on `TailoredCV` (`backend/app/schema/tailored.py`), enforced by the
   owner-only export route (`export_cv` in `backend/app/routes/cv.py` → **409 `ExportBlocked`**);
   `test_net_new_bullet_blocks_export` locks the schema-level gate and the route-level export-409
   tests in `tests/test_cv.py` lock the enforcement. The client may never set `origin` /
   `needsSignoff` / sign-off state — the server derives and gates it. A CV that invents claims is an
   interview liability.

3. **Render is stable for a pinned toolchain.** Live preview, ats-plain PDF, pretty PDF, and DOCX all
   derive from ONE template (`frontend/src/render/ResumeTemplate.tsx` + `template-tokens.ts`). PDF is
   Chromium print-to-PDF of the hidden `/print/[cvId]` route — the same component the user sees.
   "Stable" means: pinned Playwright/Chromium, bundled fonts, fixed locale/timezone, no `Date.now()`
   in the render path. (Not literal byte-identity across arbitrary environments — that's unachievable
   across Chromium versions; we pin the toolchain instead.)

4. **API keys are server-side only.** Provider keys are entered in the owner's browser, transit the
   same-origin proxy, and are stored **encrypted at rest** in the DB — never bundled in client JS,
   never persisted client-side, never returned unmasked (the API exposes only `isSet` + a `last4`
   hint). The only provider secret in env is the Fernet master key `SECRETS_ENCRYPTION_KEY`. No
   browser-side direct-to-provider calls. Model ids are likewise admin-managed (a DB tier→model map,
   not pinned strings) — still config, not code. See ADR 0006.

5. **Structured outputs, not prompt-and-pray.** Every agent returns provider-enforced JSON (Anthropic
   `messages.parse(output_format=Model)`; OpenAI strict `response_format`) validated by Pydantic.
   Refusal / truncation / schema-parse-failure are surfaced explicitly — a silent failure that ships
   a malformed CV is worse than a loud one.

6. **Provider split is deliberate.** The model that writes the CV is not the only one that judges it.
   Authoring (Parser, Tailor, Spotter rewrite, Corrector, and the ingestion Extractor + Reconciler) →
   Claude. Adjudication (Editor, Fact-Checker, Gatekeeper, and the ingestion Judge) → OpenAI.
   Cross-model review catches a
   model's blind spots in its own output. (The ingestion enrich re-grounding + the correction
   stale-overwrite guard are the ingestion analogue of `derive_provenance` — the server, not the
   model, is the authority on what enters the master.)

7. **Concurrency is deliberately simple, per workspace.** A small set of allowlisted owner accounts
   (one person in practice) edit from their own sessions — no CRDT, no merge UI. Designated
   snapshot writes (master profile, review decisions, recruiter notes, stage) are last-write-wins;
   CV **content** writes are version-guarded (a stale writer gets **409**); destructive ops
   (delete) serialize on the per-CV advisory lock with an `is_applied` re-check instead
   (ADR 0009). The review decisions PUT is
   whole-snapshot LWW **at the same review version**: a review-vs-CV version mismatch is rejected
   **409** as a server-side defense (ADR 0013's exact semantics), so LWW never crosses a re-run
   boundary. AI review threads anchor to a **stable id** (`bulletId` / `itemId` / `sectionId`),
   never an array index or document offset. The Corrector preserves ids on reword and mints new
   ones only for net-new bullets, so a note tracks its bullet through rewrites and reorders (see
   ADR 0003).

8. **Tenant isolation is server-side and deny-by-default.** A user may read or write only the
   workspaces they are a member of (today: every allowlisted account owns the single default
   workspace), and authorization is re-derived on **every** request from the session against
   workspace membership AND the allowlist — never from a client-supplied id or membership claim.
   No cross-tenant read or write; a missing session fails closed (**401**), and a non-member or
   **de-allowlisted** account fails closed (**403** — live revocation, revalidated per request).
