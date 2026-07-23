# Feature: Master editor (the canonical CV)

Status: shipped (open items live under Known limitations)  
Last updated: 2026-07-03

## Purpose

The master profile is the product's ground truth: every tailored bullet's provenance anchor
(`sourceId`, invariant 2) must resolve to a real master entry, and the Workspace tailors / drafts
from the **stored** master, loaded server-side. This screen (`/master`) is where the candidate
builds and maintains that master — a fully keyless structured form (no AI involved), shipped in
PR #31 and reskinned/extended in PRs #41 (C2 design), #43 (Languages), #53.

## User-facing behaviour

- **Route `/master`** (owner-gated server-side; every allowlisted account is an owner). The app
  shell's session gate handles a 401. First run (no master saved → the backend reads **200-null**)
  starts a blank form; a **Start from sample** control loads the bundled sample into the form to
  edit and save as your own. (The editor keeps a 404 arm for the deploy-skew window — an old
  backend still 404s a first run; removal is a tracked follow-up.)
- **Structured form, explicit Save.** The candidate name is the page `<h1>` (the design's 24px
  display name) over a live profile-preview header (contact parts join and drop blanks); section
  labels are mono-eyebrow `<h2>`s. Only **name + email block a save** (red); the other basics
  (label, phone, location, website, summary, profiles) are recommended — they default empty and
  nudge rather than block (the PR #30 relax). Save is a **validated full-replace `PUT`**: a
  validation failure lists the offending fields on the banner, and when the first offender is a
  collapsed **skill / language / education** entry it **auto-opens + focuses that entry's field**
  (`firstInvalidEntry`, derived client-side from the same predicate `toMaster` applies — never by
  parsing its error strings; basics/work fields are always visible, so their errors stay
  banner-only). On success the message points at the Workspace ("tailor or draft a CV").
- **Work history** — one card per entry (position, company, dates, tags, highlights). Stable ids for
  entries and highlights are **generated once and kept hidden**, so a tailored bullet's `sourceId`
  stays valid across edits; the backend 422s a blank / duplicate / colon-namespaced id.
- **Skills + Languages are flat chip clouds** (chip label `name · level` / `language · fluency`),
  each with an "Add a …" input (Enter or button; case-insensitive + trimmed dedupe with an
  "already added" `role="status"` note) and an inline chip editor — a chip is two sibling buttons
  (body toggles the editor, × removes), never nested interactives. **Education is a read-stack** of
  ≥44px rows that expand in place to the structured fields + a Remove. Exactly **one inline editor
  is open at a time** (opening entry B commits-and-closes A). Languages render full-width below the
  Skills/Education row and mirror Skills exactly (a shipped extension the mockup lacks).
- **Add source → import modal (C4).** The banner's "Add source" CTA opens the ingestion
  `ImportModal` (see [ingest.md](ingest.md)); `/ingest` survives only as a redirect to
  `/master?import=1`, which auto-opens the modal once through the same guards. Guards: the draft
  must be **clean** (save or discard first — import updates the *saved* master, and a later
  full-replace Save would silently overwrite the imported items), no save may be in flight, and
  after an import applies the editor flags **"Reload to pick up your imported items"** — Save and
  Add-source pause until the one-click Reload (no silent auto-reload; it would race back-to-back
  imports and resumed edits). Focus returns to the Add-source trigger when the modal closes.
- **Display order is the render order (D1b).** Work + education sort most-recent-first **on load**
  (the same `orderByRecencyDesc` the renderer uses) and never re-sort mid-edit, so editing a date
  doesn't make a card jump; a load-then-save persists that order (harmless — the renderer always
  sorts).
- **States:** loading / **load-error** (Retry; editing stays blocked so a
  save can't overwrite an existing master with a blank form) / ready / saving (single-flight) /
  save-validation error (banner + auto-focus) / save 422 from the server / post-import
  needs-reload / first-run blank.

## Implementation

- `frontend/src/app/(app)/master/page.tsx` — the screen (phase machine, the single open inline
  editor as page-level state, the import guards + `?import=1` auto-open, focus management by shared
  DOM ids). Reuses `ImportModal` from `(app)/ingest/` and the `src/ui` primitives. The C2 reskin +
  its named divergences (structured inputs vs the mockup's contenteditable, chip/target sizing) are
  recorded in `docs/architecture/design-system.md` §Master editor.
- `frontend/src/app/(app)/master/logic.ts` — the pure core: request builders
  (`getMasterRequest`/`putMasterRequest`), the `MasterDraft` ↔ `MasterProfile` mapping
  (`draftFromMaster`/`toMaster` — trims scalars, splits comma-separated keywords, preserves
  `certificates` verbatim even though they aren't edited here), chip add/dedupe
  (`addSkillFromInput`/`addLanguageFromInput`), `firstInvalidEntry`, `contactParts`, `newId`.
- Backend: `backend/app/routes/master.py` — `GET /workspaces/{id}/master` (owner-gated;
  **200-null** until one is saved — probe parity with the review-latest GET) and `PUT` (owner
  upsert; **422** on a blank identity or a blank/duplicate/unsafe stable id). Store:
  `backend/app/persistence/master_store.py` (`stored_masters`).

## Data model

- `MasterProfile` (`backend/app/schema/master.py`): `basics` (only `name`+`email` are `NonBlank`
  required), `work[]`, `education[]`, `skills[]`, `languages[]` (present-list, D2a), and a
  persisted-but-uneditable `certificates` (see the ingest known limitation). One `stored_masters`
  row per workspace (the profile as a jsonb blob + created/updated timestamps — `workspace_id` is
  the primary key). See `docs/architecture/data-model.md`.

## Tests

- Backend `backend/tests/test_master.py` — 200-null-when-unset, PUT→GET round-trip,
  non-member denied, cross-tenant isolation, 422s (duplicate/colon/blank
  ids, blank identity), concurrent-first-save last-write-wins.
- Frontend `frontend/src/app/(app)/master/logic.test.tsx` — D1b ordering on load, contact parts,
  request builders, sample round-trip byte-for-byte, stable ids unchanged through the round-trip,
  name+email-only validation, chip add/dedupe, language validation (D2b), certificates preserved.

## Decisions & trade-offs

- **Structured inputs + an explicit validated Save**, not the mockup's autosave-on-keystroke
  contenteditable: the master `PUT` is a full replace requiring name+email, so keystroke-time PUTs
  would write partial/invalid data (design-system.md names the divergence).
- **No auto-reload after an import** — an explicit Reload beats silently swapping the draft under
  an editor mid-flow; the trade-off is one extra click and a paused Save.
- **Sort-on-load, not live** (D1b): WYSIWYG order without cards jumping mid-edit.

## Known limitations & follow-ups

- [ ] Full-replace PUT: concurrent owner edits are last-write-wins (invariant 7 — a designated
      LWW snapshot write in the single-user model), with no field-level merge.
- [ ] `certificates` are preserved verbatim but not editable/visible here (stored-but-invisible —
      see [ingest.md](ingest.md) Known limitations).
- [ ] No projects editor — `MasterProfile` has no projects field; project sections exist only on
      tailored CVs.
