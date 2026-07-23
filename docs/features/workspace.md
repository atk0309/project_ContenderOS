# Feature: Workspace (tailor + edit + export)

Status: shipped (open items live under Known limitations)  
Last updated: 2026-07-03

## Purpose
The first real screen. After sign-in the home route was a placeholder; this gives the **candidate
(owner)** a working surface that drives the existing backend pipeline end to end: paste a job posting
→ tailor a CV → edit bullets live against a real-time preview → sign off net-new claims → export.

## User-facing behaviour
- Route `/workspace` (owner-gated server-side; every allowlisted account is an owner). The app
  shell's session gate redirects a 401 to `/sign-in`; a mid-session **403** (the account was
  de-allowlisted — live revocation) renders "Your access was removed — sign in with an allowlisted
  account." **`/workspace` with no `?cv=` is the landing — the application list** (it absorbed the old Home dashboard in B1, so
  an owner who hits `/` is redirected here). It lists the workspace's **active** tailored CVs
  (`GET .../cv` → `CvSummary[]`; applied/locked CVs are excluded — they live in the Applications
  tracker) as **cards** (label = job or "Draft · date", a needs-sign-off chip, a summary line, the
  updated date), each opening `/workspace?cv=<id>`. A leading dashed **Start application** tile opens
  the New-application modal; a **Start a no-AI draft** secondary builds a verbatim CV from the master.
  When AI is `not-ready` the tile inverts to the no-AI draft + a **Set up AI → Admin** nudge (see AI
  readiness below). The list refetches on mount and on return-to-tab (`pageshow`/visibility), so a CV
  created in the editor appears when you navigate Back. Each card has a **Delete** (confirm-guarded)
  that removes the CV + its label and refreshes the list, returning focus to the list heading.
- **New application (modal):** the Start tile opens a native-`<dialog>` modal — paste the posting text
  (+ an optional posting **URL**, a stored string that is **never fetched**) → **Analyze** (Parser →
  `JobSpec`) → a confirm step (detected role + must-haves, listed plainly) → **Create application**
  (Tailor, server-side) → the new CV opens at `/workspace?cv=<id>`. Paste-text is the only functional
  input in v1; the Link/File tabs are deferred chrome.
- **Flow:** the tailored CV renders in a live **preview** (the same `ResumeTemplate` the PDF prints).
  Edit bullets **directly on the CV paper** — the single editable surface (DevPR14/ADR 0012): click a
  line to edit; typing updates the live preview **on every keystroke** (a client draft overlay) and
  re-runs the deterministic **slop heuristics**, and the edit **commits on blur** (no Save button). The
  left structured editor is a **read-only navigator** (DevPR16) — a read-only Summary card + the same
  bullets (with their checks); clicking a bullet jumps to and focuses the matching line on the paper. The top bar's
  **Posting** button opens the **Posting drawer** — a right-anchored slide-in showing the stored
  `JobSpec` (source text, optional URL, must-haves, ATS keywords; **text source only** — no PDF/file;
  the present/missing-vs-CV colouring lives in the Gatekeeper sub-view).
