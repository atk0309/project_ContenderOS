# Security

Status: active — seed doc  
Last updated: 2026-07-22

Update on any change under `backend/app/auth/` (`auth-change`) or workspace/ownership/isolation
queries under `backend/app/persistence/` (`tenancy-change`).

**The deny matrix (pinned):** signed-out → **401** · authenticated but non-allowlisted (incl. live
revocation) → **403** · cross-workspace → **403/404 fail-closed** · gate column: **owner**.

## Authentication & access

Two sign-in paths, both server-side (`backend/app/auth/`), both converging on **one signed session
cookie**. Access is derived and enforced on the backend; the client never asserts identity or
sign-off. The app is a **single-user tool**: one workspace, and **every `ALLOWLIST_EMAILS` entry is
an owner account** (deny-by-default for everyone else) — see **Tenant isolation** below and
invariant 8.

- **Allowlist** (`auth/allowlist.py`). `ALLOWLIST_EMAILS` is comma-separated, case-insensitive.
  Every entry is an owner; anyone else is rejected. `is_allowlisted(email)` is the single chokepoint
  both sign-in paths call. (This is the single-workspace stand-in for per-workspace membership; see
  Tenant isolation.)
- **Live revocation → 403.** `current_user` (`auth/deps.py`) revalidates the allowlist on **every**
  request: a valid session whose email was removed from `ALLOWLIST_EMAILS` fails closed with **403**
  (asserted exactly in `test_auth.py`) — a cookie is never a grant on its own. No sign-in-flow route
  depends on `current_user` (magic/entra/logout take only `Request`), so revocation can never lock
  anyone out of signing in or out.
- **Deploy-skew + rollback shims (removed next release).** The frontend and backend deploy as
  separate Railway services, so both directions of version skew are covered: `AuthUser.role` stays
  on the wire as a **vestigial `Literal["owner"]` constant** (`deprecated=True` — an old client
  keeps working; post-pivot semantics make everyone the owner), and `login_user` writes a
  **legacy-COMPATIBLE** session `role` key (`"owner"` only for the FIRST allowlist entry, matching
  the pre-pivot `resolve_role` exactly) so a rollback to old code restores exactly the old
  semantics — a blanket `"owner"` write would have granted the second account `/admin` under the old
  gate. `get_session_user` reads only `email` and ignores any stored `role` key (old cookies keep
  working forward).
- **M365 SSO** (`auth/entra.py`, Authlib OIDC). **Configured and live in production** (AGENTS.md
  §10). Mechanically fail-closed: `entra_configured()` gates the routes, which return **503**
  unless all three `AUTH_MICROSOFT_ENTRA_ID_*` vars are set (they are, in prod). On callback
  the email claim is checked against the allowlist; non-allowlisted → `/sign-in?error=not_allowed`.
- **Magic link** (`auth/magic.py`, Resend). Stateless: a short-lived `itsdangerous`-signed token
  (`AUTH_SECRET`, 15-min TTL) carries the email — **no DB**. `/auth/magic/request` always returns
  `ok` and only emails allowlisted addresses, so it never reveals who is on the list. Callback
  re-checks the allowlist before issuing the session. (Stateless ⇒ a token is reusable until it
  expires; strict single-use can come with persistence.)
- **Session cookie** (Starlette `SessionMiddleware`, signed with `AUTH_SECRET`). http-only, `Secure`
  (`COOKIE_SECURE`), `SameSite` from `COOKIE_SAMESITE`. The frontend hits `/auth/me` to gate routes;
  on 401 it redirects to `/sign-in`. The same secret signs the magic-link tokens
  (`config.signing_secret`), and it is **required outside `development`** — the app fails closed at
  startup rather than fall back to a public key (which would let anyone mint an owner session).
- **Opaque magic-link request.** `/auth/magic/request` swallows + logs delivery failures so a Resend
  outage can't turn it into an allowlist oracle (200 vs 500); it always returns `ok`.
