# Renderer

Status: active — seed doc  
Last updated: 2026-07-23

Update when `frontend/src/render/**` changes (`render-change`). This is the renderer's **only**
doc — the old `docs/features/renderer.md` (a frozen Phase-1 snapshot this doc had outgrown) was
merged here and deleted. Its genuinely open items are tracked here — §Render targets (the ats-plain
PDF variant) and §Stability (PDF/DOCX byte-normalization); everything else it listed shipped
(backend fetch, blocked/error states, in-workspace preview + annotations + sign-off).

## The single-template guarantee (invariant 3)

One React component is the source of every rendered artifact:

```
{ master: MasterProfile, cv: TailoredCV }          (dates/company live on master; joined by sourceId)
  → model.ts toResumeDocument()  → ResumeDocument   (the view-model the design's "paper" renders)
      → ResumeTemplate.tsx        ← live preview AND the print surface (one component)
          → app/print/[cvId]      ← hidden, chrome-free; Playwright prints this page
              → GET /api/render/pdf?cvId=…   (Chromium navigates to /print/[cvId] → page.pdf, A4)
      → GET /api/render/docx?cvId=…  (docx-mapper.ts → `docx`, same ResumeDocument + template-tokens)
      → GET /api/render/text?cvId=…  (text-mapper.ts → ats-plain, same ordering)
```

`TailoredItem` references master entries by `sourceId` (the tailored copy carries no dates/company),
so `model.ts` composes the render view-model from **both** the master and the tailored CV.

**Resolving the render input.** The `sample` id stays on the bundled fixture (the argument-free `getRenderInput`, for
offline determinism + the design reference). Any other id fetches the real `{master, cv}` from the
backend's gate-checked `GET /workspaces/{ws}/cv/{id}/export` via the server-only
`getRenderBundle(cvId, cookie)` (`render/fetch.ts`), forwarding the session cookie and reusing the
proxy's backend base URL. Because it hits the **export** endpoint, the render path is gated by
invariant 2: when a net-new bullet still awaits sign-off the backend returns **409**, and the surface
renders a clear *needs-sign-off blocked state* instead of the document — so a blocked CV cannot be
exported, only previewed (via the un-gated `GET /workspaces/{ws}/cv/{id}` preview bundle). An
unreachable backend (bad `BACKEND_INTERNAL_URL` / ECONNREFUSED) is caught and surfaced as a clean
`502` (mirroring `lib/proxy.ts`), so the export routes fail consistently rather than throwing a 500.
Its diagnostic uses a constant format string and strips line separators from the workspace, CV, and
error fields; the forwarded session cookie is never logged.

**Synthetic sample only.** `frontend/src/render/fixtures.ts` and its tests use a clearly fictional
candidate, `example.com` links, an invalid example country code, and synthetic contact details. The
fixture is public test data, never a template for copying a real CV into source control.

**PDF auth handoff.** `/api/render/pdf` runs headless Chromium, whose request to `/print/[cvId]`
carries no session cookie of its own. So the route (1) prechecks the gated export with the caller's
cookie and relays any non-200 (401/403/404/409) **without launching Chromium**, then (2) injects that
same cookie into the browser context so `/print` renders the bundle the precheck authorized. The
`text`/`docx` routes fetch the bundle directly and relay the 409 before producing any artifact.

Preview = PDF **by construction**: the PDF is a Chromium print of the same component the user sees.
DOCX and ats-text derive from the same `ResumeDocument` + `template-tokens.ts`, so they stay in step.
**Next.js owns rendering** (ADR 0002): the render routes are co-located with the template, so there
is no separate render service to drift. `/print` is chrome-free (`@page` A4 print CSS drops the app
shell) and the document inherits the app's focus-visible / reduced-motion floor.

**Preview-only in-paper editing (DevPR14, ADR 0012).** `ResumeTemplate` takes an OPTIONAL
`editableBulletIds?: ReadonlySet<string>` that turns those bullets into `contentEditable`. It is
**default-off and only the live preview (`PreviewPanel`) ever passes it** — `/print` and the pdf/docx/
text routes render the template without it, so the export markup is byte-identical and exports are
unaffected (invariant 3). The template stays a **pure, handler-free function**: every edit handler is
event-delegated in the client `PreviewPanel` off `data-bullet-id` (so the `/print` RSC is never handed
an event handler — it would otherwise throw). Locked by `ResumeTemplate.test.tsx` (off-state emits no
`contentEditable`; the set adds it strictly per-bullet) + the `next build` / Playwright `/print` parity
pass. The live overlay (`overlayDrafts`) excludes the focused bullet so React never reconciles the
line being typed (caret-safe); the persisted bundle the export uses is never touched.

