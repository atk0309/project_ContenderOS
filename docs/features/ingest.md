# Feature: Profile ingestion — build the master from a CV / LinkedIn document

Status: shipped — text paste + PDF upload, structured review (accept / decline / edit), Reconciler
enrich/correction against an existing master, advisory Judge badges, SSE per-agent progress, the
import-as-modal flow from the Master editor, and language proposals. Certificates are no longer
proposed (DevPR31 — see Known limitations).  
Last updated: 2026-07-03

## Purpose

The master profile is the source-of-truth every tailored CV's `sourceId` provenance anchor points
back to, but it could only be created by hand-POSTing a full `MasterProfile` JSON. This feature lets
the owner **build and enrich the master from real documents** (a pasted CV / LinkedIn export, or an
uploaded PDF) through an agent, reviewing every proposed change inline with accept / decline /
edit. Best automation + full personal control — the owner's accept is the gate.

## User-facing behaviour

- Owner **pastes their CV / LinkedIn text or uploads a PDF** (a CV, or a LinkedIn "Save to PDF"
  export) → the **Extractor** reads it (a PDF is sent to Claude as a native document block, ADR 0007)
  → the page shows **net-new proposals** grouped by kind (identity fields, work entries, education,
  skills, languages, profile links), each with a verbatim **evidence** snippet and an accept /
  decline / edit control. Certificates are **not** proposed (DevPR31): nothing renders or edits
  them, so accepting one only buried data in the stored blob — see Known limitations. (A scanned PDF whose text pypdf can't read still extracts natively, but its evidence
  snippets show **unverified** — flagged with a **visible note** explaining why, never blocking.)
- The advisory **Judge** marks some items **"Worth a look" / "Suggested skip"** with a one-line
  **reason shown beneath the badge** (generic copy when the Judge gave none, so a flag is never left
  unexplained). Advisory only — it never gates Apply or the bulk add; when the Judge is unavailable one
  quiet "suggestions unavailable" line replaces the badges.
- Everything persists `pending`; nothing changes the master until the owner accepts and **applies**.
  A one-tap "add all new items" (PR-B2) stages the lot; **Apply** commits — and on first run, **builds
  the master from scratch**. Only **name + email** are mandatory (a clear, humanized 422 names just
  those if missing, e.g. "needs a name and an email"); **headline, phone, location, and summary are
  recommended** — they don't block, and a successful import shows a yellow "for a more complete
  profile, add …" tip. Applying with items still
  unreviewed asks for confirmation in an **in-app dialog** (never a native popup a browser can silently
  suppress); a **blocked/failed apply** (first-run identity 422, staleness 409, or any other error)
  surfaces **in place and takes focus**, so the outcome is never missed below the sticky bar.
- States: extracting / review / applied / failed / **empty-or-unreadable** / error; uploads add a
  client-side **too-large** (>10 MB / 30 pages → 413) and **not-a-PDF / unreadable** (422) reject that
  resets the file input. One open run per
  workspace; a **discard** action frees a wedged/unwanted run. Closing + reopening the modal recovers
  the open run from the server (no URL deep-link since C4 — see below); a recent-imports list recovers
  a dropped run.
- Permissions: **owner-gated** (every allowlisted account is an owner); non-members fail closed.

## Implementation

- Backend: `routes/ingest.py` (owner-only) — a shared spine (`_prepare_run` cheap pre-flight + run
  row, then `_execute_run` for the agent phase; **content-negotiated** to stream per-agent SSE progress
  under `Accept: text/event-stream`, else block and return the bundle) behind both the paste
  route and the `POST .../ingest/file` multipart route (read → `ai/pdf_text.py` byte/page guard +
  text copy in a threadpool → base64 → native document block), with a **native→text-only fallback**
  (`_extract`) for an uploaded PDF; `agents/extractor.py` + `agents/ingest.py` (`run_extract` +
  `build_net_new_proposals`), `ingest_apply.py` (server builds/validates the master, mints ids),
  `persistence/ingest_store.py` (`create_run` records the upload `filename`) + the
  `ingestion_runs`/`ingestion_proposals` tables. See `ai-panel.md`.
- Apply runs in one transaction under the per-workspace advisory lock (`persistence/locks.py`),
  refusing on master-hash staleness; `PUT /master` takes the same lock so neither clobbers the other.
