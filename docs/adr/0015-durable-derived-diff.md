# ADR 0015: The Diff is durable by derivation from the review baseline

Status: accepted  
Date: 2026-07-04

## Context

The workspace Diff sub-view (`?view=diff`) was a same-session, client-derived before/after of the most
recent Apply-corrections (ADR 0011 §2; ADR 0013 re-affirmed "no durable Diff — the Diff stays transient").
It held an ephemeral `{ before, after }` in React state, captured at apply time, and its `before` baseline
was re-read as the *current* CV on every apply. Two consequences the user hit on a tablet:

- **Not cumulative.** Because `before` advanced to the already-corrected CV each apply, the diff showed only
  the single bullet changed by the *last* apply — never the accumulation of a review session's fixes.
- **Lost on navigation.** The captured state was client-only; leaving to the `/workspace` list and back
  (a hard nav / clean remount) discarded it, so the Diff vanished.

The pre-review text per bullet is **already persisted**: `review.reviewedText` is captured at review-start,
saved with the review run (ADR 0013), and rehydrated on remount. So a cumulative, navigation-surviving diff
needs no new storage — only a different source of truth.

## Decision

The Diff is **derived, not captured**: it is every bullet whose current **saved** text differs from the
review-start baseline (`review.reviewedText`), computed live on each visit
(`diffChangedBulletsFromSnapshot(review.reviewedText, savedCv)`).

- **Cumulative** — the baseline is the stable review-start snapshot (set once, never advanced by an apply
  or sign-off), so the diff shows *all* changes since the review ran: applied corrections **and** manual
  edits.
- **Durable by derivation** — both inputs (`reviewedText` and the saved CV) are persisted and rehydrate on
  remount, so the Diff survives navigation/reload. There is **no new snapshot table and no run history** —
  the durability is a property of deriving from already-persisted state.
- **Neutral** — a changed bullet carries **no per-line agent attribution**; it shows the before/after only.
- **Saved text, not the draft overlay** — an unsaved keystroke never appears as a change.
- **Graceful empty state** — absent a same-CV review (`review === null`), the change set is empty and the
  view renders its empty state (also covers a direct/reloaded `?view=diff` on a review-less CV).

The whole-CV `diffChangedBullets(before, after)` is retained as a thin wrapper over
`diffChangedBulletsFromSnapshot` for its unit tests. `diffStillLive` and the apply-time `sources` capture
(`acceptedThreadSources`) are removed as dead.

## Options considered

- **Keep the Diff transient (status quo)** — rejected: fails both the cumulative and the survives-navigation
  requirements the user reported.
- **Persist a snapshot/history table for the Diff** — rejected: ADR 0013 deliberately defers run history;
  the baseline is already persisted, so a table adds a lifecycle with no other consumer.
- **Attributed diff (label each changed line with the reviewer who prompted it, chosen)** — **rejected.** A
  bullet you correct and then hand-edit would still be stamped as an agent "correction" over text you wrote
  (`resolvedAnchorIds` only accumulates; a manual `/edit` never clears it) — a provenance lie (invariant 2)
  in the one product that exists to prevent them. Neutral removes the `resolvedAnchorIds`/`sourcesForBullets`
  label logic entirely and can never mis-attribute.
- **Derived + neutral (chosen)** — cumulative, durable-by-derivation, honest, and no new persistence.

## Consequences

- The Diff now shows manual edits (since the review) alongside applied corrections; copy is neutral
  ("changed bullet", "Changes since your last review"), never "correction … applied to your document".
- A new low-emphasis top-bar "View diff" entry (gated on there being changes) makes the Diff reachable even
  when no review marker is open (e.g. a manual-edit-only session).
- Still deferred (unchanged from ADR 0013): review run **history**, a snapshot-backed multi-row
  Diff/verdict store, and `gkList`. The Gatekeeper sub-view stays transient.

## Links

- `frontend/src/app/(app)/workspace/DiffView.tsx`, `logic.ts`
  (`diffChangedBulletsFromSnapshot`, `reviewedTextSnapshot`), `page.tsx` (`changedSinceReview`).
- Supersedes-in-part: [ADR 0011](0011-design-system-and-transient-views.md) §2 (Diff clause),
  [ADR 0013](0013-persisted-review-runs.md) (the "no durable Diff" clauses). Builds on
  [ADR 0014](0014-incremental-apply-keeps-surviving-notes.md) (`resolvedAnchorIds`).
