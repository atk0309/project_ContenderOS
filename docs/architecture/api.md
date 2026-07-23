# API and Integrations

Status: active — seed doc  
Last updated: 2026-07-03

Update when a route is added under `backend/app/routes/` (`new-api-route`) or
`backend/app/ai/providers/` changes (`provider-change`).

## Route handlers (`backend/app/routes/`)

Present: `health`, `meta` (codegen anchor), `auth` (sign-in + session), `ai/parse` — Parser
(Claude) → `JobSpec` (`POST`, body `ParseRequest{rawText}`),
the workspace-scoped `cv` routes (tailor + persist, an **AI-free verbatim draft**,
list, preview, edit a bullet, sign off, gated export), and the workspace-scoped `master` routes (read /
upsert the owner's canonical CV). `health`/`meta` and the sign-in/callback endpoints mount open
(`/auth/me` itself requires a session — it *is* the session probe); **all `ai/*` and `workspaces/*` routes mount behind
`Depends(current_user)`** (401 without a session). The review route is **content-negotiated**: plain
JSON by default, SSE under `Accept: text/event-stream` (reusing the ingestion SSE spine).

Landing now (the review-panel milestone — **workspace-scoped + grounded**, not the earlier stateless
`ai/*` sketch; ADR 0010):
- `POST /workspaces/{id}/cv/{cv_id}/review` — the review fan-out → a `ReviewBundle`. **Landed:** the
  Gatekeeper (PR-1b) + the Editor / Fact-Checker / Spotter fan-out (PR-2a). Owner-only; loads
  `{master, cv}` + the `cv_job_specs` posting server-side; the adjudicators read the `TailoredCV` JSON
  (no rendered-text projection). See the cv-routes table for the content-negotiated arms + error map.
- `POST /workspaces/{id}/cv/{cv_id}/apply` — **Landed (PR-3; per-bullet Corrector DevPR29).** The
  Corrector (Claude) rewords the accepted **bullet** threads — sent per-bullet (current + master text
  + threads), returned as `{bulletId → text}` — → the re-grounded `RenderBundle`, persisted under the
  optimistic lock. Owner-only; **server-authoritative reword-in-place**. See the cv-routes table.

Persisted review runs landed (ADR 0013): the latest run + the owner's per-finding decisions survive
navigation (`GET`/`PUT .../review`, below), and the **Diff** derives from that run's `reviewedText`
baseline (ADR 0015 — no new route/store). Still planned: run history and a **snapshot-backed**
Diff/verdict history / `gkList`. (Multi-reviewer threads + presence died with the single-user
pivot — the AI panel is the only reviewer.)

Route handlers stay thin; logic lives in `app/`. Keys server-side only.

### AI routes (`routes/ai.py`)

| Route | Method | Purpose |
|---|---|---|
| `/ai/parse` | POST | Body `ParseRequest{rawText}` → `JobSpec` (Parser, Claude). |

Tailoring has no stateless `ai/*` route: the one path is the workspace-scoped
`POST /workspaces/{id}/cv` (below), which loads the stored master server-side and enforces the
provenance gate before persisting (the stateless `POST /ai/tailor` was removed — it had no product
consumer).

### Workspace CV routes (`routes/cv.py`)

Workspace-scoped, so per-request authorization is re-derived from the membership store (invariant 8,
`require_workspace_owner` binds `{workspace_id}` from the path — the single workspace gate; every
allowlisted account is an owner). The store filters on `(workspace_id, cv_id)`, so a cross-tenant id
is a **404**, not a leak. See `security.md`.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/workspaces/{workspace_id}/cv` | GET | owner | **List** the workspace's **active** CVs (newest first) as `CvSummary[]` for the dashboard — `{id, version, needsSignoff, summary, jobTitle?, company?, createdAt, updatedAt}`. `jobTitle`/`company` are LEFT-JOINed from `cv_labels` (null for a keyless draft); `master` is not loaded. **Applied/locked CVs are excluded** (`NOT EXISTS stored_applications`) — they've moved to the tracker (ADR 0009). |
| `/workspaces/{workspace_id}/cv` | POST | owner | Body `WorkspaceTailorRequest{jobSpec}` — tailor the **stored** master (loaded server-side; **404** if none saved) to the job, derive provenance, validate stable ids, persist → `CreatedCV{id, cv}`. Duplicate ids → **422**. |
| `/workspaces/{workspace_id}/cv/from-master` | POST | owner | **AI-free**: build a deterministic verbatim draft from the stored master (every bullet `verbatim` → zero net-new → exports immediately) and persist → `CreatedCV`. No provider key needed. **404** if no master saved. |
| `/workspaces/{workspace_id}/cv/{cv_id}` | GET | owner | `RenderBundle{master, cv, jobSpec: JobSpec\|null}` **preview** (not sign-off-gated — export is) — `jobSpec` is required-nullable (always present, `null` for a keyless draft), not omittable. Unknown id → **404**. |
| `/workspaces/{workspace_id}/cv/{cv_id}/review` | POST | owner | Run the AI review **fan-out** over the stored CV → `ReviewBundle{editor?, factCheck?, gatekeeper?, slop?, failures[]}`. **Content-negotiated:** blocking (plain JSON) returns the full bundle; SSE (`Accept: text/event-stream`) streams `AgentStarted`/`AgentReport`/`AgentDone` per agent + a terminal `RunDone`. Loads `{master, cv}` + the stored `cv_job_specs` posting server-side; adjudicators read the `TailoredCV` JSON (ADR 0010). Editor + Gatekeeper need the posting; a **no-job draft** runs only Fact-Checker + Spotter (`gatekeeper`/`editor` null). Server authority: `atsMatchScore` clamped 0-100, threads grounded to real anchors, fact-check `sourceId` validated per-item. **Advisory** — never gates export (a needs-sign-off CV is still reviewable). **Persists at settle (ADR 0013):** the run is saved to `cv_reviews` (a latest-only snapshot keyed by `cvId` — still **no `X-Run-Id`** / `resultRef` null, no run row). A completed (billed) run never 500s on a save hiccup: the blocking arm returns **200** + the bundle + a **`X-Review-Saved: false`** header, the SSE arm emits **`RunDone(ok=true, detail="save_failed")`** (after an ordered rollback + a conditional tombstone of the stale prior run); an aborted run persists nothing. Unknown id → **404**; stale `baseVersion` → **409**; unset tier / missing key → **503** (preflight, before the fan-out). A per-agent in-flight failure (refusal/parse/provider) **degrades** — it lands in `failures` (blocking) / an `AgentDone(ok=false)` (stream); the request stays **200**/streamed, NOT 422/502 (invariant 5 met by surfacing it, not erroring). |
| `/workspaces/{workspace_id}/cv/{cv_id}/review` | GET | owner | The persisted latest review run → **`SavedReview{cvId, bundle, reviewedText, decisions, updatedAt}` or `null`** (ADR 0013). **200-null when absent** (the rehydrate probe fires on every workspace mount — a 404 would be console-noisy), 200-null when the stored bundle no longer validates against the current `ReviewBundle` (schema skew self-heals as "no review"), and 200-null for an **orphan row** (CV deleted out from under a lockless settle — the orphan is deleted on read). A cross-tenant CV id also reads as null (zero foreign data). |
| `/workspaces/{workspace_id}/cv/{cv_id}/review/decisions` | PUT | owner | Body `ReviewDecisionsRequest{decisions, cvVersion}` — persist the whole per-finding decisions snapshot (`threadKey → accepted|rejected`, last-write-wins, invariant 7) → `OkResponse`. **404** if no review is stored (`ReviewNotFound`) or the CV itself is gone (orphan guard); **409** (`ReviewVersionConflict`) if the stored review is a different CV version (re-run since); **422** if over bounds (≤512 entries, ≤512 chars/key). |
| `/workspaces/{workspace_id}/cv/{cv_id}/review` | DELETE | owner | The **"Clear review"** action — wipe the persisted run + its per-finding decisions so the panel/diff reset → `OkResponse`. **Idempotent** (a 0-row-safe bulk delete): clearing a never-reviewed / already-cleared CV, or a cross-tenant CV id, is a **200 no-op** (never 404), and workspace-scoped so it can't touch another workspace's row (invariant 8). No optimistic-lock version — a clear is unconditional. |
| `/workspaces/{workspace_id}/cv/{cv_id}/apply` | POST | owner | Body `ApplyFeedbackRequest{threads, baseVersion}` — apply the accepted **bullet**-anchored review threads as Corrector (Claude) rewrites. **Server-authoritative reword-in-place** (dec #7): a cheap preflight rejects a stale/locked CV **before** the billed LLM; the Claude call runs **outside** any DB transaction (a session-free authoring runner + a committed preflight); then under the lock the server splices only the accepted bullets' **text** onto the **stored** CV (unaccepted bullets, summary, order byte-stable by construction) — **preserving each bullet's stored `sourceId`/`origin`** (reword-in-place, like `edit`), so a net-new bullet can't be silently grounded past sign-off — re-grounds each from its stored source (overstatement-on-a-real-source stays the Fact-Checker's advisory job). The Corrector is **per-bullet** (DevPR29): it returns only `{bulletId → text}`, never structure, so there's nothing to add/drop/re-parent (the old `assert_structure_preserved` is gone) — instead a **missing** revision for an accepted bullet or a blank/oversized text → **422** at splice, a **duplicate** revision id → **422** at the route, an **unknown** id is ignored. Returns the **re-grounded `RenderBundle`** — NOT gate-checked; corrected bullets may now need sign-off. v1 corrects only bullet threads (item/section/summary advisory-only); the client `threads` are INPUT only. Unknown CV id → **404**; stale `baseVersion` / **locked** → **409**; a blank/oversized/missing/duplicate correction, or no correctable bullet thread → **422**; unset Anthropic tier/key → **503** (preflight). |
| `/workspaces/{workspace_id}/cv/{cv_id}/signoff` | POST | owner | Body `SignoffRequest{bulletIds, baseVersion}` clears `needsSignoff` (idempotent) → `RenderBundle`. Unknown bullet → **422**; a write against a stale `baseVersion` → **409**. |
| `/workspaces/{workspace_id}/cv/{cv_id}/edit` | POST | owner | Body `EditBulletRequest{bulletId, text, baseVersion}` — manual text edit of one bullet. The server re-grounds **only** that bullet (invariant 2): a grounded bullet stays grounded (`verbatim`→`reworded`), a net-new bullet stays gated (editing a signed-off one re-requires sign-off) → `RenderBundle`. Unknown bullet → **422**, blank/oversized text → **422**, stale `baseVersion` → **409**. `baseVersion` is the `cv.version` the client was viewing, so a stale tab can't clobber a newer edit. |
| `/workspaces/{workspace_id}/cv/{cv_id}/export` | GET | owner | **Gate-checked** (invariant 2): **409** `ExportBlocked{blockedBulletIds}` while any net-new bullet is unsigned; else `RenderBundle`. |
| `/workspaces/{workspace_id}/cv/{cv_id}` | DELETE | owner | Delete the CV **and** its `cv_labels` row (one commit) → `200 OkResponse{ok}` (not 204, so the client's body-parser doesn't throw). Unknown / cross-tenant id → **404** (no other tenant's CV is reachable). |

An **applied/locked** CV (a `stored_applications` row references it) refuses `signoff` / `edit` /
`apply` / `DELETE` with **409 `ApplicationConflict{code:"cvLocked", detail}`** — distinct from the
stale-version 409 so the client redirects to the tracker rather than reload-retrying (ADR 0009).

### Workspace application routes (`routes/applications.py`)

Every verb (incl. the `by-cv` lock lookup) authorizes through the workspace gate, so an
application's existence/metadata never leaks to a non-member (invariant 8). The `by-cv` probe is the
one place a **miss** answers **200 with JSON `null`** rather than 404 — the workspace calls it on every
load, so a red console error per unapplied CV was noise. The route returns the `ApplicationSummary`,
or JSON `null` when the CV isn't applied — information-equivalent to the old 404 (a non-member still 403s).

| Path | Method | Auth | Notes |
|---|---|---|---|
| `/workspaces/{workspace_id}/applications` | POST | owner | Body `ApplyRequest{cvId, jobTitle?, company?, jobUrl?, note?, baseVersion}` — lock a finished CV to a job and move it to the tracker. Enforces the **same gate as export** (invariant 2): **409 `ExportBlocked`** while any net-new bullet is unsigned. **409 `ApplicationConflict{code:"stale"}`** if the CV moved since `baseVersion`; **409 `{code:"alreadyApplied"}`** if already tracked; **422** if no job title resolves (request, else the CV's `cv_labels` title); **404** if the CV isn't in this workspace. → `Application`. |
| `/workspaces/{workspace_id}/applications` | GET | owner | **List** tracked applications (newest first) as `ApplicationSummary[]`. |
| `/workspaces/{workspace_id}/applications/by-cv/{cv_id}` | GET | owner | The application tracking this CV as `ApplicationSummary`, or JSON **`null`** when the CV isn't applied (the workspace probes this on every load to redirect a locked deep-link). Returns **200** either way (not 404), so an unapplied CV doesn't log a red console error; a cross-tenant miss is the same information-free `null`; a non-member is still **403**. |
| `/workspaces/{workspace_id}/applications/{application_id}` | GET | owner | The full `Application` (job metadata + status timeline). Unknown / cross-tenant id → **404**. |
| `/workspaces/{workspace_id}/applications/{application_id}/stage` | PATCH | owner | Body `StageUpdateRequest{stage, note?}` — advance the pipeline + append a timeline event → `Application`. Stage not in the application's `stages` → **422**; unknown id → **404**. |
| `/workspaces/{workspace_id}/applications/{application_id}/recruiter` | PATCH | owner | Body `RecruiterUpdateRequest{recruiterName, recruiterEmail}` — set the whole recruiter contact (full replace; both keys required-but-nullable, so an omitted key → **422**; a non-empty invalid email → **422**) → `Application`. Unknown id → **404**. Last-write-wins (invariant 7). |
| `/workspaces/{workspace_id}/applications/{application_id}` | DELETE | owner | Remove the application **and** its locked CV (cascade, one commit) → `200 OkResponse{ok}`. Unknown / cross-tenant id → **404**. |

### Workspace master routes (`routes/master.py`)

Workspace-scoped (invariant 8): both verbs are owner-gated (every allowlisted account is an owner).
Every query filters on `workspace_id`, so a non-member is **403** and there is no cross-tenant read.
See `security.md`.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/workspaces/{workspace_id}/master` | GET | owner | The stored `MasterProfile`, or **200-null** until one has been saved — probe parity with the review-latest GET (the workspace mount + the `/master` editor probe on load; a first-run 404 was console noise for an expected state). |
| `/workspaces/{workspace_id}/master` | PUT | owner | Upsert the master after id validation → `MasterProfile`. A blank / duplicate / `:`-bearing stable id → **422** (`MasterIdError`); these ids are the provenance anchors the tailored CV + verbatim draft point back to. |

### Workspace ingestion routes (`routes/ingest.py`)

Build the master from a document (pasted text or an uploaded PDF). **Owner-only** — the
candidate builds their own master (invariant 8); the store filters on `(workspace_id, run/proposal id)`,
so a cross-tenant id is a **404**. The owner's accept is the ingestion sign-off gate (invariant 2):
proposals persist server-side and `apply` works by stored `proposalId`, never client master JSON. One
open run per workspace; a stale-run reaper + `discard` prevent a wedged workspace.

Both POST routes are **content-negotiated**: with `Accept: text/event-stream` the *same synchronous
run* streams Server-Sent Events — an `AgentStarted` then a terminal `AgentDone` per agent
(`extractor-basics`/`-work`/`-qualifications`, `reconciler-work`, `judge`; `AgentDone.ok=false` +
`detail` names a failed one) then `RunDone{ok, resultRef}` (`ok` reflects the run's final status).
The ingest stream also carries **`AgentProgress{agentId, note}`** status notes (DevPR33) — one
owner-facing sentence per extractor pass and around the reconciler/Judge legs, rendered verbatim
in the ImportModal's aria-live status line. Each note precedes that agent's terminal `AgentDone`
(AgentDone stays terminal per agent), and a note never precedes the run's first `AgentStarted`
(the Stop escape hatch gates on a non-empty checklist). The review stream emits
**no** `agent_progress` today (its adjudicators run concurrently sharing one status line —
review-side progress is future UX work; the workspace client already renders the event if one
ever arrives, so lighting it later is backend-only).
The client keys its checklist by `agentId` — the rare native-PDF→text fallback re-runs a section, so
an `agentId` may appear twice (last-event-wins). The client reloads the bundle via the GET route; the
run id is also on the **`X-Run-Id`** response header, so a stream that drops before `RunDone` can
reload the exact run (even a terminal `failed` one the open-run recovery list would miss). Without the header the run blocks and returns the bundle. The cheap
pre-flight (tier **503**, one-open-run **409**, empty-text/PDF guards **422**/**413**) runs *before*
the stream opens, so those stay real HTTP statuses; a failure *after* the 200 is committed
(refusal/truncation/parse, a missing key) is delivered as `RunDone{ok:false}` + a `failed` run carrying
the reason — the JSON (non-streaming) path still maps those to **422**/**502**.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/workspaces/{workspace_id}/ingest` | POST | owner | Body `PasteIngestRequest{text}` — pre-flight the Extractor (Anthropic) tier (**503** if unset, before any run row), open a run (**409** if one is already open), run the **Extractor**; first run → net-new proposals, otherwise the **Reconciler** (Claude) matches roles → `enrich`/`correction`/`net-new` proposals (ADR 0008) → `IngestionRunBundle`. Empty text → **422**; an Extractor/Reconciler refusal/truncation marks the run `failed` and surfaces (**422**/**502**). |
| `/workspaces/{workspace_id}/ingest/file` | POST | owner | `multipart/form-data`: `file` (the PDF) + `sourceType` form field (defaults `cv-pdf`; `pasted` → **422**). Sent to Claude as a native document block (ADR 0007); pypdf supplies the stored text copy + the guard. Oversize/too-many-pages → **413**; not-a-PDF / unreadable → **422**; otherwise same run lifecycle as the paste route (**409** one-open-run, **503** tier/key unset, **422**/**502** on refusal/truncation). → `IngestionRunBundle`. |
| `/workspaces/{workspace_id}/ingest` | GET | owner | Runs newest-first (`IngestionRun[]`) — the recovery / history surface. |
| `/workspaces/{workspace_id}/ingest/{run_id}` | GET | owner | `IngestionRunBundle` (run + proposals), reload-safe + deep-linkable. Unknown / cross-tenant id → **404**. |
| `/workspaces/{workspace_id}/ingest/{run_id}/proposals/{proposal_id}` | POST | owner | Body `DecideProposalRequest{action, edited?, baseVersion}` — accept / decline / edit one proposal, optimistic-locked on its `version` (**409** if stale). Unknown id → **404**. |
| `/workspaces/{workspace_id}/ingest/{run_id}/decide` | POST | owner | Body `BulkDecideRequest{items[{proposalId, baseVersion}], action}` — bulk accept/decline; the server only flips proposals still pending, and on **accept** ("add all new items") only `relationship == net-new` (re-derived from stored state — an enrich/correction id → **422**). Unknown id → **404**; stale item → **409**. |
| `/workspaces/{workspace_id}/ingest/{run_id}/apply` | POST | owner | Apply the accepted proposals to the master under the advisory lock → `ApplyResult{appliedCount, conflicts[], master}`. A net-new unit appends; an **enrich** appends a highlight to its target work entry (id-preserving); a **correction** overwrites a basics field (guarded so it can't clobber a value changed since the run — belt-and-suspenders atop the 409). The run-level **409** (the master changed since the run started) is the staleness gate; **422** if the result isn't a valid master (e.g. first-run identity incomplete); partial — a malformed/ungroundable unit is reported as a conflict, the rest lands. |
| `/workspaces/{workspace_id}/ingest/{run_id}/discard` | POST | owner | Abandon a run (escape hatch), freeing the workspace → `IngestionRun`. |

### Auth routes (`routes/auth.py`)

See `security.md` for the model. All converge on the signed session cookie.

| Route | Method | Purpose |
|---|---|---|
| `/auth/me` | GET | Current `AuthUser` (`{email, role}` — `role` is **vestigial**, always `"owner"`, `deprecated` in OpenAPI; kept one release for deploy skew); **401** without a session, **403** for a valid session whose email was de-allowlisted (live revocation, revalidated per request). |
| `/auth/logout` | POST | Clears the session → `OkResponse`. |
| `/auth/magic/request` | POST | Body `MagicRequest{email}`. Emails a 15-min link **iff** allowlisted; always returns `OkResponse` (never leaks the allowlist). |
| `/auth/magic/callback` | GET | Validates the signed token, sets the session, **303** → frontend; `?error=link` on bad/expired. |
| `/auth/entra/login` | GET | Redirects to Entra; **503** until M365 is configured. |
| `/auth/entra/callback` | GET | Verifies the email claim, sets the session, **303** → frontend; `?error=not_allowed` if off-allowlist. |

### Admin routes (`routes/admin.py`)

Owner-only provider configuration (ADR 0006). The whole router mounts behind `Depends(current_user)`
**and** `Depends(require_owner)` (the defense-in-depth allowlist re-check) — a non-allowlisted
account gets 403, no session 401. Keys are write-only: the API
never returns a secret, only `isSet` + a masked `last4`.

| Route | Method | Purpose |
|---|---|---|
| `/admin/providers` | GET | `AdminStatus` — per-provider key status (masked) + cached models + tier map. |
| `/admin/providers/{provider}/key` | PUT | Validate the key by listing models, then store it encrypted **and** cache the list atomically → `AdminProviderStatus`. A rejected key → **400**, nothing stored. Invalidates the cached client. |
| `/admin/providers/{provider}/key` | DELETE | Clear the key + its cached models; invalidate the cached client → `ProviderKeyStatus`. |
| `/admin/providers/{provider}/sync-models` | POST | Re-poll the provider's list-models with the stored key → `SyncModelsResponse`. No key → **409** "Set the provider key first". |
| `/admin/providers/{provider}/models` | PUT | Assign tier→model ids (`SetTiersRequest`), validated against the cached list → `ProviderModelStatus`. No synced list → **409**; unknown id → **422**. |

### Error mapping (AI + admin)

Domain errors map to clean status codes in `app/main.py` (never a raw 500): misconfiguration
(`ProviderKeyMissing` / `ModelTierUnset` / Fernet `InvalidToken`) → **503**; provider SDK
rejection/network (`anthropic`/`openai` `APIError`) → **502**; `AgentRefusal` and `DuplicateStableId`
(a tailored CV with colliding stable ids) → **422**; `AgentTruncated` / `AgentParseError` → **502**
(a model that can't do structured output lands here). The CV routes map their store exceptions
inline: `CVNotFound` → **404**, `BulletNotFound` → **422**, `StaleCV` (optimistic-lock conflict) →
**409**; `CVLocked` (an applied CV refusing a mutation) → **409** with the `ApplicationConflict
{code:"cvLocked"}` body, via a global handler in `app/main.py` so it can't be mistaken for a stale-
version 409. The application routes map `CVNotFound`/`ApplicationNotFound` → **404**, `NeedsSignoff` →
**409 `ExportBlocked`**, `StaleCV`/`AlreadyApplied` → **409 `ApplicationConflict`** (`code` `stale`/
`alreadyApplied`), and `TitleRequired`/`InvalidStage` → **422**. The master routes map `MasterIdError` → **422**
(the PUT); the master GET never 404s — an authorized owner with no stored master gets **200-null**
(an expected first-run state, probe parity with the review-latest GET; a non-member fails closed
**403** at the dependency, so null is only ever authorized absence). `MasterNotFound` still maps
to **404** where a stored master is a precondition: `POST …/cv` (tailor) and
`POST …/cv/from-master` in `routes/cv.py`. The ingest paths (`routes/ingest.py`, apply-time
`ingest_store.apply_run`) catch it into `None` — an absent master is a valid first-import state,
not an error. On any **streaming** path
(`Accept: text/event-stream`) the response is an already-committed `200 text/event-stream`, so these
handlers can't fire mid-run: a post-200 failure is delivered as `RunDone{ok:false}` instead — for
ingest, recorded on the run (`failureKind`/`failureReason`); for review, carried in `RunDone.detail`
(the review persists to a **latest-only snapshot keyed by `cvId`** — ADR 0013 — but still has no run
row / `X-Run-Id`). **New with ADR 0013:** the review SSE arm can also emit `RunDone{ok:true,
detail:"save_failed"}` — the (billed) run succeeded but its settle-time save failed, so `ok` stays
true and `detail` surfaces the save fault (previously `detail` was failure-only); the blocking arm's
equivalent is a **200 + `X-Review-Saved: false`** header. **The review route diverges from the ingest blocking arm:** its blocking
arm CATCHES a per-agent provider/agent failure into `ReviewBundle.failures` and returns **200** (the
panel is advisory and per-agent — invariant 5 is met by surfacing the failure, not erroring the
request), where the ingest blocking arm re-raises to **422**/**502**. Only a provider-config fault
(`ModelTierUnset`/`ProviderKeyMissing`, in the review builder preflight) still maps to **503** before
the fan-out; a genuine programming bug (not a provider failure) still propagates to a 500.

## Internal: frontend render routes

The backend never renders documents, and does **not** call the frontend for rendering — the AI
adjudicators read the structured `TailoredCV` JSON directly (ADR 0010), not rendered text. The render
flow is the other direction: the frontend's own render routes `/api/render/{pdf,docx,text}` (and
`/print`) call the backend for the document data. Preview = PDF because both mount the same
`ResumeTemplate` (see `renderer.md`).

Those frontend render routes (and the `/print/[cvId]` surface) now fetch the real `{master, cv}` from
the backend's gate-checked `GET /workspaces/{ws}/cv/{id}/export` (the `sample` id stays on bundled
fixtures): they forward the session cookie and **refuse before producing an artifact** when the gate
blocks (text/docx relay the 409; the PDF route prechecks the gate before launching Chromium, then
injects the caller's cookie into the browser context so `/print` renders the authorized bundle). See
`renderer.md`.

## External integrations

- **Anthropic API** — authoring agents; structured outputs via `messages.parse` → `parsed_output`
  (wrapper `app/ai/providers/anthropic.py`; SDK version: see `backend/uv.lock` — exact pins are not
  repeated here, they re-stale on every dependabot bump). Routes call an injectable
  `ProviderRunner`, so tests run offline with a fake. Opus 4.8 rejects sampling params — no sampling
  params are sent (the `ProviderRunner` signature carries none). The client is built from the
  **DB-stored key** (`providers/clients.py`), not env.
  A multimodal agent (the ingestion Extractor) passes a PDF as an optional base64 `document` content
  block alongside the text prompt; `output_format` still applies, so the PDF + schema travel in one
  call (ADR 0007). `max_tokens` is per-agent (`Agent.max_tokens`); `run_openai` accepts-and-ignores
  the `document` (the OpenAI adjudicators are text-only — invariant 6).
- **OpenAI API** — adjudication agents + provider list-models; structured outputs via the **Responses
  API** `responses.parse(text_format=…)` → `output_parsed` (non-beta; SDK version: see
  `backend/uv.lock`). Wrapper `app/ai/providers/openai.py`. No sampling params are sent — dynamic
  model selection can land on reasoning/o-series models that reject them.
- **Agent-call observability** — both wrappers emit one `agent_call` log line per call: **agent id**
  (threaded from `run_agent` through `ProviderRunner`), provider, model, token usage, latency, the
  provider's raw terminal signal (`stop=` for Anthropic / `status=` for OpenAI, kept alongside), and a
  classified `outcome=` field — `ok | refusal | truncation | schema-parse-fail | error`. The
  classification mirrors what the wrapper raises (invariant 5 → surfaced as 4xx/5xx): a
  `content_filter`-incomplete OpenAI response classifies as `truncation` because `AgentTruncated` is
  what is raised for any incomplete status; `schema-parse-fail` is claimed only when the returned
  response ended normally yet carries no parsed output. A pydantic `ValidationError` raised inside
  `.parse(` logs the generic `outcome=error err=ValidationError` and propagates unchanged — both
  SDKs validate the text regardless of the terminal state, so it can equally be a truncation's
  partial JSON and the terminal signal is unreachable on the raise path. Any other SDK-raised
  failure logs `outcome=error err=<type>`. (AGENTS §8 / `observability.md`.)
- **Provider keys + models are admin-managed** (ADR 0006): keys are decrypted from the DB to build a
  cached client (`providers/clients.py`); an agent's tier resolves to a model id via the DB tier map.
- **Microsoft Entra ID** — OIDC sign-in (Authlib), email allowlist (see `security.md`).
  **Configured and live in production** — the M365 SSO gate is enabled (AGENTS.md §10).
- **Microsoft Graph** (later) — OneDrive export write-back. The SSO prerequisite is already wired
  and live; only the Graph integration itself is future work.
