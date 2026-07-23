# ADR 0016: A drifted review stays visible — stale-marked, never hidden

Status: accepted  
Date: 2026-07-22

## Context

The two-level freshness gate (ADR 0013/0014 era) keyed the whole-CV review surface on a
VERSION-fresh review: `panelBundle` was null the moment a committed save bumped `cv.version`, so the
Gatekeeper verdict, the header pill, the roster counts, and the panel threads all **disappeared** on
any drift. But **every Apply also bumps `cv.version`** — so the act of accepting the panel's own
corrections hid the verdict and most of the rail. To the candidate this reads as data loss ("my
review vanished"), when the drifted findings are still real judgments of a near-identical CV.

Forces:

1. **Honesty cuts both ways (invariant 5).** Hiding a verdict that no longer matches the CV avoided
   showing something stale — but silently discarding visible state is its own dishonesty.
2. **Copy sprawl is the failure mode.** Five surfaces can go stale (header pill, rail card, roster,
   threads, Gatekeeper subview); five hand-written "out of date" strings would drift apart and spam
   "re-run" at assistive tech.
3. The per-bullet lifecycle (stale bullets lose Accept; `isAcceptableThread`) already handles
   actionability correctly and must not change.

## Decision

**A version-drifted same-cv review stays fully visible, stale-marked.** `panelBundle` is derived
from `reviewSameCv` (not `reviewVersionFresh`); `versionDrifted` becomes a marking input, not a
hiding gate.

- **One canonical, cause-neutral phrase** — `STALE_REVIEW_PHRASE = "CV changed since this review —
  re-run to refresh"` (`workspace/logic.ts`). Cause-neutral because a manual save and an Apply both
  bump the version; the phrase never blames either.
- **One carrier per region:**
  - **Header:** the `TopbarVerdict` cluster (extracted presentational component) shows a SHORT
    "Out of date" chip; the FULL phrase rides the button's extended aria-label (the 45-char phrase
    would wrap the topbar at 1120–1300px).
  - **Rail:** the `VerdictCard` carries the chip when a verdict exists (aria-label extended with the
    phrase — the chip is otherwise invisible to AT); ELSE the drift caption carries the phrase,
    built from the constant. Both the live-drift and the restored captions are **governed**: when
    the card chip shows they keep only "Your accepted bullet notes still apply." — and render
    NOTHING at zero accepts (never an empty `<p>`).
  - **Gatekeeper subview:** the full read renders under ONE visible banner (no separate chip; no
    `role="status"` — a status region doesn't announce content already present at mount, reading
    order covers it). `gateFailed` is gated `!versionDrifted` at the call site so a drifted run's
    old failure reads "drifted", not "failed" — the pure `gatekeeperEmptyReason` precedence is not
    reordered.
  - **Roster / ThreadList:** desaturation only (colour-mix on borders, fills, and dots — no text
    line). The roster keeps its REAL counts and its `none`/`interrupted` kinds (never a false "0").
- **Stale-marking AA rule:** desaturate CHROME only, never text ink. New chips follow the
  Applied-chip pattern (glyph/border coloured, label `--text-2` — never `var(--warn)` as text); new
  drift captions/banners are `--text-2`; existing `--text-3` roster/ThreadList status words are not
  repainted. `VerdictPill` gains an optional `stale` (dot/tint/border mix toward `--line`; the label
  stays `--text`).
- **Paraphrase-proof region tests** (`workspace/logic.test.tsx`): per-scenario asserts count the
  canonical phrase AND a derived `/re-run/i` total against an explicit allowlist (the trigger label,
  ThreadList per-agent error copy, `applyDisabledReason`, the dirty hint, the gatekeeper-unavailable
  fallback), so any new "re-run" paraphrase breaks a count.
- **Explicit fix-row states (same slice):** each Gatekeeper fix carries a `GatekeeperFixState`
  discriminant — the view never guesses a row's reason. `applied` derives from ADR 0014's
  `resolvedAnchorIds` — `resolved && anchorKind === "bullet"` (anchor ids collide across kinds;
  `resolvedAnchorIds` holds bullet ids only) → the Applied chip. `applicable` (the correctability
  predicate) → "Open in Workspace →". `blocked-dirty` — a FRESH review's editable-bullet fix blocked
  only by an unsaved draft (under a fresh review a saved-text drift is impossible: a save bumps
  `cv.version` → drifted) → the muted "Save your edits first" microcopy. `advisory` — permanently
  non-actionable: a non-bullet anchor OR a bullet outside the editable work/projects sections →
  the Advisory tag. `stale` — a drift-blocked bullet fix → NO tag, reachable ONLY when the review
  is version-drifted, so the stale banner is guaranteed co-present and explains it (before this
  split, the tagless fall-through also swallowed fresh draft-blocked and non-editable-section
  bullet fixes as dead unexplained rows). The "N applied" sub-copy carries a "— re-run Review to
  re-check" tail only when the stale banner is absent, and applied-row screen-reader text collapses
  to just "Applied" when the banner shows (one drift carrier per region; no per-row re-run spam).

**Accepted holes (documented, not bugs):**

1. **Below 1120px, a drifted review with NO verdict has no carrier on the Editor/Preview tabs** —
   the drift caption lives in the rail, i.e. the Reviewers tab, and the header chip needs a verdict.
   Accepted: the Reviewers tab is where the review lives below 1120, so it is the carrier; before
   this ADR the review was entirely hidden there, so nothing regressed.
2. **At phone width the header chip and the card chip can be co-visible.** Rule-legal: the rule is
   one carrier per REGION, and header vs rail are distinct regions (each phrase instance lives in an
   accessible name, so AT hears it per-control, not doubled in one region).

## Options considered

- **A: keep hiding on drift (status quo).** Honest about staleness, but every Apply "loses" the
  review — the complaint this ADR exists to fix.
- **B (chosen): visible + stale-marked, single carrier per region, one canonical phrase.** The
  drifted review stays useful (threads readable, decisions visible, Gatekeeper read intact); staleness
  is unmissable but not shouted five times.
- **C: persist verdict history and show the matching version.** Over-scope: needs a run-history
  store (rejected in ADR 0013) for marginal value over "re-run".

## Consequences

- Easier: Apply no longer appears to destroy the review; the recruiter read survives an edit;
  regions can't drift apart in copy (the constant + count tests).
- Harder/constrained: any NEW drifted-region copy must name its carrier and join the `/re-run/i`
  allowlist, or the region tests fail; `gateFailed` consumers must remember the call-site gate.
- Unchanged: per-bullet staleness/acceptability (PR-4), the freshness 409s, ADR 0014's
  resolve-in-place model, re-tailor starts fresh.

## Links

- `frontend/src/app/(app)/workspace/{logic.ts, page.tsx, TopbarVerdict.tsx, ReviewPanel.tsx,
  VerdictCard.tsx, ThreadList.tsx, GatekeeperView.tsx}`, `frontend/src/ui/VerdictPill.tsx`.
- Supersedes-in-part: [ADR 0014](0014-incremental-apply-keeps-surviving-notes.md) — its "the
  two-level freshness gate **hides** the now-stale whole-CV Gatekeeper verdict (version drift)"
  frontend clause: the drifted verdict is now shown stale-marked, never hidden. The resolve-in-place
  model, `resolved_anchor_ids`, and the resurrection guard stand (and feed the Applied fix state).
- Builds on [ADR 0013](0013-persisted-review-runs.md) (persisted runs — the restored-stale caption)
  and [ADR 0011](0011-design-system-and-transient-views.md)/[ADR 0012](0012-workspace-3pane-and-in-paper-editing.md)
  (the regions being marked).