- **Private backend, same-origin cookie** (ADR 0005). The backend has **no public domain**; the
  browser talks only to the frontend, which reverse-proxies `/auth/*`, `/ai/*`, `/workspaces/*`, and
  `/admin/*` to the private
  backend (`frontend/src/lib/proxy.ts`). So the cookie is same-origin → `COOKIE_SAMESITE=lax` +
  `COOKIE_SECURE=true`, and CORS is defensive-only (server-to-server calls don't trigger it).
  Browser-facing redirects (magic-link callback, Entra redirect URI) use `FRONTEND_BASE_URL`.
- All `/ai/*` routes mount behind `Depends(current_user)`; `/admin/*` adds `require_owner` (owner
  only). Add allow **and** deny tests for any auth change (`backend/tests/test_auth.py`,
  `test_admin.py`).

## Tenant isolation (invariant 8)

Isolation is load-bearing even single-user: a member of workspace A must never read or write
workspace B's data, and a de-allowlisted account must fail closed everywhere. The mechanism exists
now (allowlist-backed); a database swaps in behind it without changing the rules.

- **Authorize per workspace, server-side, deny-by-default.** `require_workspace_owner`
  (`auth/deps.py`) is THE workspace gate (every allowlisted account is an owner, so the old
  member/owner split collapsed into it). It re-derives the caller's membership for **that**
  workspace from the membership store every request — never from a client-supplied workspace id or
  claim. No membership ⇒ 403 (the unauthenticated are 401'd first), never a silent result that
  leaks existence.
- **Membership lives in the data layer.** `backend/app/persistence/memberships.py` is the single
  chokepoint (`MembershipStore.is_member`). Today `AllowlistMembershipStore` models one implicit
  workspace (`DEFAULT_WORKSPACE_ID`, owned by every allowlisted account; any other workspace id ⇒
  `False`). A Postgres-backed store implements the same interface if multi-workspace ever lands.
  The `tenancy-change` doc-impact rule keeps this doc moving with that layer.
- **Tested allow *and* cross-tenant deny.** `backend/tests/test_tenancy.py` proves a member is
  authorized and that a member of one workspace is **denied (403) on another** — the isolation
  guarantee, exercised against the in-memory membership test double (relocated to
  `backend/tests/factories.py`; production always resolves `AllowlistMembershipStore`) and ready
  to re-point at the DB.
- `require_owner` (`auth/deps.py`) remains the admin gate — defense-in-depth: it re-checks the
  allowlist over `current_user`'s revalidation, so `/admin/*` stays visibly owner-gated.
- **CVs are the first workspace-scoped owned rows.** `stored_cvs` (`persistence/cv_store.py`) carries
  a `workspace_id`; **every** `/workspaces/{workspace_id}/cv*` route (`routes/cv.py`) authorizes
  through `require_workspace_owner`. The store filters **every** read/write on `(workspace_id,
  cv_id)`, so a CV id guessed across tenants is a **404**, not a denied-after-the-fact leak. The
  dashboard **list** (`GET /workspaces/{id}/cv` → `cv_store.list_cvs`) is scoped the same way: it
  filters on `workspace_id` and LEFT-JOINs `cv_labels` **also** on `workspace_id`, so neither a CV
  nor its job label crosses a tenant boundary. Bullet edits and sign-offs reassign
  the whole `cv` blob under an **optimistic version lock** keyed on the **client-supplied
  `baseVersion`** (the version the client was viewing) — so a stale browser tab loses with a **409**
  (`StaleCV`) rather than silently clobbering a newer edit or approving text it never saw. The client
  also serializes its own writes and reloads on 409. `backend/tests/test_cv.py` covers the allow path
  plus the deny paths: a non-member → 403, a `(workspace, cv)` mismatch → 404, an unknown/blank-text
  edit → 422, an edit to a net-new bullet stays gated (and re-flags a signed-off one), an unrelated
  edit does **not** clobber another bullet's sign-off, and a stale-`baseVersion` edit **or** sign-off
  → 409. The list route adds: a non-member → 403; the list
  is workspace-scoped (a CV/label seeded in `ws2` never appears in the `default` listing, and vice
  versa); and `needsSignoff` flips false in the summary after sign-off. **Delete** (`DELETE
  .../cv/{id}`) removes the CV **and** its `cv_labels` + `cv_job_specs` rows in
  one commit; a cross-tenant delete is a **404** that leaves the real row intact (asserted), and a
  non-member is 403.
- **The CV's tailored-against `JobSpec` is workspace-scoped too.** `cv_job_specs` (`persistence/
  cv_store.py`) carries the indexed `workspace_id`. It holds the **owner's parsed posting** (the
  Parser output the create request carries — owner-supplied, like today's tailoring input), persisted
  server-side at create and read back only via `cv_store.get_job_spec`, which filters on
  `(workspace_id, cv_id)` — so a cross-tenant CV id reads as `None`, never another tenant's posting.
  It exists so the review panel's Gatekeeper/Editor judge the **same** posting the CV was tailored to,
  server-side and tenant-isolated. It is the review **target only**, never a CV-grounding source: the
  provenance gate (invariant 2) still grounds CV content in the server-loaded master, so an
  owner-chosen job shapes only the advisory verdict and can't affect what's exportable. Deleted with
  the CV in **both** delete paths (`delete_cv` and `delete_application`). `backend/tests/test_cv.py` /
  `backend/tests/test_applications.py` assert the create/read/delete and the cross-tenant `None`
  (invariant 8).
- **Application tracking is owner-only and workspace-scoped.** `stored_applications`
  (`persistence/application_store.py`) carries a `workspace_id`; **every** `/workspaces/{id}/
  applications*` route (`routes/applications.py`) — including the `by-cv` lock lookup — authorizes
  through `require_workspace_owner`, so an application's existence/metadata never leaks to a
  non-member (invariant 8). **`by-cv` is the one convention exception:** a **miss** returns **200 JSON `null`**
  instead of the id-keyed reads' 404 (the workspace probes it on every load, so 404-per-unapplied-CV
  was console noise). Authorization is unchanged — a non-member still 403s; because reaching the store
  requires owning the queried workspace, a cross-tenant miss (an owner of workspace X probing a CV
  that lives in Y) returns the same `null`, which carries zero foreign data and is exactly what the
  old 404 communicated — not a leak. The write path stays owner-only + workspace-scoped, including
  the recruiter-contact write (`PATCH …/recruiter`, `update_recruiter`), which
  is owner-only + workspace-scoped like every other verb. Concurrent same-application mutations
  (`update_stage` / `update_recruiter`) are **last-write-wins** (invariant 7): both reassign the whole
  `application` JSON blob, so a rare overlapping Save + stage-move on one row can revert one field —
  accepted for this owner-only single-writer tracker, not a leak. Apply re-reads the CV server-side and
  enforces the **same provenance gate as export**
  (invariant 2): it refuses with **409 `ExportBlocked`** while any net-new bullet is unsigned, never
  trusting a client claim that a CV is clean. Applying **locks** the CV (derived from the row's
  existence — ADR 0009): `cv_store`'s `edit_bullet`/`sign_off`/`apply_corrections`/`delete_cv` then
  refuse it with **409 `cvLocked`**, so the sent CV is immutable server-side. Apply and those
  mutations **serialize on a per-CV advisory lock** (`lock_cv`) so a concurrent edit can't leave a
  locked-but-unsigned CV; the
  unique `(workspace_id, cv_id)` constraint is the backend-portable backstop for a double-apply (**409
  `alreadyApplied`**). The lock is a no-op on SQLite, so the cross-writer race is a Postgres-only
  guarantee, exercised by a `TEST_POSTGRES_URL`-gated test, never claimed from the SQLite gate (AGENTS
  §4). `delete_application` removes the application **and** its locked CV (+ `cv_labels`) in one commit
  under the lock — every query filtered on `(workspace_id, …)`, so a cross-tenant id on the id-keyed
  reads/mutations is a **404**, no other tenant's row touched (the `by-cv` probe is the noted 200-`null`
  exception). `backend/tests/test_applications.py` covers allow + deny per verb (stranger **403** on every
  verb, a `ws2` application unreachable through `default` → id-keyed reads/mutations **404**,
  the `by-cv` probe **200 `null`**), the
  apply gate (**409**), stale/already-applied/locked **409**s, the title **422**, and the cascade.
- **The Corrector apply path is owner-only and server-authoritative over what persists.** `POST
  .../cv/{cvId}/apply` (`require_workspace_owner`) trusts the client's accepted `threads` as Corrector
  *input* only; the **output** is the authority. The Corrector is **per-bullet** (DevPR29): it returns
  only `{bulletId → text}` for the accepted bullets — never structure — so there is nothing to
  add/drop/re-parent and structure is preserved BY CONSTRUCTION. A cheap preflight rejects a
  stale/locked CV (**409**) **before** the billed LLM; the Claude call runs **outside** any DB
  transaction (a session-free authoring runner + a committed preflight, so no connection idles
  in-transaction across it); then `cv_store.apply_corrections` takes `lock_cv`, re-checks `is_applied`
  (**409 `cvLocked`**), forces a fresh read (`session.refresh`, since the sessionmaker is
  `expire_on_commit=False`), and **splices only the accepted bullets' text** onto the **stored** CV —
  so unaccepted bullets, the summary, and the structure are byte-stable by construction. The splice
  takes only the model's **new text** and **preserves each bullet's stored `sourceId`/`origin`**
  (reword-in-place, like `edit_bullet`) — and because the per-bullet revision carries **no** `sourceId`
  at all, a net-new bullet stays gated and a model cannot attach a real `sourceId` to ground an
  unbacked claim past sign-off. The old whole-CV `assert_structure_preserved` tripwire is therefore
  unnecessary; instead a **missing** revision for an accepted bullet, or a **blank/oversized** text →
  **422** (splice-time `StructureViolation`), a **duplicate** revision id → **422** (route), and an
  **unknown/extra** id is ignored (never spliced). Each changed bullet is re-grounded from its stored
  source (**never** cv-wide `derive_provenance`, which would clobber prior sign-offs), so the
  provenance gate (invariant 2) can't be bypassed by a misbehaving model output. `_guarded_save(expected=baseVersion)` is the
  lost-update backstop (**409 `StaleCV`**). `backend/tests/test_corrector.py` covers owner **200** /
  non-member **403** / cross-tenant **404** plus the structural / drift / lock cases.
- **Persisted review runs are owner-only and workspace-scoped (ADR 0013).** `cv_reviews`
  (`persistence/review_store.py`) carries a `cv_id` PK + indexed `workspace_id`; every query filters on
  `(workspace_id, cv_id)`. All three review routes are **`require_workspace_owner`** — a review run (and
  the owner's per-finding accept/reject decisions) belongs to the workspace: `GET
  .../cv/{id}/review` reads the stored `SavedReview`, `PUT .../cv/{id}/review/decisions` writes the
  whole decisions snapshot (last-write-wins, invariant 7), and **`DELETE .../cv/{id}/review`** (the
  owner's "Clear review") wipes the run + its decisions. Reads/writes/deletes are re-derived from
  membership per request, so a stranger is **403** on all three. **Cross-tenant
  behaviour diverges by verb, deliberately:** a cross-workspace `GET .../review` returns **200-null** (the
  rehydrate probe fires on every workspace mount, so a miss must not be console-noisy) — the filter
  finds no row, so **zero foreign data** is returned, exactly like `cv_store.get_job_spec`'s `None`;
  the `PUT .../review/decisions` keeps the standard **404** (`ReviewNotFound`); the `DELETE .../review`
  is **idempotent** — a workspace-scoped 0-row-safe delete, so a cross-workspace clear is a **200 no-op**
  that removes nothing (the target workspace's row is untouched). A stored bundle that no
  longer validates against the current `ReviewBundle` also reads as 200-null (schema skew self-heals as
  "no review"), never leaking a partial/foreign blob. The row is deleted with the CV
  (`cv_store.delete_cv` and `application_store.delete_application`), by the owner's **Clear review**
  (`DELETE .../review`); at **apply**
  (`cv_store.apply_corrections`) it is **RESOLVED in place, not deleted** (ADR 0014) — the applied
  bullets are recorded in `bundle.resolvedAnchorIds` and the row is kept (at its `cv_version`) so the
  owner's other, un-applied notes survive, all under the same `(workspace_id, cv_id)` filter.
  `backend/tests/test_review.py` covers owner **200** / stranger **403** (incl. the
  DELETE clear), the DELETE owner-clear (row gone) + idempotent second-clear/never-reviewed **200** +
  cross-workspace clear leaving the other workspace's row untouched, the
  cross-workspace GET→null (zero foreign data) and PUT→404, the decisions 409/422 guards, the
  lifecycle deletes, and that apply **resolves** (not deletes) the review (row kept + applied ids
  marked + decisions preserved), no-ops against a `save_failed` review, and can't be resurrected by a
  stale post-apply settle.
  Both verbs also refuse **orphan rows** (a lockless settle can outlive a concurrent CV
  delete, ADR 0013): they probe the CV's existence with an ownership-scoped query first —
  `GET` self-heals (deletes the orphan, reads null), `PUT` 404s — so review content for a
  deleted CV is never served or writable.
  Persistence also **never-regresses against the live CV version**: `save_review`'s conditional
  upsert carries `EXISTS(stored_cvs WHERE version <= reviewed version)` on **both** the UPDATE and
  the guarded-INSERT arm, so a run that reviewed version N is refused (`ReviewSuperseded` →
  `X-Review-Saved: false`) once the CV has advanced past N — whether by a concurrent edit during the
  fan-out or by a later apply — and can never clobber the review of a newer CV state.
- **The master is workspace-scoped and server-authoritative.** `stored_masters`
  (`persistence/master_store.py`) carries a `workspace_id` (its PK); both `/workspaces/{id}/master`
  verbs authorize through `require_workspace_owner`. The
  persisting tailor route (`POST .../cv`) **and** the AI-free draft (`POST .../cv/from-master`) load
  the master **server-side** from this store — so the grounding source for provenance (invariant 2) is
  stored truth, never a client-supplied master JSON. `validate_master_ids` rejects a blank / duplicate
  / `:`-bearing stable id before storing (→ 422; these ids are the provenance anchors and `:` is the
  draft's id-namespacing delimiter). The master row is **version-less** (one blob per workspace,
  last-write-wins), so the two writers that read-modify-write it — `PUT /master` (`upsert_master`) and
  the ingestion **apply** step (`write_master`, no-commit, landing with the ingestion pipeline) —
  **serialize on a per-workspace Postgres advisory lock** (`persistence/locks.py`,
  `lock_workspace_master`); a manual master edit and an ingest apply cannot silently clobber each
  other. The lock is a no-op on SQLite (the offline suite), so the cross-writer race is a Postgres-only
  guarantee, exercised by a `TEST_POSTGRES_URL`-gated integration test rather than the SQLite gate (a
  skip is a declared gap, not a pass — AGENTS §4). `backend/tests/test_master.py` covers allow (owner
  upsert + read) and deny (non-member → 403, cross-tenant → 403) plus the id-validation 422s, the
  no-commit `write_master` contract, and the lock's SQLite no-op; `backend/tests/test_draft.py` covers
  the keyless draft (zero net-new → exports without sign-off).
- **Ingestion builds the master under the same gate.** The `/workspaces/{id}/ingest*` routes
  (`routes/ingest.py`) are **owner-only**: a document is **pasted (`POST .../ingest`) or uploaded as a
  PDF (`POST .../ingest/file`)**, parsed into proposals that persist server-side (`ingestion_runs` /
  `ingestion_proposals`, every query filtered on `workspace_id`), and nothing enters the master until
  the owner **accepts** — the ingestion analogue of the invariant-2 sign-off gate. The PDF upload
  stores the candidate-supplied **filename as opaque display metadata only** (truncated to 255 chars,
  never used in a filesystem path or query); the bytes are byte/page-capped (**413**) and parse-checked
  (**422**) before they reach the model. `apply` works by stored `proposalId` (never client master
  JSON), mints every stable id server-side, and writes through `master_store.write_master` under the
  per-workspace advisory lock (so a concurrent manual edit can't clobber it), refusing with **409** if
  the master changed since the run started. Bulk-accept ("add all new items") re-derives eligibility
  from STORED state — it flips only proposals still **pending** AND **`relationship == net-new`** (the
  relationship is immutable in the payload), so a client list can't admit an enrich/correction (those
  need a deliberate per-item accept, **422** otherwise) or any proposal the server wouldn't (invariant
  2). The PR-E reconciliation envelope (`targetWorkId` / `currentValue` / `relationship`) is
  server-owned and never read from the owner's `edited`, so an edit can't re-target a merge or
  correction. `backend/tests/test_ingest.py` covers allow (owner)
  + deny (non-member **403**, a `ws2` run unreachable through `default` → **404**) on
  both the paste and upload arms, the one-open-run **409**, the optimistic-lock **409**, the first-run
  identity **422**, and the staleness **409**.

## Secrets

- **Provider API keys are admin-managed + encrypted at rest** (ADR 0006). The owner enters a key in
  the Admin Menu; it transits the same-origin proxy and is stored Fernet-encrypted in Postgres
  (`provider_secrets`). The guarantee (invariant 4, reworded): **never bundled in client JS, never
  persisted client-side, never returned unmasked** (the API exposes only `isSet` + `last4`),
  encrypted at rest, and the input field clears on save. No browser-side direct-to-provider calls.
  `scripts/check-invariants.mjs` fails the gate if a provider-key identifier appears under
  `frontend/src/`.
- **Master key** `SECRETS_ENCRYPTION_KEY` (Fernet) is the only provider secret in env; it fails
  closed outside development (like `AUTH_SECRET`) and is validated at startup. Rotating it
  invalidates stored keys (re-enter them); a decrypt failure surfaces as a 503, never a 500.
- **Owner-only admin surface.** All `/admin/*` routes mount behind `Depends(current_user)` **and**
  `require_owner` (non-allowlisted → 403, the defense-in-depth re-check). Keys are write-only — a GET only ever returns the masked status.
- Never commit secrets or real CV/personal data; use `<API_KEY>` placeholders in docs/tests.

## Trust boundaries

- The client supplies only edits; it never supplies trusted scores, `origin` values, or sign-off
  state — the server derives and gates those. Concretely (invariant 2): after every Tailor run,
  `app/ai/provenance.py` (via `run_tailor`) re-derives each bullet's `origin`/`needsSignoff` from the
  master, forcing any bullet **not grounded in a highlight of its own item's work entry** to `net-new`
  + `needsSignoff` (nulling its `sourceId`) — this catches both unbacked claims and a real highlight
  borrowed from another employer (which the renderer would misattribute). The owner-only
  `GET .../cv/{id}/export` then refuses with **409** until those bullets are signed off, so a net-new
  claim cannot be exported without explicit candidate approval. The gate enforces *grounding*, not
  *truthfulness* — an overstatement on a real source is the Fact-Checker/Editor layer's job
  (invariant 6), not this gate's. The CV is derived from the workspace's **stored** master (loaded
  server-side), not a client-supplied master, so the grounding source itself is no longer client-trusted.
- The same-origin proxy now also forwards `/workspaces/*` (alongside `/auth/*`, `/ai/*`, `/admin/*`)
  to the private backend; server-side render fetches go direct and carry the session cookie.
- The M365 SSO gate is **wired and live** in production (deny-by-default, enforced server-side per
  invariant 8). Keep every CV-bearing route behind it — never expose real CV data on an ungated path.
