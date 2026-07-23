# ADR 0012: 3-pane workspace + in-paper editing via a preview-only interactive template

Status: accepted  
Date: 2026-06-30

## Context

ADR 0011 made design fidelity a verifiable contract and recorded several places where the shipped UI
deliberately diverged from the vendored Claude design (`docs/design/Contender.dc.html`). Two of
those divergences were re-examined against the canonical design and **reversed by owner decision**:

1. The workspace detail shipped as a **2-column** layout (job/reviewers/editor stacked beside the
   preview), not the design's **3-pane** side-by-side — the stated reason was that three columns crush
   the 660px paper at 1120–1500px mid-widths.
2. **In-paper editing was not adopted** ("editor/preview stay separate"); editing happened in textareas
   in the left pane only.

The owner reviewed the canonical design directly and wants the faithful 3-pane workspace with in-paper
editing. (Context note: `origin/main` already shipped the collapsible rail + preview/header polish in
PR #44 — the levers the 3-pane width budget relies on.)

## Decision

1. **The workspace detail adopts the design's fixed full-bleed 3-pane** — left structured navigator |
   center preview paper | right review rail — bound to the viewport with three independently-scrolling
   panes and a 54px contextual top bar. Below a fit threshold it falls back to the existing
   Editor/Preview/Reviewers tab system (the collapse-aware breakpoint from PR #44). This is a **new
   decision that supplements ADR 0011** (the 3-pane layout was never an 0011 decision).
2. **In-paper editing is adopted**, implemented so invariant 3 is preserved: the **single editable
   surface is the CV paper** (per-line `contentEditable` on editable bullet lines only), via
   **optional, default-off interactive props** on the still-**pure** `ResumeTemplate`. The render /
   `/print` export path never passes them, so PDF/DOCX/ATS exports stay content-identical. The left
   pane becomes a **read-only functional navigator** (click → focus the paper line; live-reflect;
   re-run instant checks). This **supersedes the in-paper-editing divergence in ADR 0011 §2.**
3. **Affordances (per-line markers) render as a PreviewPanel-level measured overlay** (the existing
   page-break-layer pattern), never inside `src/render/` beyond the contenteditable wiring; the marker
   gutter lives **inside the paper's right padding** as an absolute overlay that does not shrink the
   text content box, so preview line-wrapping at full width still matches the PDF.

## Options considered

- **A: Faithful dual-`contenteditable`** (both the paper and the left pane editable, as the mockup
  literally shows). Rejected — caret reset on controlled re-render, double tab stops, and duplicate
  screen-reader edit fields.
- **B (chosen): Single editable paper + read-only navigator.** Faithful in look, robust in behavior;
  one source of truth (`drafts`), one editable surface.
- **C: Keep the 2-column / no-in-paper status quo.** Rejected — it is the design drift the owner
  flagged.

## Consequences

- Easier: the workspace matches the canonical design; one editable surface; the navigator gives
  direct line-to-paper navigation.
- Harder/constrained: editing now lives in (and around) the render-path component, so DevPR14 carries
  four load-bearing safety mechanisms (caret-safe overlay excluding the focused bullet;
  `autoFocusOnSettle` bailing on a focused contenteditable; a ref-based apply-race guard; `/print`
  proven by `next build` + Playwright, not jsdom). Full preview==PDF wrapping + page-break markers hold
  only from ≈1410px rail-collapsed / ≈1560px expanded; below that the paper reflows gracefully and the
  markers auto-hide (export unaffected). The reviewer-comment composer + its backend were removed
  outright with the single-user pivot (DevPR41) — the rail's Comments shell is gone.
  *(Superseded in part by DevPR19 — scroll model: the two point-in-time figures above and the
  "collapse-aware breakpoint" named under Decision describe the original rail-state-gated model. The
  three-pane reflow is now **width-only from 1120px**, rail state no longer gates it, and full
  preview==PDF wrapping returns at ≈1410px (a little higher with the rail expanded). Canonical:
  `docs/architecture/design-system.md` §Responsive & mobile.)*
- Invariant 3 is preserved (one pure template; interactive is preview-only; exports content-parity),
  as are invariants 2 (sign-off gate), 7 (stable anchors), and 8 (owner-only workspace).

**Rollout:** this is the accepted decision, implemented across DevPR12–17. `docs/features/workspace.md`
and `docs/architecture/design-system.md` §Responsive are updated **per slice as each lands** (docs with
code, AGENTS §12) — until a slice ships, they still describe the current 2-column / textarea behavior.

## Links

ADR 0011 (design system as a contract; superseded-in-part by this ADR), ADR 0003 (stable-id
anchoring), ADR 0010 (transient reviews), `docs/architecture/design-system.md`,
`docs/architecture/renderer.md`, `docs/features/workspace.md`, `docs/design/` (vendored
`Contender.dc.html` + `ReviewNote.dc.html`), and `docs/invariants.md` (2, 3, 7, 8).