**Empty optional header fields render to nothing.** Since `Basics` only requires name+email
(`schema/master.py`), `label` (the italic title) and `summary` can be empty. The header **title** and
the **summary** block are conditionally rendered in all three surfaces — `ResumeTemplate.tsx`
(the `data-line="summary"` wrapper + the title div), `docx-mapper.ts`, and `text-mapper.ts` (which
also drops the leading blank line so an absent summary leaves no double gap) — so a sparse import
produces no empty italic line, no padded blank block, and no stray text-export blank. Contact fields
(location/email/**phone**/link) are filtered the same way — **phone** flows from `basics.phone` via
`headerOf()` and renders **between email and link** in all three surfaces (DevPR9), present-only so an
empty phone leaves no dangling separator. Locked by `ResumeTemplate.test.tsx`
("empty optional basics") and `ResumeTemplate.phone.test.tsx` (the phone mapping across HTML/ATS/DOCX).

**Languages (D2b).** Languages are **master facts**, not tailored output (no `sourceId`, no
provenance/sign-off — a candidate either speaks a language or doesn't), so they are **not** part of
`cv.sections` (the `SectionType` enum is work/projects/skills/education). Instead `model.ts` **appends
a single Languages section** to the `ResumeDocument` from `master.languages` when any are present, in
**authored order** (like skills — never date-sorted). Each entry is one string via the shared
`formatLanguage` (`"{language} — {fluency}"`, or just the language when no fluency stated), so the
per-entry text is **identical across all four outputs** — only the separator differs (chips on the
paper, ` · ` in DOCX, `, ` in ats-text). The DOCX/ats mappers branch **explicitly per section `kind`**:
a `languages` section must not fall through to the education `else` (it has no `items`). The Master
editor edits languages as a structured list (`LanguageDraft`, mirroring skills). Locked by
`ResumeTemplate.test.tsx` ("languages (D2b)").

## Ordering (reverse-chronological)

`model.ts` sorts **Work** and **Education** reverse-chronologically (most recent first) as it composes
the `ResumeDocument`, so all four outputs (preview, PDF, DOCX, ats-text) share one order — the sort
runs once on the view-model, never per-renderer. **Projects keep their authored order** (a deliberate
curation, not a timeline).

The comparator (`orderByRecencyDesc`) is **Date-free and deterministic** — invariant 3, and
`check-invariants.mjs` fails the gate on any wall-clock `Date` under `frontend/src/render/`. The sort
key is `(endRank, startRank, resolved, originalIndex)`. A shared `parseYearMonth` does the string work
(the master stores `start_date`/`end_date` as plain strings) and the rest is policy:

- `parseYearMonth` takes the **trailing** 4-digit year and the month **bound to that year's token** (the
  trailing `YYYY-MM` / `MM/YYYY` / `Mon YYYY`), so a stray earlier date in the same string can't supply
  the month. An ambiguous full numeric date with a day (`NN/NN/YYYY` — US `MM/DD` vs `DD/MM` unknowable),
  or any unrecognised month, collapses to year-only ordering. No 4-digit year ⇒ `null`.
- **`endRank`** maps an empty value, or an explicit ongoing marker
  ("Present"/"Current"/"ongoing"/"now"/"to date") — **even alongside a year**, e.g. `2020 – Present` — to
  `+∞`, so a current role/programme sorts first (the ongoing check runs *before* year parsing); an
  unparseable end is `-∞`.
- **`startRank`** is the secondary key: it does **not** treat empty/ongoing as `+∞` — an empty or
  unparseable *start* is the *oldest* (`-∞`), so a blank start can't masquerade as the most-recent start
  when two roles end the same year. (Two roles ending the same year order by the more-recent start — the
  recruiter convention.)
- **`resolved`** comes next: an item whose `sourceId` does **not** resolve to a master entry is
  `UNRESOLVED` (both ranks `-∞`, `resolved: false`) and sinks **below every resolved row** — even one
  whose own dates are equally unparseable — rather than masquerading as the current role at the top.
- The **original array index** is the final stable tiebreak for genuinely equal entries. `±∞` ranks are
  compared by `<`/identity, never subtracted, so two ongoing roles don't yield `∞ − ∞ = NaN`.

