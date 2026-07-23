# Data Model

Status: active — seed doc  
Last updated: 2026-07-23

Source of truth for shapes: `backend/app/schema/` (Pydantic; the frontend's TS is generated from
these). Update this doc whenever those models change (`schema-change` rule).

## Entities

- **MasterProfile** (`schema/master.py`) — canonical truth about the candidate. Every
  `work[].highlights[]` bullet has a stable `id` (enables provenance). Now **persisted per workspace**
  (`stored_masters`, below) and edited via the Master editor; the Workspace tailors / drafts from the
  stored copy (loaded server-side), not from client-supplied JSON.
  **`Basics` requires only `name` + `email`** (both `NonBlank` — `""`/whitespace are rejected
  server-side, so a blank PUT/import 422s, not silently stored). `label` (headline), `phone`,
  `summary`, and `location` are **recommended**: they default empty (`location` to an empty
  `Location()` whose `city`/`region`/`countryCode` default `""`), so an import never blocks on them —
  the review UI nudges (yellow) instead. This keeps `basics.location.*` always-present for renderers.
  **`languages`** (`Language`: `language` + optional `fluency`, JSON Resume shape) is a **present list
  defaulting `[]`** (mirrors `skills` — never optional, so every consumer reads it unguarded); like
  skills it carries no stable id (not a provenance anchor). Populated by the ingest Extractor (D2a).
  Documentation and test examples use synthetic `ExampleCo` stable ids; tracked fixtures must never
  contain an identity or employment history copied from a real CV.
- **ParsedJobSpec / JobSpec** (`schema/job.py`) — `ParsedJobSpec` is the **Parser's** output
  (extract-only: must-haves, nice-to-haves, ATS keywords, seniority, tone, red flags — no owner
  fields). **JobSpec** subclasses it and adds the optional owner-supplied `postingUrl` (the Parser
  reads pasted text only; `/ai/parse` upgrades `ParsedJobSpec`→`JobSpec`; the new-application modal
  captures the link, the posting drawer renders it). `postingUrl` is optional + defaulted, so legacy
  `cv_job_specs` blobs still validate.
- **TailoredCV** (`schema/tailored.py`) — a variant for one job. Every bullet carries `sourceId` +
  `origin` (`verbatim`/`reworded`/`net-new`) **and a stable `bulletId`**; sections/items carry
  `sectionId`/`itemId`. `net-new ⇒ needsSignoff`, which blocks export. `version` is bumped **in
  place** on each save (the optimistic-lock token); `parentVersion` records the version a change
  derived from (a future snapshot/diff history is deferred — see Versioning).