- **AI review (advisory):** the review **rail** is the **right-hand pane** (the desktop three-pane —
  editor | preview | review, ADR 0012/DevPR13; it stacks into the Reviewers tab below the fit threshold).
  Reskinned to the design's rail (DevPR15): the **Review** trigger + the live per-agent **checklist**
  while a run streams, then — once settled — an **agent roster** (the six panel agents with a per-agent
  finding count that mirrors the threads; Parser/Tailor are create-time and carry no count; a count slot
  only shows when there is a signal, so a pre-review roster never reads a false "0" — and a
  **version-drifted** roster keeps its real counts/statuses, dimmed via border/fill desaturation only,
  ADR 0016), a compact clickable **Gatekeeper
  card** (decision + ATS score + a recruiter-note snippet; opens the full `?view=gatekeeper` read;
  stale-marked with an **"Out of date"** chip when drifted), the
  per-agent **threads** (line edits / fact-checks / voice screen) in collapsible disclosures **and
  inline** on the editable bullet they anchor to, and **Apply corrections**. **Review** streams the SSE
  fan-out (Fact-Checker + AI-Language Spotter always; + Editor + Gatekeeper when the CV targets a job).
  Per-agent and run-level failures surface honestly — the run-level error stays in the rail (a soft warn
  note that also reads a user **Stop** benignly), not a banner. It never gates export. **On the paper
  (DevPR17):** each reviewed bullet gets an **in-margin marker** in the paper's right gutter; selecting it
  opens an **in-place ReviewNote** — the note's content + **Accept & fix** (runs the Corrector on that one
  line), **Sign off to export** (only for a net-new bullet), **View diff**, and **Dismiss**. Because a line
  is rewritten **once** (ADR 0014), a bullet carrying more than one actionable note shows a single
  **Accept & fix all (N)** that addresses them together (dismiss any you don't want first); a *supported*
  fact-check is a read-only **"verified ✓"** chip — never counted in the "(N)" and never rewritten. The
  in-margin marker's badge counts only the **actionable** notes (a verified-only bullet shows a distinct ✓
  glyph, no number), and its label reads "N to fix, M verified". Markers are a measured overlay (desktop,
  full-width paper only — zero render-path change); on mobile/narrow the left navigator's inline notes plus
  the rail's **Apply corrections** (which is whole-line consistent — accepting one note on a line rewrites
  it to address every note on that line) remain the way to act on feedback.
- **Restore + silent autosave (ADR 0013 / S4):** the settled run is persisted server-side and **restored
  on return** — reopening the CV rehydrates the verdict, the per-agent roster, the threads, and your
  accept/reject decisions, so the panel picks up exactly where you left it. Decisions are a **silent
  autosave** (owner decision — no Save button): each accept/reject PUTs on click behind a single-flight,
  trailing-latest queue, mid-stream decisions flush on settle, and a **keepalive** flush covers leaving
  the tab. A restored verdict that predates a later save stays visible **stale-marked** (ADR 0016 —
  the card's "Out of date" chip, or a caption built from the canonical "CV changed since this review —
  re-run to refresh" phrase when no verdict exists); the accepted bullet notes still apply. Degraded
  states are honest: a run
  that **finishes but can't be saved** says so and stays **local for the session** (it won't survive
  leaving the page — decisions included), and a failed decision-save shows a soft "it'll retry on your
  next click" note (no auto-retry loop). Advisory throughout — persistence never gates export.
- **Gatekeeper sub-view (B3):** the header **verdict cluster** (`TopbarVerdict` — shown once a
  same-cv review carries a Gatekeeper verdict; when the review is version-drifted it stays visible with
  a short **"Out of date"** chip and the full canonical phrase in its accessible name, ADR 0016) opens
  a full-screen `?view=gatekeeper` read of that live verdict (ADR 0011; the
  review run now persists to a latest-only snapshot per ADR 0013, though verdict *history* stays a
  non-goal): the ATS **gauge** + decision ring, `recruiterNotes` as a serif
  "20-second recruiter read", the posting's **must-haves** tagged met/unmet, **present/missing keywords**,
  and the recruiter **fixes**, each row carrying an **explicit state** so no row is ever dead and
  unexplained: an **applicable** bullet fix opens in the editor where Accept→Corrector lives; a
  permanently non-actionable fix — a non-bullet anchor **or a bullet outside the editable
  work/projects sections** (education/skills) — is **advisory**; a fix on an **applied** bullet shows
  a **✓ Applied** chip — `resolvedAnchorIds`, whole-bullet per ADR 0014, bullet-anchored only so a
  cross-kind id collision never fakes it — and the card's "N applied — re-run Review to re-check"
  note drops its tail while the stale banner shows; a **fresh** review's fix blocked only by an
  unsaved draft on its bullet is **blocked-dirty** (a muted "Save your edits first" microcopy, no
  button); only a **version-drifted** review's blocked bullet fix is **stale**, with **no tag**,
  never "Advisory" — the stale banner is guaranteed co-present and explains it.
  Met/present derive from the stored `JobSpec` minus the verdict's
  negatives with normalized matching (`gatekeeperMustHaves`/`gatekeeperKeywords`). A **drifted** verdict
  renders the full read under ONE stale banner (the region's single carrier — ADR 0016) rather than
  swapping to the empty state. When there's no live
  verdict it shows a designed empty/stale state (no CV open / no target job / review running / drifted
  with no stored verdict / Gatekeeper failed / not yet reviewed). Entering preserves `?cv=`, so the in-session
  verdict survives; a **`?cv=` reload now rehydrates the persisted review (ADR 0013)** so the verdict
  survives the reload too — only the global nav (no `?cv=`) lands on the empty state. Owner-only.
- **Diff sub-view (ADR 0015):** a `?view=diff` mode that shows **every bullet whose saved text changed
  since the review ran** — applied corrections **and** manual edits — matched by stable `bulletId`: one
  card per changed bullet (a **neutral** heading, no per-line agent attribution) and a serif BEFORE/AFTER
  with **word-level marks** (semantic `<del>`/`<ins>`, the colour on a tint + strikethrough so the text
  stays AA). It is **derived** each visit from the review-start baseline (`reviewedText`) vs the current
  saved CV — so it is **cumulative** across a session's applies and **survives navigation/reload** (both
  inputs are persisted; no captured copy, no stale state, no snapshot table). It reads the **saved** CV, so
  an unsaved keystroke never shows. Reachable from the ReviewNote's **View diff** and from a low-emphasis
  top-bar **View diff** link (shown whenever there are changes, even with no marker open). Absent a review,
  a designed empty state. Owner-only.