Because the order is derived once in the view-model, reordering does **not** touch any stable id —
`itemId`/`bulletId` ride along with their item — so review-note anchoring (invariant 7, "tracks its
bullet through rewrites and reorders") is unaffected.

**The editors display in the same order (D1b — WYSIWYG).** `orderByRecencyDesc` is **exported** from
`model.ts` and reused so the editable lists match the rendered CV, not some other order:

- The **Master** editor sorts work + education **on load** (`draftFromMaster`). Sort-on-load, *not* live:
  the array is sorted once, the index-based edit handlers (`setWork(i, …)`) then edit that sorted array
  in place and it never re-sorts, so editing a date doesn't make a card jump and no edit is mis-targeted.
  The stored order is immaterial (the renderer always sorts), so a load-then-save quietly rewrites the
  persisted order to reverse-chron — harmless, and idempotent thereafter.
- The **Workspace** structured editor sorts inside `editableItems(cv, datesOf)` — **per section**, the
  same rule the renderer uses: only a `work` section sorts by recency; a `projects` section keeps its
  authored order **unconditionally** (the renderer gates on `sec.type === "work"`, never Projects, even
  if a project id happens to resolve), and the sections stay in `cv.sections` order. It never edits
  dates, so the order is stable.

Edits stay keyed by stable id (`bulletId` drafts in the workspace; the Master editor's React keys are
`w.id`), so sorting the display never mutates a bullet's identity or anchoring.

Locked by `ResumeTemplate.test.tsx` ("D1 reverse-chronological ordering"), which proves the order on
the view-model and its parity through the **markup and ats-text** from an intentionally out-of-order
fixture, plus the parser edge cases (ISO/slash/month-name, ongoing-with-year, trailing-token binding,
unparseable-sinks, start-date tiebreak, dangling `sourceId`). The **DOCX** derives from the same ordered
`ResumeDocument` (`docx-mapper.ts` iterates `section.items` in order) and is smoke-tested for validity;
its order parity is verified at the binary level during live render verification.

## Render targets

- **human-pretty PDF** — the designed CV on cream "paper" (Source Serif 4). *Implemented.*
- **DOCX** — same content via the `docx` lib. *Implemented.*
- **ats-plain text** — single-column, text-extractable (the candidate's `.txt` export). *Implemented.*
  (The AI adjudicators do **not** read this — they read the structured `TailoredCV` JSON, which carries
  every stable id; ADR 0010.)
- **ats-plain PDF** — a future `variant` of `ResumeTemplate` (single-column, no shadow). *Planned.*

## Stability for a pinned toolchain

Re-rendering identical JSON must produce stable output. To get there:

- Pin the Playwright + Chromium version (frontend lockfile + Dockerfile).
- Bundle the three fonts (Archivo, IBM Plex Mono, Source Serif 4) into the image — same fonts as the
  app (`src/lib/fonts.ts`), so the PDF matches the preview.
- Fix locale/timezone in `page.pdf()`; **no `Date.now()` / randomness** anywhere in the render path.
- Paginate the preview in an A4/Letter frame matching the print CSS, so on-screen pages == PDF pages.

"Byte-identical" is not achievable even within a pinned toolchain — both Chromium and `docx` embed
wall-clock metadata. The gate therefore asserts byte-stability only on the parts that are
deterministic in node (the view-model, the template markup, ats-text); PDF/DOCX are visual/parity-
verified, with these caveats:

- **PDF byte-stability caveat:** the PDF matches the preview by construction (it prints the same
  page), but Chromium's `page.pdf()` embeds time-dependent metadata (`/CreationDate`, `/ModDate`, and a
  trailer `/ID`), so raw PDF bytes are not byte-identical run-to-run. Stripping/normalizing that
  metadata for true byte-stability is a tracked follow-up; preview==PDF parity is Playwright-MCP-verified.
- **DOCX byte-stability caveat:** the document model is deterministic, but a `.docx` is a ZIP and
  `docx`/JSZip stamps the package with wall-clock time, so raw `.docx` bytes are not yet byte-identical
  run-to-run. The gate asserts determinism on
  the view-model, the template markup, and ats-text (all byte-stable in node) plus a `.docx` validity
  smoke; normalizing the ZIP entry timestamps for true `.docx` byte-stability is a tracked follow-up.

## Backend interaction

The backend never renders, and does not call the frontend for rendering — the AI adjudicators read
the structured `TailoredCV` JSON, not rendered text (ADR 0010). The render flow runs the other
direction: the frontend's render routes (`/api/render/{pdf,docx,text}`) and `/print` fetch the real
`{master, cv}` from the backend's gate-checked export route, forwarding the session cookie and
refusing before producing an artifact when the sign-off gate blocks.