- **Reviews** (`schema/reviews.py`) — Editor / Fact-Check / Slop / Gatekeeper outputs. Threads anchor
  to a stable `anchorId` (+ `anchorKind`), never an array index. **`ReviewBundle`** aggregates the four
  reports, each optional (`editor?`, `factCheck?`, `gatekeeper?`, `slop?`) plus `failures: AgentFailure[]`
  — the response of `POST .../cv/{id}/review`. The fan-out populates all four when they apply; a **null**
  report means that agent didn't apply (N/A — e.g. a no-job draft has no posting, so `gatekeeper`/`editor`
  stay null and only `factCheck`/`slop` populate), while an agent that **ran and degraded** is listed in
  `failures` (`AgentFailure{agentId, detail}`) — the distinction is invariant 5 (surface failures
  loudly), since the blocking arm has no SSE event to carry it. Advisory — nothing here gates export.
  The bundle's `cvVersion` pins the EXACT CV version the server reviewed; a newer CV version marks
  the review **version-drifted** — a presentation signal only (ADR 0016): its surfaces stay visible,
  stale-marked, never hidden or deleted.
  **`ApplyFeedbackRequest{threads, baseVersion}`** is the `POST .../cv/{id}/apply` body — the accepted
  threads echoed back for the Corrector. Its `threads` are **`AcceptedThread`** (a `Thread` subclass
  with `extra="ignore"`), so the client may resend a full `SlopThread`/`FactCheckThread` verbatim and
  the report-only / UI-only fields are dropped rather than 422'd at the boundary.
  **Persisted reviews (ADR 0013):** a review run + the owner's per-finding decisions now survive
  navigation. **`SavedReview{cvId, bundle, reviewedText, decisions, updatedAt}`** is what `GET
  .../cv/{id}/review` returns when a run is stored (**200-null** when absent) — `bundle` is the
  `ReviewBundle` as reviewed, `reviewedText` maps `bulletId → text` at review time (server-derived),
  and `decisions` maps an opaque `threadKey → ThreadDecision` (`accepted`|`rejected`).
  **`ReviewDecisionsRequest{decisions, cvVersion}`** is the `PUT .../review/decisions` body — the
  whole decisions snapshot (last-write-wins, invariant 7) plus the `cvVersion` the client was viewing
  (a mismatch → **409**); it is bounded (≤512 entries, ≤512 chars/key → **422**). `ThreadDecision`
  lives in `schema/reviews.py`, NOT `common.py`, so it doesn't collide with the Gatekeeper's
  `Decision`. Backed by the `cv_reviews` table (below); no run history and no separate Diff snapshot store
  (the Diff is derived from this row's `reviewedText` baseline — ADR 0015).
- **Application** (`schema/application.py`) — a tracked job: `jobTitle` (non-blank, server-resolved),
  `company?`, `jobUrl?`, `tailoredCvRef` (the locked `StoredCV.id` — the exact CV version sent),
  `appliedAt`, current `stage`, editable `stages`, append-only `events[]` (`StageEvent{at, stage,
  note?}`), and an optional `recruiterName?` / `recruiterEmail?` contact (owner-editable). The applied
  CV is **immutable**: applying locks it (see `stored_applications` / ADR 0009).
  Wire models: `ApplyRequest{cvId, jobTitle?, company?, jobUrl?, note?, baseVersion}` (lock a finished
  CV to a job — title resolves from the request, else the CV's `cv_labels` title, else 422),
  `ApplicationSummary{id, jobTitle, company?, stage, appliedAt, cvId}` (the tracker list row —
  recruiter is intentionally NOT on the summary; it shows only in the expanded full record),
  `StageUpdateRequest{stage, note?}` (advance the pipeline),
  `RecruiterUpdateRequest{recruiterName, recruiterEmail}` (both required-but-nullable — a full replace
  of the recruiter contact; an omitted key is a 422, a non-empty invalid email a 422),
  and `ApplicationConflict{code, detail}`
  with `code: ConflictCode` (`stale` | `alreadyApplied` | `cvLocked`) — the machine-readable 409 body
  so the client branches on a code, not prose (needs-sign-off keeps `ExportBlocked`).
- **SSE envelopes** (`schema/sse.py`) — per-agent streaming events (`AgentStarted/Progress/Done`,
  `RunDone`). First used by the **ingestion** run's progress stream (PR-F). The review fan-out reuses
  them and adds **`AgentReport`** — a concrete envelope (`agentId` + exactly one populated report field:
  `editor`/`factCheck`/`gatekeeper`/`slop`) streamed the moment each adjudicator lands, so codegen emits
  one stable type rather than a bare union. `RunDone` carries an optional `detail`: on a terminal
  **failure** (`ok=false`) it names the failure that has no `resultRef` to load; and — new with ADR
  0013 — the review SSE arm emits **`RunDone(ok=true, detail="save_failed")`** when the (successful,
  billed) run persisted at settle but its save failed, so the client knows the run succeeded yet is
  not restorable (previously `detail` was failure-only). The review is a **latest-only snapshot keyed
  by `cvId`**, not a run row, so it still carries no `X-Run-Id` / `resultRef`.
- **Request bodies** (`schema/requests.py`) — thin wire wrappers for the AI routes (e.g.
  `ParseRequest{rawText}`); kept in the schema package so they're emitted into the generated TS types.
- **CV route models** (`schema/cv.py`) — wire shapes for Tailor + CV persistence:
  `WorkspaceTailorRequest{jobSpec}` (the `POST /workspaces/{id}/cv` body — **only the job**; the
  master is loaded server-side from `stored_masters`, so provenance is grounded in stored truth,
  never client JSON — invariant 2; there is no stateless tailor body anymore — `TailorRequest` died
  with `POST /ai/tailor`),
  `SignoffRequest{bulletIds, baseVersion}`,
  `EditBulletRequest{bulletId, text, baseVersion}` (a manual single-bullet text edit; `text` is
  trimmed + bounded server-side so a blank/oversized edit is a 422 — the client never supplies
  `origin`/`sourceId`/`needsSignoff`, which the server re-derives), and
  `ReviewRequest{baseVersion}` (the `POST .../cv/{id}/review` body — rejects a stale-tab review with
  409 before the billed fan-out, the same stale-version guard `apply`/`edit`/`signoff` use; the
  export gate 409s on sign-off, not staleness). All three bodies carry
  `baseVersion` — the `cv.version` the client was viewing — so the server rejects a stale write with
  409 (client-visible optimistic concurrency; see `stored_cvs`). `RenderBundle{master, cv, jobSpec?}`
  (what the renderer needs + the stored `jobSpec` the CV targeted, for the posting drawer + Gatekeeper
  present/met — `jobSpec` is null for a keyless draft and is never a render/provenance input),
  `CreatedCV{id, cv}`,
  `CvSummary{id, version, needsSignoff, summary, jobTitle?, company?, createdAt, updatedAt}` (the
  lightweight dashboard-list row — `needsSignoff` derived from the CV, `jobTitle`/`company` from the
  separate `cv_labels` table, timestamps from the stored row), and
  `ExportBlocked{blockedBulletIds}` (the gate's 409 body). The agent's internal input
  (`TailorContext`) is **not** here — it never crosses the wire.
- **Datetime convention.** Every wire timestamp (`createdAt`/`updatedAt`/`syncedAt` on `CvSummary`,
  `IngestionRun`, and the admin provider models; `updatedAt` on `SavedReview`; `appliedAt` on
  `Application` + `ApplicationSummary`;
  `at` on `StageEvent`) uses the shared `UtcDateTime` type
  (`schema/common.py`): an `AfterValidator` normalises a tz-naive value (which `DateTime(timezone=
  True)` columns become when re-read from SQLite) to UTC, so the serialized value always carries a
  timezone. Without it the API can emit a bare timestamp that a browser parses as **local** time — a
  wall-clock skew. The OpenAPI type is unchanged (`string`, `format: date-time`).
- **Auth** (`schema/auth.py`) — `AuthUser{email, role}` (the `/auth/me` shape), `MagicRequest{email}`
  (the magic-link request body), `OkResponse{ok}` (the deliberately opaque ack — see `security.md`).
  `role` is **vestigial**: always `"owner"` (a `Literal["owner"]` constant, `deprecated` in
  OpenAPI), kept on the wire for one release so an old client survives the deploy-skew window;
  removed next release. Every allowlisted account is an owner — there is no role to derive, and the
  backend never trusts a client-supplied one.
- **Workspace / Membership** (`schema/workspace.py`) — the unit of tenancy (invariant 8). A
  `Workspace` is one isolated space; `Membership{workspaceId, email}` joins a user to a workspace
  (a row means access; absence means none). Membership is resolved by the store in
  `app/persistence/memberships.py` (`MembershipStore.is_member`) and enforced by
  `require_workspace_owner` (`app/auth/deps.py`), server-side + deny-by-default. Today an
  `AllowlistMembershipStore` models a single implicit workspace (`default`) owned by every
  allowlisted account; a Postgres-backed store drops in behind the same interface. Owned rows carry
  a `workspace_id` — `stored_cvs` and `stored_masters` (below).
- **Admin / provider config** (`schema/admin.py`) — the owner-only Admin Menu wire models:
  `AdminStatus{providers[]}`, `AdminProviderStatus` (per provider: `isSet`, masked `last4`,
  `availableModels[]`, `tierStrong/Fast/Cheap`, timestamps — **never the secret**),
  `SetProviderKeyRequest{apiKey}` (write-only), `SyncModelsResponse`, `SetTiersRequest`. `Tier` is a
  `StrEnum` (`strong` | `fast` | `cheap`) in `schema/common.py`; an agent declares a tier, resolved
  to a real model id at call time (ADR 0006).

## Storage models (ORM — not wire)

ORM models live in `backend/app/persistence/models.py`, **separate** from `schema/` (never emitted
to OpenAPI). They back the Admin Menu (ADR 0006) and the workspace data (masters + CVs):

- **`provider_secrets`** — one row per provider: `ciphertext` (Fernet-encrypted API key), `last4`
  (masked hint), `updated_at`. The plaintext key is decrypted only server-side, only to build a
  client.
- **`provider_models`** — one row per provider: `available_models` (cached from the provider's
  list-models call), `tier_strong` / `tier_fast` / `tier_cheap` (nullable model ids), `synced_at`.
- **`stored_masters`** (`master_store.py`) — the owner's canonical master, **one row per workspace**
  (`workspace_id` is the PK), the `master` JSON blob, `created_at` / `updated_at`. Both verbs
  owner-gated; every query filters on `workspace_id` (invariant 8). `validate_master_ids`
  rejects a blank / duplicate / `:`-bearing stable id before storing (→ 422): those ids are the
  provenance anchors the tailored CV and the verbatim draft point back to, and `:` is the draft's
  id-namespacing delimiter, so they must be present, unique-in-scope, and charset-safe. The row stays
  **version-less** (last-write-wins; ADR 0006's additive `create_all` can't add an optimistic-lock
  column to the existing table), so the two writers that read-modify-write the blob — `PUT /master`
  (`upsert_master`) and the ingestion **apply** (`write_master`, the no-commit variant, from the
  ingestion pipeline) — instead **serialize on a per-workspace Postgres advisory lock**
  (`persistence/locks.py`, `lock_workspace_master`). The lock is a no-op on SQLite, so cross-writer
  serialization is a Postgres-only guarantee (a `TEST_POSTGRES_URL`-gated integration test, not the
  SQLite gate); the SQLite first-save race stays safe via `upsert_master`'s `IntegrityError` fallback.
- **`stored_cvs`** (`cv_store.py`) — one tailored CV: server-generated `id`, indexed `workspace_id`
  (the tenancy key — invariant 8), `master` + `cv` JSON blobs (the master is snapshotted alongside so
  each CV's render bundle stays self-contained and immutable even if `stored_masters` is later
  edited), `version` (**server-owned**
  — normalized to 1 at create regardless of the model's emitted value, then bumped per mutation;
  mirrors `cv.version` and is the optimistic-lock token), `created_at` / `updated_at`. Reads/writes filter on `(workspace_id, id)`, so a
  cross-tenant id is a 404. `sign_off` and `edit_bullet` both reassign the whole `cv` blob (JSON
  columns don't track deep mutation), so they persist through one **optimistic-lock** helper
  (`_guarded_save`): a conditional `UPDATE … WHERE version = <client baseVersion>` that bumps
  `version` and raises `StaleCV` (→ 409) on `rowcount == 0`. Guarding on the **client's** viewed
  version (not the row's current one) catches a stale browser tab, not just two requests racing in
  the backend. `version` thus doubles as the lock token. `edit_bullet` re-grounds **only** the
  edited bullet (`reground_bullet`) so other bullets' sign-off state is preserved. Once a CV is
  **applied** (a `stored_applications` row references it), it's **locked**: `sign_off` / `edit_bullet`
  / `apply_corrections` / `delete_cv` raise `CVLocked` (→ 409, distinct from `StaleCV`) and `list_cvs`
  excludes it (`NOT EXISTS`) — all serialized under the per-CV `lock_cv` advisory lock (ADR 0009).
- **`cv_labels`** (`cv_store.py` / `models.py`) — dashboard display metadata for a CV: `cv_id` PK,
  indexed `workspace_id` (the tenancy key — invariant 8), nullable `job_title` / `company`,
  `created_at`. Deliberately a **separate table**, not a field on `cv` or a column on `stored_cvs`:
  the AI Tailor's provider-enforced `TailoredCV` output schema must not carry server-owned display
  fields (invariant 5), so the persisting `POST …/cv` route writes this row from the **trusted parsed
  `JobSpec`** at create time, in the same commit as the CV. A keyless verbatim draft has no job and
  writes **no** row (the dashboard shows "Draft · date"). The dashboard list LEFT-JOINs it; delete
  removes it. A **new table** ⇒ `create_all` provisions it on startup with **no migration** of the
  existing `stored_cvs`.
- **`cv_job_specs`** (`cv_store.py` / `models.py`) — the **full** `JobSpec` a CV was tailored to:
  `cv_id` PK, indexed `workspace_id` (tenancy key — invariant 8), the `job_spec` JSON blob,
  `created_at`. Like `cv_labels` it is a **separate table** written at create time from the owner's
  parsed posting (the Parser output the create request carries), but it keeps the *whole* posting
  (`must_haves` / `ats_keywords` / seniority / tone), not just the dashboard's title/company. The AI
  Review Panel's Gatekeeper + Editor judge "against THIS posting", so the review route loads it
  server-side (`cv_store.get_job_spec`) as the review **target** — not a CV-grounding source (the
  provenance gate still grounds content in the server-loaded master). A keyless draft has no job → no
  row → its review runs only the job-independent agents. Deleted alongside the CV (`delete_cv` **and**
  `delete_application`). A **new table** ⇒ `create_all` provisions it; no migration of `stored_cvs`
  (ADR 0006 / 0010).
- **`stored_applications`** (`application_store.py` / `models.py`) — one tracked job application:
  `id` PK, indexed `workspace_id` (tenancy key — invariant 8), `cv_id` (the locked CV), `application`
  (the camelCase `Application` JSON blob — job metadata + `stage` + `events`), `created_at` /
  `updated_at`. A unique `(workspace_id, cv_id)` constraint makes the lock **1:1** and is the atomic
  backstop for a double-apply (`IntegrityError` → `AlreadyApplied`). The application row's *existence*
  is the CV's lock — there is **no column on `stored_cvs`** (ADR 0009 / 0006: `create_all` can't add
  one to the deployed table). `update_stage` / `update_recruiter` reassign the whole `application` blob
  (JSON columns don't track deep mutation); `delete_application` removes the application **and** its
  locked `StoredCV` + `cv_labels`
  in one commit under `lock_cv`. A **new table** ⇒ `create_all` provisions it; no migration.
- **`cv_reviews`** (`review_store.py` / `models.py`) — the **latest AI review run** for a CV
  (**latest-run-only snapshot**, ADR 0013): `cv_id` PK, indexed `workspace_id` (tenancy key —
  invariant 8), `cv_version` (a promoted copy of `bundle.cvVersion` so a decisions PUT can 409 on a
  mismatch without decoding the blob), `bundle` (the camelCase `ReviewBundle` JSON as reviewed —
  including a **server-controlled** `resolvedAnchorIds: string[]`, the bullet ids the candidate has
  APPLIED a correction to; it lives on the `ReviewBundle` wrapper, NOT on any `Thread`, so no
  adjudicator model can author it, and it rides the existing JSON blob with no migration — ADR 0014),
  `reviewed_text` (`bulletId → text` at review time, server-derived), `decisions`
  (`threadKey → "accepted"|"rejected"`, opaque keys, default `{}`), timestamps. Reviews were transient
  (ADR 0010/0011); the owner reversed that so a run + its per-finding decisions survive navigation.
  Written at settle by both review arms; **explicitly DECOUPLED from history** (no run history, no
  `gkList`, no separate Diff snapshot store — the Diff derives from this row's `reviewedText`, ADR 0015).
  `save_review` is a **lockless** select-then-update upsert that resets
  `decisions` (a re-run invalidates prior verdicts) — a concurrent settle-vs-delete can leave an
  accepted (unreachable) orphan row (uuid ids never recycle). Deleted alongside the CV
  (`cv_store.delete_cv`, `application_store.delete_application`); at **apply** it is **RESOLVED in
  place, not deleted** (ADR 0014 — `apply_corrections` marks `resolvedAnchorIds` and keeps the row at
  its `cv_version`, so the candidate's other notes survive). A **new table** ⇒ `create_all`
  provisions it additively; no
  migration of `stored_cvs` (ADR 0006 / 0013). Mirrors the `cv_job_specs` satellite precedent.
- **`ingestion_runs`** (`ingest_store.py`) — one CV/LinkedIn ingestion of one document: `id` PK,
  indexed `workspace_id` (tenancy key — invariant 8), `source_type`, `status`
  (`extracting`/`reconciling`/`review`/`applied`/`failed`/`discarded`), `failure_kind`/`failure_reason`
  (set when `failed`), `master_snapshot` (the master the run was reconciled against — `apply`
  re-hashes it with the current serializer and refuses with 409 if the live master's hash drifts
  since; re-hashing the snapshot, not a hash frozen at create, keeps an additive `MasterProfile`
  field from falsely staling a run open across a deploy). `snapshot_hash` + `master_existed` are
  **audit-only** now (written, no longer read). `doc_text` is retained as the evidence / re-judge
  source; plus timestamps. A **partial-unique index** on
  `workspace_id WHERE status IN ('extracting','reconciling','review')` enforces **at most one open run
  per workspace** (the one-open-run guard) — declared for **both** Postgres (`postgresql_where`) and
  SQLite (`sqlite_where`) so the offline gate exercises it.
- **`ingestion_proposals`** (`ingest_store.py`) — one reviewable proposal: `id` PK, indexed `run_id`
  + `workspace_id`, `payload` (the camelCase wire `IngestionProposal`: content / edited / evidence /
  unitKind / summary, plus the PR-E reconciliation envelope **relationship / targetWorkId / targetLabel
  / currentValue / decision** — server-owned + immutable, so an owner `edited` can never re-target an
  enrich/correction, invariant 2 / ADR 0008), `status` + `version` promoted to columns for the
  optimistic-lock UPDATE (mirrors `stored_cvs`), `applied_master_id` (the minted master id once
  applied — for an enrich it's `{workId}:{highlightId}`; the audit trail). `relationship` is read back
  out of `payload` for the bulk net-new gate (no separate column — it's immutable). Both new tables ⇒
  `create_all`, additive-only, no Alembic (ADR 0006).
- **Ingest unit kinds + apply-time dedup.** `unitKind` is one of `basics-field`, `work`, `education`,
  `skill`, `certificate` (**legacy** — DevPR31 stopped proposing certificates because nothing renders
  or edits `MasterProfile.certificates`; the kind + `ProposalContent.certificate` + the apply merge
  stay so persisted pre-DevPR31 runs still review/apply), `profile` (LinkedIn/GitHub links under
  `basics.profiles`), `language`, or `highlight` (enrich). On apply, every list unit dedups so a
  re-import never duplicates: skills by name, certificates by name/issuer/date (legacy runs), **profiles
  by url, education by institution/area/study-type, languages by name** (a re-import fills a
  previously-blank `fluency` — `ingest_apply.py`, the skills pattern, NOT `reconciler.py` which is
  work-only fuzzy matching). Certificates already applied to a master remain stored-but-invisible
  (persisted in the blob, shown nowhere) — a known limitation, see `features/ingest.md`.

## Wire format

All models emit **camelCase** JSON (`CamelModel` base, `alias_generator=to_camel`), matching the
design prototype and JSON Resume. Python stays snake_case.

## Storage

Postgres — `jsonb` document columns where the entity is a document, scalar rows elsewhere
(`cv_labels`, the provider config — except `provider_models`' cached model list, a JSON column).
Workspace-owned rows carry a `workspace_id` and every query is
scoped to it (invariant 8); the admin provider config is deliberately **global**, not
workspace-scoped (ADR 0006). Last-write-wins; no CRDT (invariant 7). The tables above are created via
`Base.metadata.create_all` on startup — **no Alembic yet** (ADR 0006). Schema changes
there are **additive-only** (new tables / nullable columns); destructive or existing-table
shape changes are manual until Alembic is adopted. The DB URL scheme
is normalized to `postgresql+asyncpg://` in `persistence/engine.py`, so Railway's plain
`postgresql://` reference works as-is.

## Versioning

Today every mutation — a manual save (`edit_bullet` / `sign_off`) **and** a Corrector apply
(`apply_corrections`) — bumps `version` **in place** on the single `stored_cvs` row under the
optimistic lock (`_guarded_save(expected=baseVersion)`), recording `parentVersion`. There is **no**
snapshot history table and **no** `cvFamilyId` yet. Persisted reviews **have now landed (ADR 0013)
WITHOUT history** — the `cv_reviews` table is a **latest-run-only snapshot** (one row per CV,
overwritten on re-run), explicitly decoupled from any run history or CV version history. So a
multi-row snapshot/diff history (with threads living at a family level keyed by stable `anchorId` so
they survive versioning) is **still deferred** and no longer blocked on persisted reviews. The
review-derived **Diff** landed (ADR 0015 — cumulative, navigation-surviving, derived from the persisted
`reviewedText` baseline; no snapshot store); a **snapshot-backed** multi-row Diff/verdict history and
`gkList` remain a future ADR (invariant 7). Retention cap: decide as that lands (small N per workspace).