- **Accept / Apply corrections:** each **bullet-anchored** review note (on an editable bullet, except a
  *supported* fact-check, which is positive) gets **Accept / Reject** inline; accepting ≥1 enables
  **Apply corrections (N)**, which sends the accepted notes to the **Corrector** (Claude — per-bullet
  since DevPR29, with an optimistic preview paint that rolls back on failure) → the
  re-grounded CV reloads into the preview (ids intact; a corrected net-new bullet still needs sign-off).
  **Apply resolves, it doesn't wipe (ADR 0014):** the applied bullets' notes flip to a non-actionable
  "Applied — re-run Review to re-check" ✓ chip (server-side `resolvedAnchorIds` on the bundle —
  whole-bullet granularity in v1), while **every other advisory, the review row, and your decisions
  survive** — so you can work through notes one at a time.
  The gate is **NOT** export-readiness: `canApplyCorrections` = ≥1 accepted note, no unsaved drafts,
  nothing else mutating/applying/reviewing — sign-off is not required. `item`/`section`/`summary` notes
  stay advisory-only in v1.
- **Two-level freshness (revised by ADR 0016):** the whole-CV **verdict + panel threads** are shown
  **stale-marked** on a committed save (they judged the prior `cv.version`) — never hidden: ONE
  carrier per region owns the canonical cause-neutral phrase **"CV changed since this review — re-run
  to refresh"** (the header/card **"Out of date"** chips carry it in their accessible name; the rail
  caption and the Gatekeeper banner render it; roster/threads only desaturate). **Bullet inline
  notes survive per-bullet** — only the bullet whose saved text drifted from the review (or is dirty)
  goes stale (flagged in TEXT: the "· edited — re-run" summary suffix + an `--ink-warn` status line,
  never an opacity dim, and Accept is removed), so saving one manual edit doesn't wipe the accepts
  on the others.
  **Apply keeps the review (ADR 0014):** it resolves only the applied bullets' notes (✓ chips) and
  preserves the other advisories + decisions; the version-drifted whole-CV verdict stays visible,
  stale-marked, until a re-run (ADR 0016). Re-tailor still starts fresh.
