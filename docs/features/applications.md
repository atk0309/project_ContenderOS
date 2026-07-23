# Feature: Application tracking

Status: shipped (open items live under Known limitations)  
Last updated: 2026-07-03

## Purpose

Keep a record of **which CV you actually sent to which job**. From the Workspace, "Applied" locks the
finished CV to a job, removes it from the active work area, and files it on an **Applications** page —
storing the exact, immutable CV with a status pipeline and a notes timeline. See ADR 0009 for the
lock/immutability design.

## User-facing behaviour

- **Applied (Workspace).** When a CV is fully signed off and exportable, a **"Applied — move to
  tracking"** button appears beside Export. It opens a confirm dialog capturing an optional **job
  title** (defaults to the parsed job; required for a keyless draft that has no label), **company**,
  **job posting URL**, and a **note**. Confirming locks the CV and navigates to the tracker. The dialog
  is single-flight ("Applying…"), keeps your typed values on a recoverable error, and surfaces the
  server's reason: needs-sign-off / changed-elsewhere (reload + review) / already-applied (→ tracker) /
  missing title (422, fix in place).
- **Locked & immutable.** An applied CV can't be edited, signed off, or deleted from the Workspace
  (the server refuses with a 409 `cvLocked`); opening `/workspace?cv=<applied>` (deep-link or Back/
  bfcache) **redirects to the application detail** rather than showing an editable editor. It also
  disappears from the Home dashboard list.
- **Tracker (the Applications list, reskinned C1).** An owner-only list of **collapsible rows** — each
  shows company/title, applied date, and the **stage pipeline as clickable dots** (`StageDots`): the
  dots fill blue to the current stage (green at "Offer"), a terminal application shows a
  red/grey **Rejected/Withdrawn** badge. **Tapping a dot moves the application** (a real `PATCH
  …/stage` mutation; the move + outcome are announced via a polite live region). **Expanding a row**
  lazy-fetches the full record and shows three cards — **Posting** (a guarded http(s) link),
  **CV sent** ("Open the CV used →" to the detail page), **Recruiter** (editable name + email +
  `mailto:`, persisted via owner-only `PATCH …/recruiter` — structured inputs + an explicit validated
  Save, email checked before saving), then the **stage timeline** (`events`, with per-stage notes) and
  **Move to** buttons (progress + terminal). Header shows *N active · M total*. Loading / empty / error
  states; responsive to iPhone (cards stack, dots fit, the redundant chevron is hidden). A
  mid-session **403** (access revoked — de-allowlisted) renders the access-removed copy on the
  detail screen. Named divergences from the mockup (recruiter's structured-inputs-and-explicit-Save
  vs contenteditable, dropped Notes card + terminal-row dimming, AA-safe move-buttons/labels) are
  recorded in `docs/architecture/design-system.md`.
- **Application detail.** Job info (title/company/URL), a **Locked & immutable** badge, the status
  **timeline**, and a **read-only preview** that mounts the same `ResumeTemplate` the PDF prints
  (invariant 3) from the frozen snapshot. The **status pipeline** is a native `<select>` over the
  application's stages + an optional note → "Update status", which advances the stage and grows the
  timeline from the server's returned record (server truth; disabled when no change is selected).
  **Re-export** the exact CV sent (PDF / DOCX / ATS text) via plain links. **Delete** removes the
  application *and* its locked CV (confirmed; focus returns to the list heading).

## Implementation

- Frontend: `frontend/src/app/(app)/applications/` — `logic.ts` (request builders + selectors +
  409-code parser + the **stage-pipeline model** `pipelineDots`/`moveOptions`/`stageTone`/`stageShort`/
  `stageTitle`/`isTerminalStage`/`trackerCounts`/`stageSummary`, unit-tested in `logic.test.ts`),
  `page.tsx` (the collapsible-row tracker, lazy-fetching each full record on expand), `[id]/page.tsx`
  (detail). The stage dots reuse the shared `frontend/src/ui/StageDots` primitive (tone-based colours).
  Workspace `page.tsx` gains the Applied button + `ApplyDialog` (a `<form onSubmit>` native `<dialog>`,
  not `method="dialog"`, so it can stay open on failure) + the locked-deep-link guard (a parallel
  `by-cv` lookup folded into `loadCv`, plus a `pageshow`/visibility re-check). The `by-cv` probe
  returns **200 with JSON `null`** for an unapplied CV (not 404), so this on-every-load/refocus check
  never logs a red console error; each consumer null-guards before redirecting to the tracker. Nav
  entry in `AppShell.tsx`. Re-export reuses the existing `exportUrl` / `/api/render` path unchanged.
- Backend: owner-only `routes/applications.py`, `persistence/application_store.py`,
  `persistence/models.py` (`StoredApplication`), `persistence/locks.py` (`lock_cv`), and `cv_store.py`
  lock guards. See `docs/architecture/api.md` (routes) and `docs/architecture/security.md` (tenancy).

## Data model

`Application` / `StageEvent` (wired) + `ApplyRequest` / `ApplicationSummary` / `StageUpdateRequest` /
`ApplicationConflict` in `backend/app/schema/application.py`; `stored_applications` table. Lock-state
is derived from the row's existence (no column on `stored_cvs`). See `docs/architecture/data-model.md`.

## Tests

- Backend `backend/tests/test_applications.py` — apply gate, locking, stage pipeline, delete cascade,
  cross-tenant deny per verb (see `docs/testing/strategy.md`).
- Frontend `frontend/src/app/(app)/applications/logic.test.ts` — request builders, selectors, the
  409-code parser, and the stage-pipeline model (dots/move-options/tones/counts/summary).
- The C1 tracker reskin is **Playwright-MCP live-verified** (dark+light × desktop+iPhone): collapsible
  rows, dot-driven move (live-region announce + persistence across reload), the expanded record, and
  the empty/terminal states.
- Owed: Playwright-MCP live verification of the remaining end-to-end flow (apply → re-export matches
  preview → delete), incl. the locked-redirect state.

## Decisions & trade-offs

- **Lock-in-place + derived lock** (ADR 0009): no migration of `stored_cvs`, real server-side
  immutability, zero new render plumbing (re-export reuses the `cvId`-keyed path).
- Delete is destructive (removes the sent CV). An "unapply" (return the CV to the Workspace) is a
  possible follow-up.

## Known limitations & follow-ups

- [x] ~~Phone top-bar density treatment owed~~ — resolved (see `navigation.md`): the wrapped top bar
      was replaced by a bottom tab-bar + a compact top bar.
- [ ] No "unapply"; the only correction for a mis-apply is delete.
- [ ] Stage update is last-write-wins (owner-only, low-concurrency) — no optimistic lock yet.
