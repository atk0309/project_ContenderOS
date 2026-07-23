# ADR 0011: Design system as a verifiable contract; Gatekeeper/Diff as transient per-CV views

Status: accepted  
Superseded-in-part: [ADR 0012](0012-workspace-3pane-and-in-paper-editing.md) reverses the in-paper-editing divergence in §2.  
Superseded-in-part: [ADR 0013](0013-persisted-review-runs.md) reverses the transient-verdict premise; Diff and Gatekeeper stay transient views.  
Superseded-in-part: [ADR 0015](0015-durable-derived-diff.md) — the Diff is now durable **by derivation** from the persisted `reviewedText` baseline; line 5's "Diff and Gatekeeper stay transient views" no longer holds **for the Diff** (the Gatekeeper stays transient).  
Date: 2026-06-28

## Context

The functional product was complete but the UI did not match the intended Claude design. The design
was delivered as `.dc.html` mockups via the `claude_design` MCP (`DesignSync`). A first plan to
"restyle to tokens" was rejected: design fidelity needs to be a **first-class, verifiable** principle,
not a matter of opinion. Separately, the new design surfaces (Gatekeeper verdict, Diff) lean on data
that is **transient** — the AI review verdict (`ReviewBundle.gatekeeper`) is advisory, SSE-only, and
never persisted (invariant 2, ADR 0010), and there is no CV snapshot/version history (deferred,
`data-model.md`).

## Decision

1. **Vendor the design into the repo and make fidelity machine- and rubric-checkable.** The canonical
   mockups live in `docs/design/`; `docs/architecture/design-system.md` is the spec; a machine guard
   in `scripts/check-invariants.mjs` forbids ad-hoc colour literals in `src/app`/`src/ui` and chrome
   `var(--…)` in the render `template-tokens.ts`; a dev-only `/design` route locks the primitives; and
   every screen PR scores a per-screen rubric against the vendored reference in dark+light × desktop+
   iPhone.
2. **Gatekeeper and Diff are same-session, per-CV subviews, not persisted routes.** They render the
   live review verdict / the in-session pre-vs-post-apply CV (matched by stable `bulletId`), with
   designed empty/stale states; no new persistence. Where the mockup outruns the backend (the `gkList`
   cross-application grid; Gatekeeper headline/sub/impression + per-fix deltas; the posting-source PDF
   panel; in-paper editing), each is a **named divergence** recorded in `design-system.md`.

## Options considered

- **A: Restyle screens to tokens, verify by eye.** Fast, but fidelity is unprovable and drifts — the
  rejected approach.
- **B (chosen): Fidelity as a contract** (vendored source + spec + machine guard + `/design` gate +
  per-screen rubric) and **transient Gatekeeper/Diff** reusing shipped data. More upfront work
  (foundation lands before screens), but fidelity is enforceable and no speculative persistence is
  built for reviewer collaboration (since removed outright — the single-user pivot, DevPR41).
- **C: Persist verdicts + CV snapshots to back the design literally** (gkList, durable diff). Largest
  scope; pulls in versioning + reviewer-collaboration work that was removed outright (the
  single-user pivot) — deferred.

## Consequences

- Easier: every later screen is checked against one locked source; a reviewer can objectively decide
  "matches/deviates"; the chrome-vs-paper token boundary (invariant 3) is now machine-enforced.
- Harder/constrained: a foundation milestone (vendor + spec + guard + primitives + `/design`) must
  land and be signed off before any screen PR; some mockup surfaces are deliberately not reproduced.
- Follow-ups: if CV versioning ever lands (human-reviewer collaboration was removed outright,
  DevPR41), `gkList` and a durable
  Diff become a future ADR (persisted reviews + snapshot history).

## Links

`docs/architecture/design-system.md`, `docs/design/` (vendored `Contender.dc.html` +
`ReviewNote.dc.html`), ADR 0010 (transient reviews), ADR 0003 (stable-id anchoring), and
`docs/invariants.md` (2, 3).