- **Sign-off gate (invariant 2):** net-new bullets must be signed off before export. The top bar shows
  a **Sign off N** action while any remain (DevPR12); sign-off and export are **disabled while any
  draft is unsaved** (so you can't approve/export stale text) and while a save is in flight.
- **Export:** the top bar's **Export ▾** menu (PDF / DOCX / ATS-text) opens the existing gated render
  routes; when export is blocked it becomes a non-actionable **Export blocked** pill carrying the
  prioritised reason (unsaved edits first, then unsigned net-new). The server gate is the real enforcement.
  Before opening, the screen re-checks that the preview matches the latest server `cv.version` and, on
  a stale multi-tab mismatch, reloads the preview + warns instead of exporting — so what you export
  matches what you see.
- **Applied → tracking:** once a CV is signed off + exportable, the top bar's **Applied** (DevPR12) opens a
  confirm dialog (job title/company/URL/note) that **locks** the CV to that job and moves it to the
  [Applications tracker](applications.md). A locked CV is immutable: edit/sign-off/apply/delete are
  refused (409 `cvLocked`), and opening `/workspace?cv=<applied>` redirects to the application detail
  rather
  than the editor (the lock is visible on load, not only on a failed write).
- **Reload-safe & shareable:** a created or opened CV lives at `/workspace?cv=<cvId>`. Reloading that
  URL re-reads the persisted CV, so it survives a refresh (previously the open CV lived only in React
  state and was lost on reload). A bad/foreign/deleted id shows a **not-found** card; a transient read
  failure shows an **error** card with Retry. Switching between CVs is a plain link
  (`<a href="/workspace?cv=…">`), so each open is a clean history entry.
- States: loading (auth) / forbidden (access revoked mid-session → 403) / idle (empty preview) / parsing / tailoring /
  preview / saving / **not-found** (a `?cv=` id that doesn't resolve) / **error** (a cv read failed →
  Retry / Back) / banner error (e.g. provider key missing → `/admin`). Review adds: **streaming**
  (per-agent checklist) / settled-with-verdict / **per-agent failed** ("couldn't run") / **run-level
  failed** ("couldn't complete") / **verdict-unavailable** / **no-target-job** / **interrupted vs
  stopped** / **version-drifted** (verdict shown stale-marked — "Out of date" chips + the canonical
  re-run phrase, ADR 0016; bullet notes survive) / **per-bullet stale** /
  **503** (review agents not configured → the Admin nudge). Apply adds: **accept/reject** per note /
  **apply disabled** (no accept / unsaved drafts / accepts-went-stale / applying…) / **applying** /
  **apply 409 `cvLocked`** (→ tracker) / **apply 409 stale** (reload + re-review) / **apply 422/503**.
- **AI readiness:** the shell reads `GET /admin/providers` and derives `tailorReady`
  (`@/lib/ai-readiness`) — true iff the Anthropic key **and** a strong-tier model are set (the same
  condition the backend resolver enforces). Tri-state `unknown | ready | not-ready`: while `unknown`
  (in flight) or `ready`, **Tailor to job** is the primary action and the no-AI draft is the secondary
  ghost; a definitive `not-ready` **inverts** them (the working no-AI draft becomes primary and a
  **Configure AI → Admin** link replaces Tailor), and the rail shows a **Set up AI** pill. Readiness
  refreshes after admin key/tier changes and on tab refocus. The server still 503s a premature tailor —
  this is proactive guidance, not the enforcement. **Review** has its own `reviewReady` — true iff
  **both** OpenAI **and** Anthropic have a key + a strong-tier model (the fan-out resolves to both
  providers), so it's gated separately from Tailor; a `not-ready` Review shows the same
  **Configure AI → Admin** nudge in the review panel.

## Implementation
- `frontend/src/app/(app)/workspace/page.tsx` — the screen (phase machine, single-flight
  `mutating` lock, the three-pane layout — ADR 0012/DevPR13). It splits into a thin `<Suspense>` wrapper + a
  `WorkspaceClient` (required to read `useSearchParams()` on a statically-optimized route); a
  `cvParam`-reactive, **ref-guarded** effect loads `?cv=` (server-gated; a valid id wins over the
  master-existence gate since `read_cv` returns the CV's own master
  snapshot). `openCreated` `router.replace`s the `?cv=` URL, and the ref guard makes that re-run a
  no-op (no double-read / draft clobber). **B2a** extracted the `preview`-phase render tree into
  behaviour-preserving sibling components — `EditorPanel` (edit-bullets + sign-off/export, owning
  `OriginBadge`/`SlopFlags`), `PreviewPanel` (the serif paper + `ResumeTemplate`), and (originally) a
  `ReviewRail` wrapping `ReviewPanel` + the settle-time `aria-live` — with shared style atoms in
  `styles.ts`; `page.tsx` keeps the state/handlers + the job/header/dialogs (the orchestrator). **B2b** reskinned
  those panels to the Claude design: `PreviewPanel` became the dotted "drafting table" surface
  (radial-gradient on `--panel-2`) with the paper centred on it — `ResumeTemplate` already renders the
  full 660px paper frame, so the old wrapper's second frame was dropped (no `src/render/` change,
  invariant 3); `EditorPanel` gained the `STRUCTURED EDITOR` eyebrow + one panel card per work item
  (a `--panel-2` header with role / company · dates) wrapping the bullet boxes, each carrying a
  left-accent flag (warn = needs sign-off, bad = a major slop flag). A successful Apply now flashes
  the freshly-corrected preview via an **overlay band** (the `flashfix` keyframe) that is a sibling of
  `ResumeTemplate` — never a class on a template bullet (invariant 3). **DevPR8** adds a second such
  sibling overlay: a **page-break guide** (a measured dashed rule + "page N" chip every A4 page-height,
  `PreviewPanel.tsx` only) that shows **only** while the paper is at its full 660px width and hides on
  reflow — an APPROXIMATE aid (Chromium floats real breaks; offset is Playwright-calibrated), never the
  exported document. **B2c-i** added the
  **Editor / Preview / Reviewers tab bar** below the **ws-tabs breakpoint**, reconciled from the old
  1140/860 rules; **DevPR19** made that breakpoint a single **`<1120px` on width alone** (earlier
  revisions gated the three-pane on rail state — DevPR6's collapsed-rail rule and DevPR13's
  ~1280px / ~1120px-rail-collapsed split are retired): at **≥1120px** all three panes show side by side
  (DevPR13/ADR 0012 makes them a true editor | preview | review three-pane); below it the
  panes stack and a `wsTab` state (default `preview`) gates to one pane at a time via CSS
  (`data-ws-tab` on `.ws-cols` + `.ws-tab-*` classes) — panes stay **mounted** (`display:none`), so
  refs/focus survive a switch. The settle handlers flip the tab (review done → `reviewers`, apply
  done → `preview`) and move focus to the surfaced pane — but only via `autoFocusOnSettle`, which
  skips the move when focus is in a textarea or an in-paper contentEditable bullet (an active edit) or on a control the user has tabbed to
  outside `.ws-cols` (no focus-stealing, WCAG 3.2.5 — DevPR4). Because Accept/Reject live in the
  editor pane while **Apply corrections** lives in the AI-review card, the editor shows a single
  static **"N staged — press Apply corrections"** CTA when ≥1 note is accepted, so accepting a note
  (which only *stages* a correction) doesn't read as a no-op (DevPR4). `ReviewRail` was **folded
  away**: `ReviewPanel` renders directly in the
  Reviewers pane and the **single `aria-live` region is hoisted to `.ws-cols`** so a "review
  complete" / "applied" announcement is spoken on any tab (dec #9 preserved). The header carries a
  live **Gatekeeper verdict cluster** (`TopbarVerdict` wrapping `VerdictPill` — shown for any same-cv
  verdict, stale-marked "Out of date" when version-drifted, ADR 0016) and the **Reviewers tab a
  note-count badge** (open+working = inline notes not rejected). **DevPR14** moved editing into the CV
  paper: `ResumeTemplate` gains an optional `editableBulletIds` (preview-only `contentEditable`; the
  export/`/print` path omits it → byte-identical, invariant 3), `PreviewPanel` event-delegates focus/
  input/blur off `data-bullet-id` (commit on blur via `saveBullet`; editing suspended while a write is
  in flight), `overlayDrafts` **freezes** the focused line (caret-safe), and `EditorPanel` became a
  read-only mirror. **DevPR15/16** then rebuilt both side panes to the design: the right pane is the
  **review rail** (a settled agent roster + a Comments empty-state + a compact clickable Gatekeeper card
  + threads + Apply, via a shared `agentRosterStatus`/`AGENT_STATUS_TEXT` helper and an in-place
  `VerdictCard` refactor reusing `VerdictPill`; the run-level error stays an in-rail warn note), and
  `EditorPanel` became the design's **read-only structured navigator** — a read-only Summary card + bullet
  rows that are real `<button>`s (`onSelectBullet` → `setWsTab` + scroll-to + focus the matching
  `data-bullet-id` on the paper, write-busy- and reduced-motion-aware).
  `frontend/src/app/(app)/workspace/logic.ts` — pure request builders
  + selectors + the `overlayDrafts` live-preview overlay (unit-tested in the node env). Only
  **work & project** bullets are editable in v1 (skills/education highlights aren't surfaced).
- `frontend/src/app/(app)/workspace/WorkspaceList.tsx` — the **application list** (the `/workspace`
  no-`?cv=` landing): fetches `listCvsRequest()` (`workspace/logic.ts`), renders the cards grid (a
  stretched-link card per CV) + the Start-application tile, refetches on `pageshow.persisted` /
  visibility, and owns delete-with-confirm + focus return. The grid is an intrinsically responsive
  `auto-fill`/`min()` CSS grid (no media query). `NewApplicationModal.tsx` (paste → analyze → confirm
  → create) and `PostingSidebar.tsx` (the drawer) are native `<dialog>`s reusing the shared modality
  pattern (`showModal()` — inert background, focus trap, focus-restore, Escape). `(app)/page.tsx` is
  now just a router: a pure redirect to `/workspace`. `workspace/logic.ts`
  adds the pure `withPostingUrl` (owner-URL merge) + `newApplicationError` (shared failure copy).
- `frontend/src/app/(app)/workspace/{ReviewPanel,ThreadList,ThreadCard,ReviewInlineBadge}.tsx` — the
  review surface (display + **accept/reject + Apply corrections**); `workspace/logic.ts` adds the pure
  core (`reduceReviewBundle`, `agentState`, `collectThreads`/`threadKey`/routing, `failureLabel`,
  `reviewStreamRequest`; PR-4: `decide`/`reviewedTextSnapshot`/`staleReviewBulletIds`/
  `isAcceptableThread`/`acceptedThreads`/`canApplyCorrections`/`applyFeedbackRequest`) consumed via the
  shared SSE spine (`@/lib/sse` `consumeSseStream` + `@/ui/AgentChecklist`). `reviewReady` lives in
  `@/lib/ai-readiness` and is exposed by `ReadinessProvider`.
- Responsive (DevPR13, ADR 0012; scroll model DevPR19): a viewport-bound **side-by-side three-pane** —
  editor (340px) | preview (flex) | review (286px), each its own scroll — from **1120px on width alone**
  (rail state no longer gates the reflow). Below 1120 the panes stack and the Editor/Preview/Reviewers
  **tab bar** gates one at a time (`data-ws-tab`, panes stay mounted). **One scroller per state:** at
  ≥1120 `.ws-page` is pinned (`height:100vh; overflow:hidden`) and each pane scrolls; below 1120 the
  body is the single scroller. Owned by `.ws-page`/`.ws-cols[data-ws-tab]` in `globals.css` (inline
  styles can't express a media query). Soft pane minimums let the side panes shrink so the center
  preview holds **≥340px**. In the three-pane range the center preview is usually narrower than the
  660px paper, so the paper reflows narrower and the page-break markers auto-hide (export unaffected);
  full preview==PDF wrapping returns once the preview pane can reach 660px (roughly **≥1410**, a little
  higher with the rail expanded). On the narrow column the review panel's per-agent disclosures are
  collapsed by default so the editor + preview stay reachable.
- Reuses `@/render/{ResumeTemplate,model}` (preview == export, invariant 3), `@/slop/heuristics`
  (`detectSlop`), and the `api()` client + same-origin `/workspaces/*` proxy.
- **The master is the stored per-workspace row** edited at [`/master`](master.md) (the structured
  Master editor, shipped in PR #31/#41): tailoring and the no-AI draft load it **server-side**, so
  provenance is grounded in stored truth, never client JSON. `DEFAULT_WORKSPACE_ID` is the
  client-safe `default` (`@/lib/workspace`).
- Backend: a new `POST /workspaces/{id}/cv/{cv_id}/edit` (`routes/cv.py` → `cv_store.edit_bullet`).
  It re-grounds **only** the edited bullet via `reground_bullet` (`app/ai/provenance.py`) and persists
  under an **optimistic version lock** (`_guarded_save`, shared with `sign_off`). See `ai-panel.md`
  for the agent split (this edit path runs no model — it's a deterministic human edit).

## Data model
- `EditBulletRequest{bulletId, text, baseVersion}` + `baseVersion` on `SignoffRequest`, in
  `backend/app/schema/cv.py` (`text` trimmed + bounded; `baseVersion` is the client's viewed version).
- `stored_cvs` mutations go through `_guarded_save`, an optimistic lock on the `version` column keyed
  on the client's `baseVersion` (stale tab → 409). No new tables. Regenerated `frontend/openapi.json`
  + `generated-types.ts`. See `data-model.md`.

## Tests
- Backend `backend/tests/test_cv.py`: edit allow/deny, net-new stays gated, **no-clobber** of another
  bullet's sign-off, blank/oversized text → 422, cross-tenant → 404, non-owner → 403, and a stale
  `baseVersion` edit **or** sign-off → 409 (client-visible optimistic concurrency).
- Frontend `frontend/src/app/(app)/workspace/logic.test.tsx`: request builders, selectors, draft overlay,
  overlay-through-`ResumeTemplate`, and the PR-4 apply core (`decide`, `staleReviewBulletIds` incl.
  edited-then-reverted-is-live-again, the shared `isAcceptableThread`/`acceptedThreads` incl.
  supported-fact-check + stale exclusions, decisions-survive-a-save, `canApplyCorrections`,
  `applyFeedbackRequest`) + the `ThreadCard` accept/reject render. **B1** adds the new-application core
  (`withPostingUrl` — trim/blank→null, no mutation; `newApplicationError` — 404/503/502/detail/generic
  mapping). The list / modal / drawer UI (hook + effect heavy) is the Playwright drive (§6, no jsdom in
  the node vitest env). Commands: `node scripts/quality-gate.mjs`.

## Decisions & trade-offs
- **In-paper editing** (ADR 0012/DevPR14): the **CV paper is the single editable surface** (per-line
  `contentEditable`, preview-only — the export path renders the same template without it, so exports are
  byte-identical; invariant 3); the left structured editor is a **read-only navigator** (DevPR16: a
  read-only Summary card + bullet rows that are buttons which jump to + focus the matching paper line). Editing is
  **text-only** (no add/delete/reorder bullets) to keep the sign-off gate + stable-id model intact; an
  edit **commits on blur** via the backend manual-save route. (Earlier slices kept editing in left-pane
  textareas with an explicit Save; DevPR14 moved it onto the paper.)
- **Live preview via a client overlay**, but **export uses the persisted bundle** and is blocked while
  dirty — the overlay never reaches an exported document (invariant 3).
- **Optimistic version lock keyed on the client's `baseVersion`** (not the row's current version) —
  catches a stale browser tab, not just two backend requests racing; fits the existing
  read-blob/write-blob store and reuses the `version` column.

## Known limitations & follow-ups
- [ ] Manual edits to a *grounded* bullet are **not** re-gated for truthfulness (provenance checks
      grounding, not text — the candidate authored the edit; fact-checking is a later agent layer).
- [x] ~~No structured Master editor yet~~ — shipped: the [Master editor](master.md) is the stored
      master's screen; the Workspace tailors from that stored row.
- [ ] No add/remove/reorder bullets.
- [ ] Apply corrects only **bullet**-anchored notes; `item`/`section`/`summary` notes are advisory-only.
- [ ] Resolution is whole-bullet (ADR 0014): applying one note ✓-resolves the bullet's sibling notes
      too (per-thread resolution needs a server-stable thread id — deferred).
- [ ] No SSE progress while the Corrector runs (a blocking call — per-bullet since DevPR29, so
      latency scales with the applied-note count, and the preview paints optimistically). The rail's **Apply** is a
      sticky footer at the 3-pane widths only (DevPR15); at stacked/iPhone widths it stays in-flow
      (reachable by scroll) — a viewport-sticky bar there would collide with the fixed bottom nav.