- Frontend: a **two-path "paste or upload"** input view (PR-C adds a labelled PDF file input + Upload
  button alongside the paste box; both share one `disabled`/in-flight guard so only one import fires at
  a time). The upload goes via a **raw `fetch` + `FormData`** (the shared `api()` helper forces JSON,
  which would corrupt the multipart boundary); the `/workspaces` proxy requires a sane content-length
  on the upload route (so a headerless/chunked body can't be buffered unbounded) with the backend
  chunked read as the authoritative cap. Both arms share a `landOnRun` success tail and an
  `ingestErrorMessage` mapper.
- Frontend: a **modal** opened from the Master editor's "Add source" (C4: Master absorbed Import). The
  flow lives in `app/(app)/ingest/ImportModal.tsx` (a native `<dialog>`; `master/page.tsx` hosts it). On
  a successful apply the host marks the editor **stale** and pauses Save + Add-source behind a one-click
  **Reload** banner — it does NOT auto-reload (a silent reload into the live editor would race a
  full-replace Save / back-to-back imports). `app/(app)/ingest/page.tsx` is a thin redirect to
  `/master?import=1`. Owner-only. Drop a PDF (the drop-zone) or paste text → a **live per-agent
  progress checklist** (F3b: raw `fetch`+`getReader` consuming the SSE stream) → **structured
  per-proposal review cards**: every field of each unit (work/education/skill/language/basics — plus
  legacy certificate cards on a pre-DevPR31 run, whose frontend branches are deliberately kept) is
  editable before it's accepted, sent as a full `edited: ProposalContent`. **Accept ≠ Apply** — Accept (or
  one-tap "Accept all") only stages; an unmissable sticky bar ("N ready · M to review") Applies the
  accepted set. Then a per-item "saved / skipped" summary + "Review your imported profile →" which
  builds the no-AI from-master draft and opens `/workspace?cv=<id>` (a bare `/workspace` only lands
  `idle`). **Recovery:** the recent-imports list is the primary recovery surface (a closed/lost modal
  or an edge timeout re-resolves to the open run, not a dead form). **Named divergence (C4):** there is
  no `?run=` URL deep-link — a modal isn't URL-addressable, so on open the modal resumes the server's
  open run and the recent-imports list re-opens any specific past run; Discard frees a wedged run.
  **Guards:** "Accept all" is disabled while any pending card has unsaved edits (else bulk-accept would
  commit stale extracted text); apply-409 → Discard-and-reimport; first-run-422 → escape to `/master`.
  Apply/Discard confirmations are **in-app focus-trapped modals** (Escape-dismissable, focus returns to
  the trigger), not native `window.confirm` (which a browser can suppress, silently aborting the
  action); `performApply` re-asserts the dirty/accepted guards at action time so the async confirm
  can't let an unsaved edit slip through. A blocked/failed apply renders one in-view `role="alert"`
  block that **scrolls into view and takes focus**, so feedback can't land off-screen below the bar.
  iPhone-usable (16px inputs, ≥44px targets, `viewportFit: cover` safe-area sticky bar) + a `role=status`
  live per-agent checklist (F3b: a single delta sentence in the aria-live region — since DevPR33 it
  also renders the backend's owner-voiced `agent_progress` status notes verbatim between an agent's
  start and done events — static glyphs for
  reduced-motion, a "Stop & check my imports" escape since the keepalives mean a stall has no implicit
  timeout). Pure logic + converters + the SSE frame parser in `app/(app)/ingest/logic.ts` (vitest).
  No CV is rendered in `/ingest` (it never touches the render path, invariant 3).

## Data model

- New wire models in `backend/app/schema/ingest.py` (`ExtractedProfile`, `IngestionProposal`,
  `IngestionRunBundle`, `PasteIngestRequest`, `DecideProposalRequest`, `BulkDecideRequest`,
  `ApplyResult`). New tables `ingestion_runs` / `ingestion_proposals` (`data-model.md`). Evidence
  lives on proposals, not the canonical blob. `MasterProfile.Basics` was relaxed so only `name` +
  `email` are required (both `NonBlank`); `label`/`phone`/`summary`/`location` default empty
  (`data-model.md`), so a sparse CV imports without blocking.

## Tests

