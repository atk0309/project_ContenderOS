# ADR 0008: Ingestion reconciliation — classify-by-index, server-built, two-phase grounding

Status: accepted  
Date: 2026-06-25

## Context

PR-E adds reconciliation to the CV/LinkedIn → master ingestion pipeline: when a master already
exists, each extracted unit must be classified against it — a **net-new** unit, an **enrich** (a new
bullet for an existing work entry), or a **correction** (a changed basics field) — before the owner
reviews it. Three forces shape the design:

1. **The structured-output grammar budget (ADR 0007 / the optionality lesson).** Anthropic's
   `messages.parse` compiles the output schema into a sampling grammar and **rejects schemas whose
   grammar is too costly** ("Schema is too complex" / "Grammar compilation timed out"). The driver is
   the **number of OPTIONAL (omittable) fields in a single object** (~2^N presence subsets), *not*
   property/def/`anyOf` count or size — live-proven: the optional-dense `RawBasics` failed while the
   *larger* but mostly-required qualifications/`TailoredCV` passed. A defaulted field is still
   omittable, so a `= []`/`= ""` default does **not** help; the field must be required.

2. **Fidelity + the sign-off gate (invariant 2).** This is the owner's *real* CV. A model that
   re-emits or rewords their facts during reconciliation risks drift past the owner's accept and the
   provenance gate.

3. **Server authority (invariants 2, 8).** The server — never the model or client — decides what
   enters the master, re-derived from stored state.

The original plan had a single Reconciler emit a heterogeneous list of `{relationship, targetRef{
workId?, highlightId?, fieldPath?}, content: one-of-5-union, …}` — an object dense with optional
fields, exactly the shape the grammar compiler rejects.

## Decision

- **Only WORK matching needs a model.** Skills/certs already dedup deterministically; basics is a
  per-field comparison (empty→fill, equal→suppress, different→correction); education has no in-place
  merge. So a single **work Reconciler** (Claude — authoring side, invariant 6) is the only model
  call; everything else is deterministic server code.
- **The model classifies by INDEX and never re-emits content.** The Reconciler output is a single
  **required** list of fixed-shape `WorkMatch {extractedIndex: int, masterWorkId: str}` (0 optional
  fields, no prose) — `WorkReconciliation {matches: list[WorkMatch]}`. Structurally simpler than the
  live-passing `ExtractedWorkList`; the list is required (no default) so the model can't omit it and
  re-introduce optionality. The verbatim unit content keeps flowing from the Extractor.
- **The server diffs highlights and re-grounds the target, mirroring `derive_provenance`.** For a
  matched role, a new `enrich` proposal is built per extracted highlight not already on the target
  entry (normalised). A match whose `masterWorkId` isn't a real master entry (or a duplicate/out-of-
  range index) is demoted to net-new — the analogue of `derive_provenance` nulling a `sourceId` that
  isn't a real master bullet.
- **The reconciliation envelope is server-owned and immutable.** `targetWorkId` / `targetLabel` /
  `currentValue` / `relationship` / `decision` live on the `IngestionProposal` envelope, *not* in the
  editable `ProposalContent`. The owner edits a bullet's text or a correction's value; they can never
  re-target the merge to a different employer or field. A correction reads its `fieldPath` from the
  server-built `content`, never from `edited`.
- **Two-phase grounding.** Reconcile-time grounding (against the run's master snapshot) catches model
  hallucination and bakes the immutable envelope; apply-time grounding (against the live master under
  the advisory lock) is defense-in-depth. The run-level snapshot 409 remains **the** staleness
  guard — a target deleted between reconcile and apply fails the whole run closed, not silently. That
  guard re-hashes the run's stored `master_snapshot` with the current serializer (not a hash frozen
  at create — `snapshot_hash` is now audit-only), so an additive `MasterProfile` field shipped while
  a run is open doesn't shift an unchanged master's hash and falsely 409 it (D2a).
- **Net-new is the sole bulk predicate.** "Add all new items" flips only `net-new` proposals (the
  server re-derives this from the immutable stored `relationship`; an enrich/correction id → 422).
  Enrich/correction require a deliberate per-item accept on a target-visible card.

## Consequences

- The work Reconciler's `WorkReconciliation` and the Judge's `JudgeReport` (E2) are each **re-spiked
  against a real key** before code depends on them — the offline fake runner returns canned objects
  and is falsely green; a too-complex schema only 400s against the live API.
- The model never authors CV prose during ingestion, so reconciliation can't introduce an
  unsigned-off claim; the owner's verbatim extraction is what lands, edited only by the owner.
- Cross-employer *matching judgment* is the owner's, not a hard server gate: the server enforces the
  structural line (real target id, append-only, id-preserving) and surfaces a "different employer?"
  hint; the owner adjudicates on a never-bulk-accepted card. A hard company-name demote was rejected
  as both defeating the fuzzy matcher ("Google" ≠ "Google LLC") and unsafe within a company.
- The advisory **Judge** (OpenAI, E2) layers verdicts on top without gating apply or the bulk add —
  an OpenAI outage degrades verdicts to "needs-review" and the run still reaches review.
