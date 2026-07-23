# ADR 0010: AI Review Panel — transient reviews, workspace-scoped grounded routes, JobSpec snapshot

Status: accepted  
Superseded-in-part: [ADR 0013](0013-persisted-review-runs.md) reverses the transient-reviews decision; the grounded routes and JobSpec snapshot stand.  
Date: 2026-06-27

## Context

The review milestone adds the OpenAI adjudicators (Editor / Fact-Checker / Gatekeeper) and the Claude
Spotter + Corrector — the missing `[review + correct]` middle of the loop (ingest → tailor → **review
→ correct** → sign-off → export → track). `docs/architecture/api.md` originally sketched these as
**stateless** `POST /ai/review` and `POST /ai/apply`. Several forces reshape that:

1. **Grounding must be on stored truth (invariant 2) and authorization re-derived per request
   (invariant 8).** The adjudicators judge a *specific stored CV*; the Corrector *persists a new
   version*. A stateless route taking a client-supplied CV would re-introduce the client-trusted
   input the provenance gate exists to remove, and would carry no workspace to authorize against.

2. **The Gatekeeper + Editor judge "against THIS posting" — but the JobSpec is discarded after
   tailoring.** A `StoredCV` keeps only `master` + `cv`; the `cv_labels` row keeps only title/company.
   The parsed `JobSpec` (`must_haves` / `ats_keywords` / seniority / tone) is gone, so a route that
   grounds on stored truth has nothing for those two agents to read.

3. **No schema migration of an existing table (ADR 0006).** `create_all` adds missing *tables*, never
   a column to the deployed `stored_cvs`. Anything persisted must be a new table.

4. **Reviews are advisory and consumed in-session.** The four reports drive the panel and the accept/
   reject decisions the candidate echoes into "apply corrections". Nothing downstream needs them after
   the correction lands; only the sign-off gate blocks export.

5. **There is no backend renderer.** `docs/architecture/renderer.md` described a backend→frontend
   render-fetch for "adjudicator text", but no such module exists, and a non-gated render route would
   risk leaking CV text (AGENTS §10).

## Decision

- **Workspace-scoped, grounded routes**, not stateless: `POST /workspaces/{id}/cv/{cv_id}/review`
  (owner-only fan-out) and `POST /workspaces/{id}/cv/{cv_id}/apply` (owner-only Corrector). Both load
  `{master, cv}` server-side via `cv_store.get_cv`; auth is re-derived from the membership store per
  request (invariant 8). The `api.md` "Planned: `ai/review`/`ai/apply`" lines are retired.

- **A `cv_job_specs` snapshot table** (additive, `create_all`-provisioned; keyed by `cv_id`,
  workspace-scoped) written at `create_cv` from the **owner's parsed JobSpec** (the Parser output the
  create request carries — owner-supplied, like today's tailoring input). The review route loads it so
  the Gatekeeper/Editor judge the *same* posting the CV was tailored to, server-side and
  tenant-isolated. It is the review **target only**, not a CV-grounding source — the provenance gate
  still grounds content in the server-loaded master, so an owner-chosen job can't affect what's
  exportable. A keyless verbatim draft has no JobSpec → its review runs only the job-independent
  agents (Fact-Checker + Spotter). The row is deleted alongside the CV (in `cv_store.delete_cv` and
  `delete_application`).

- **Reviews are transient (SSE-only), not persisted.** No `stored_cv_reviews` table. The fan-out
  streams `AgentReport`s; the client holds the bundle and echoes the accepted threads into the apply
  request. _(Since superseded: persisted-review behaviour now lives in
  [ADR 0013](0013-persisted-review-runs.md); human-reviewer collaboration was REMOVED by the
  2026-07-22 single-user pivot, DevPR41.)_

- **Adjudicators read the structured `TailoredCV` JSON**, which already carries every stable id — no
  rendered-text projection, no second renderer. A recruiter's-eye anchored-text input is a deferred
  refinement (a member-gated stateless render endpoint), not v1.

- **The Corrector is reword-in-place + server-authoritative.** It touches only accepted-thread bullets,
  preserves the exact `bulletId` set and each bullet's parent `(section, item, item.sourceId)`
  (extending ADR 0003's anchoring guarantee via `assert_structure_preserved`), and the server re-grounds
  only the changed bullets (never cv-wide, which would clobber prior sign-off) and re-runs the
  provenance gate so a drifted correction re-gates to `needsSignoff`. `version`/`parentVersion` stay
  server-owned (`_guarded_save`).

## Consequences

- A needs-sign-off CV is reviewable (the review load is not the gated export path); the sign-off gate,
  not the advisory verdict, remains the only export block (invariant 2).
- Multi-reviewer collaboration, presence, and persisted review threads are explicitly
  out of scope and remain a later, multi-tenant bet. _(REMOVED by the 2026-07-22 single-user
  pivot: multi-reviewer collaboration and presence are no longer a planned bet; persisted-review
  behaviour landed via [ADR 0013](0013-persisted-review-runs.md).)_
- Legacy CVs created before `cv_job_specs` read as "no job" (Gatekeeper/Editor unavailable) until
  re-tailored — accepted degradation.

## Alternatives considered

- **Stateless `/ai/review` + `/ai/apply` (the original sketch).** Rejected: client-supplied CV breaks
  grounding (invariant 2) and carries no workspace to authorize (invariant 8).
- **Persist reviews in a `stored_cv_reviews` table.** Rejected for v1: reviews are advisory and
  consumed in-session; persistence adds a table and a lifecycle with no v1 consumer.
- **A backend render projection / non-gated render route for adjudicator text.** Rejected: no backend
  renderer exists, it would duplicate the frontend one, and "non-gated" risks leaking CV text
  (AGENTS §10). The JSON carries every anchor the agents need.