- `backend/tests/test_ingest.py` — build happy-path, empty/503, owner-allow + non-member/
  cross-tenant deny, one-open-run 409, optimistic-lock 409, first-run-identity 422, staleness 409,
  discard. **PR-C adds**: the file-upload happy-path (+ stored filename), upload tenancy 403,
  `sourceType=pasted`/non-PDF/unreadable 422, too-many-pages 413, the `_extract` native→text fallback
  matrix (fall back on parse error; no retry on empty text / refusal / truncation), the `pdf_text`
  guard, and a 503-after-run-row (key-build-fails-post-create) → run `failed`. Frontend upload builder
  + guards + `ingestErrorMessage` in `app/(app)/ingest/logic.test.ts`. The PDF-block + `output_format`
  acceptance is a live spike in `test_providers.py` (ADR 0007).

## Decisions & trade-offs

- Native-PDF document blocks for the Extractor (ADR 0007) over pypdf-only text — multi-column/scanned
  inputs. Proposals persist server-side and apply by `proposalId` (not a client blob) so the server is
  the authority on what enters the master. Synchronous pipeline with a reaper (no job queue yet);
  PR-F streams its per-agent progress over SSE (content-negotiated) without backgrounding the run.

## Known limitations & follow-ups

- **Certificates: stopped proposing (DevPR31); already-applied ones are stored-but-invisible.**
  Ingestion no longer extracts or proposes certificates — none of the four render outputs
  (preview / PDF / DOCX / ATS) nor the master editor shows `MasterProfile.certificates`, so an
  accepted certificate entered the stored master and was invisible forever after. The persisted
  side is fully kept for compatibility: `IngestUnitKind.certificate`, `ProposalContent.certificate`,
  the apply-time merge, the frontend certificate review cards, and the `MasterProfile.certificates`
  field (persisted blobs are `extra='forbid'`) — a pre-DevPR31 open run still reviews and applies
  (locked by `test_legacy_certificate_proposal_still_round_trips_review_and_apply`). Certificates
  already merged into a stored master stay in the blob, shown nowhere. If certificates ever earn a
  render section (the Languages D2b pattern: one shared formatter across the four outputs +
  a master-editor block), re-enable proposing then.
- [x] PR-B2: the `/ingest` review UI (structured editing, accept-vs-apply, recovery, mobile/a11y).
- [x] PR-C: PDF upload (native document block) + the "…or upload a PDF" arm + native→text fallback.
  Owed: the live PDF spike with a real key; the Playwright `/ingest` upload walkthrough (key-gated
  happy path; key-free reject/empty/busy states verifiable now).
- [x] PR-E1: Reconciler (Claude — work matching by index) + server re-grounding + in-place
  enrich/correction in `ingest_apply` + the bulk **net-new** gate (ADR 0008). The live Reconciler
  spike (`test_run_claude_live_reconciler_spike`) is **RUN & GREEN** (real key, 2026-06-25). Owed: the
  Playwright `/ingest` reconcile states (enrich / correction current-vs-proposed / "no new items").
- [x] PR-E2: advisory **Judge** (OpenAI — the first OpenAI agent) + plain-language verdict badges +
  the degraded "suggestions unavailable" state (the Judge never gates apply or the bulk add, and an
  OpenAI outage can't block the run). The OpenAI live spike (`test_run_openai_live_spike`, the first
  live OpenAI structured-output call) is **RUN & GREEN** (real key, 2026-06-25).
- [x] PR-F/F1: per-agent observability — `agentId` logged on every provider call (AGENTS §8).
- [x] PR-F/F3a: SSE progress on the synchronous run (backend) — content-negotiated `text/event-stream`
  reusing `schema/sse.py`; per-agent `AgentStarted`/`AgentDone` + `RunDone{resultRef}`.
- [x] PR-F/F3b: the frontend SSE consumer — live per-agent checklist + escape hatch, streamed
  paste/upload. Owed: the Playwright `/ingest` walkthrough (the live verification, AGENTS §6).
- **Multi-document ingestion: dropped** — a master is built once then accreted one document at a time,
  and the Reconciler already dedups each new document against the existing master (so inter-document
  dedup already exists). **Prompt-caching (F2): deferred** to a key-gated slice (the per-call
  `output_format` likely busts the messages-tier cache → a re-spike must prove `cache_read>0` first).
