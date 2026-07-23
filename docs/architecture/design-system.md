# Design system — the fidelity contract

Status: active. The canonical visual source is vendored in [`../design/`](../design/)
(`Contender.dc.html` + `ReviewNote.dc.html`); this doc is the **spec** every screen is built and
verified against. Tokens already live in `frontend/src/app/globals.css`; this doc names what they mean,
how they compose, and the **rules that make fidelity verifiable** (a machine guard + a per-screen
rubric) rather than eyeballed.

> **The load-bearing rule:** components consume **design tokens only** — no ad-hoc colour literals in
> `.ts`/`.tsx` under `src/app` / `src/ui` / `src/lib` / `src/slop`. The CV "paper" is the one
> deliberate exception (it uses concrete hex in `frontend/src/render/template-tokens.ts`; see
> §Two-token boundary). Both halves are enforced by the machine guard
> (`scripts/check-invariants.mjs`).

## Colour tokens (chrome)

Dark is the default (`:root`); light derives from the same names via `[data-theme="light"]`. Source of
truth: `globals.css`. Never hard-code these values — reference `var(--…)`.

| Token | Role | dark | light |
|---|---|---|---|
| `--bg` | app background | `#0d1014` | `#e8ebef` |
| `--panel` / `--panel-2` / `--raised` | surfaces (rail/cards / insets / elevated) | `#151a21` / `#1b212a` / `#222a35` | `#ffffff` / `#f4f6f9` / `#ffffff` |
| `--line` / `--line-strong` | borders (hairline / emphasised) | `#262e39` / `#39434f` | `#dde2e9` / `#c2cad4` |
| `--text` / `--text-2` / `--text-3` | text (primary / secondary / muted) | `#e7ecf3` / `#9aa6b4` / `#646f7c` | `#141a22` / `#4d5765` / `#828c98` |
| `--accent` / `--accent-2` / `--on-accent` | primary action / hover / text-on-accent | `#5b9dff` / `#3f7fe0` / `#0a0d11` | `#2f6df0` / `#205bd6` / `#ffffff` |
| `--ok` / `--warn` / `--bad` | semantic (pass / borderline / reject; success / caution / error) | `oklch(.78 .14 152)` / `oklch(.82 .13 80)` / `oklch(.68 .19 26)` | darker variants |
| `--ink-warn` | warn-toned **essential text** ink — AA ≥4.5:1 on `--bg`/`--panel`/`--panel-2` in both themes (raw light `--warn` fails as text at 3.11–3.71) | alias of `--warn` | `oklch(.52 .11 75)` ≈ `#8d5e00` |
| `--switch-knob` / `--switch-track-off` / `--switch-knob-ring` | toggle-switch knob (fixed light disc, shared `:root`) / OFF track / opaque knob outline — the WCAG 1.4.11 set (§Computed contrast) | `#ffffff` / `#616c79` / `#14161a` | `#ffffff` / `#6f7a87` / `#10151c` |
| `--rv-parser…--rv-gate` | per-agent identity colours (see §Agent identity) | per `globals.css` | per `globals.css` |

## Computed contrast (asserted by `frontend/src/ui/contrast.test.ts`)

The suite parses `globals.css` (merging the `:root`/theme blocks in cascade order, one level of
`var()` indirection, `#rrggbb` + `oklch(L C H)` via the OKLab matrices → 8-bit sRGB) and asserts
the ratios below, so a token retune that breaks AA fails the gate by token name. It is calibrated
against known sRGB references (white/black 21:1, `#767676`-on-white 4.54, `#777777`-on-white 4.48
just-fails), never against its own pipeline's output. It does **not** composite alpha — the switch
ring must stay an opaque token, never a shadow. Computed figures (dark / light):

| pair | floor | dark | light |
|---|---|---|---|
| `--text` on `--bg` / `--panel` / `--panel-2` | 4.5 | 16.06 / 14.72 / 13.63 | 14.63 / 17.49 / 16.16 |
| `--text-2` on `--bg` / `--panel` / `--panel-2` | 4.5 | 7.71 / 7.06 / 6.54 | 6.13 / 7.33 / 6.77 |
| `--ink-warn` on `--bg` / `--panel` / `--panel-2` | 4.5 | 10.78 / 9.88 / 9.15 | 4.70 / 5.62 / 5.20 |
| (why `--ink-warn` exists) raw `--warn` as text on the same three | 4.5 | passes (aliased) | **3.11 / 3.71 / 3.43 — fails** |
| `--on-accent` on `--accent` | 4.5 | 7.15 | 4.60 |
| `--ok` on `--panel` | 4.5 | 9.24 | **4.51 — knife-edge** |
| `--ok` as the ✓ **glyph** on `--panel-2` | 3.0 | 8.55 | **4.17 — fails the 4.5 text floor: ok-state labels on `--panel-2` hosts (bulletBox / fixRow) are `--text-2`, colour on the glyph only** |
| badge glyph ink on each of the 7 identities (6 `--rv-*` + `agent` on `--accent`) | 4.5 | 6.65–11.13 | 4.60–5.86 |
| Switch: every checked track (accent, warn, 6 agents) vs the `--panel` host | 3.0 | 6.42–10.74 | 3.71–5.86 |
| Switch: `--switch-track-off` vs `--panel` / vs knob | 3.0 | 3.27 / 5.34 | 4.37 / 4.37 |
| Switch: knob **body or opaque ring** vs every checked track | 3.0 | 6.65–11.26 (ring carries; body 1.63–2.72) | 3.71–5.86 (body carries; ring ≥3.13) |
| (rubric §6) dark `--switch-track-off` vs `--raised` | 3.0 | **2.71 — below floor: never host a Switch on `--raised` in dark** | n/a |

## Typography roles (`frontend/src/lib/fonts.ts`, bound via the CSS vars)

- **`--ui`** = Archivo — all interface text (nav, buttons, headings, body). Weights 400/500/600/700.
- **`--mono`** = IBM Plex Mono — metadata, eyebrow labels (uppercase, ~9–11px, letter-spacing .05em),
  scores, glyphs, code-ish chips. Weights 400/500/600.
- **`--serif`** = Source Serif 4 — restricted to four sites: **the CV document** (the "paper"), the
  Gatekeeper "20-second read" impression blockquote, the **review-note "SUGGESTED" rewrite block**
  (`workspace/ThreadCard.tsx`, per `docs/design/ReviewNote.dc.html` — the suggested replacement reads in
  the document voice), and the **Diff sub-view BEFORE/AFTER** (`workspace/DiffView.tsx` — changed CV
  text in the document voice). Never use serif for app chrome other than these four.

Common UI sizes (from the mockup): page/section title 14–15px/600; card title 13–13.5px/600; body
12.5–13px; secondary 11.5–12px/`--text-2`; eyebrow / caption metadata mono 9.5–10px
uppercase/`--text-3`. **A control's *sole* field label (e.g. "API key", "Strictness") is essential
text, not eyebrow metadata → `--text-2` for AA (rubric §6 wins over the muted eyebrow tone).**

## Elevation & shadow ladder

Capture these as utilities (not ad-hoc); shadow `rgba(0,0,0,…)` is allowlisted by the guard.

- card / raised: `0 3px 9px -2px rgba(0,0,0,.3)`, hairline `0 1px 3px rgba(0,0,0,.4)`
- card-lift (hover): `0 16px 40px -26px rgba(0,0,0,.7)` + `translateY(-2px)`
- note card: `0 12px 30px -16px rgba(0,0,0,.45)`
- drawer (slide-in): `-24px 0 60px -30px rgba(0,0,0,.7)`
- modal: `0 40px 100px -30px rgba(0,0,0,.7)` / `0 30px 80px -30px rgba(0,0,0,.6)`

## Motion

Keyframes (define once in `globals.css`): `fadeUp` (modals/cards/notes), `slideInRight` (drawers),
`spin` (loaders), `flashfix` (correction flash — lives in the preview **wrapper**, never the paper),
`pulseDot` (the live-run dot), `toastIn` (toasts). Transitions: nav width ~.18s; colour/bg ~.15s;
transform ~.1s. **All gated by the existing `prefers-reduced-motion` reset** in `globals.css`.

React inline styles can't express `:hover`/transitions, so recurring interactive patterns
(nav-item, card-lift, ghost-button, agent-chip, drawer reveal) are **tokenized utility classes** in
`globals.css` — components add the class rather than re-implementing hover inline.

## Agent identity — the single source (`frontend/src/ui/colors.ts`)

The mockup's canonical `REV` map (verbatim). `colors.ts` is the **sole** definition of agent
identity (name/glyph/colour); the divergent copies in `(app)/page.tsx`, `workspace/ThreadCard.tsx`,
`ReviewInlineBadge.tsx`, `AgentChecklist.tsx`, and `VerdictCard.tsx` were deleted and re-pointed at
it. `workspace/logic.ts` keeps a **separate status-label map** (`REVIEW_AGENT_LABELS` /
`reviewAgentLabel` — owner-facing status-line phrasing like "Line edits", "Voice review"); it is
deliberately not an identity source and doesn't duplicate `colors.ts`.

| key | name | glyph | colour | role |
|---|---|---|---|---|
| `parser` | Parser | `Pr` | `--rv-parser` | Reads the posting |
| `tailor` | Tailor | `Ta` | `--rv-tailor` | Rewrites to match |
| `editor` | Editor | `Ed` | `--rv-editor` | Clarity & concision |
| `fact` | Fact-Checker | `Fc` | `--rv-fact` | Flags overstatement |
| `spotter` | AI-Language Spotter | `Sp` | `--rv-spotter` | Flags generic phrasing |
| `gate` | Gatekeeper | `Gk` | `--rv-gate` | Recruiter / ATS verdict |
| `agent` | Agent | `Ag` | `--accent` | Review agent |

(Divergence: the mockup's `human` / "Reviewer" `@` identity was retired with the single-user pivot —
the seventh slot is now the neutral `agent` fallback for an unrecognized key.)

Badge foreground is a **theme-aware token chain** `var(--ink-<agent>, var(--agent-ink))` so the glyph
stays **WCAG-AA on every agent colour in both themes** (verified by computed contrast — all ≥4.5:1):
dark theme uses dark ink everywhere (`--agent-ink:#14161a`); light theme uses light ink by default
(`--agent-ink:#ffffff`) with one per-agent override (`--ink-fact:#14161a`, the bright gold badge), and
the light `--rv-tailor` lightness is nudged 0.56→0.54 so its white ink clears AA. A deliberate
divergence from the mockup's fixed dark ink. **Key-space reconciliation:**
the backend review-source space uses `editor` / `factCheck` / `spotter` / `gatekeeper`; `colors.ts`
maps `factCheck→fact` and `gatekeeper→gate` so both the agent-id and review-source keys resolve to one
entry. Verdict decisions: `PASS→--ok`, `BORDERLINE→--warn`, `REJECT→--bad`.

## Two-token boundary (invariant 3)

Two token systems that **must never be unified**:
- **App chrome** — the CSS variables above, themeable, in `globals.css`.
- **CV paper** — concrete hex in `frontend/src/render/template-tokens.ts` (`--paper`/`--ink*`/`--rule`
  + the serif), because DOCX/text exports can't read CSS variables and the PDF must be deterministic.
  `template-tokens.ts` legitimately uses `var(--font-*)` (bundled fonts) — that is allowed; chrome
  colour `var(--…)` there is forbidden.

**`--ink-*` naming note (paper vs chrome):** the bare `--ink`/`--ink-2`/`--ink-3` are the CV
**paper's** text colours (the render-path system above). Chrome's per-element ink tokens are the
*namespaced* `--ink-<x>` family — `--agent-ink`, `--ink-fact` (badge glyph inks) and `--ink-warn`
(warn-toned text) — themeable chrome, never used on the paper. Same prefix, two systems; don't
cross-reference them.

The machine guard encodes both: (a) reject colour **literals** (`#rgb`/`#rrggbb`, `rgb(`/`rgba(`/
`hsl(`/`oklch(`) in **`.ts`/`.tsx` files** (component code — inline styles, style objects, class
definitions) under `src/app`, `src/ui`, `src/lib`, and `src/slop`, with the **exact `/print` route
excluded** (it is deterministic render surface, covered by the invariant-3 guard instead) — checked
**per literal**, so an allowed value can't shield an offending one on the same line — allowlisting
shadow `rgba(0,0,0,…)` everywhere, plus the Microsoft brand-logo squares
(`#f25022`/`#7fba00`/`#00a4ef`/`#ffb900`) **only in `sign-in/MicrosoftLogo.tsx`**, a fixed brand asset;
(b) in `template-tokens.ts` forbid chrome colour `var(--…)` while allowing `var(--font-*)`.
`globals.css` is **not scanned**: it is the sanctioned home of the token definitions and the
tokenized utility classes' literal values (scanning its non-token blocks is a deferred idea, not a
shipped rule) — so a literal in a utility class is caught by review, not the machine.

## Responsive & mobile

Breakpoints (reconciled to the design, replacing the old 860/1140 rail rules): **bottom-nav `<720px`**
(sidebar hidden, fixed bottom tab bar; a `--bottom-nav-h` + safe-area var reserves space above it —
post-C4 (import-as-modal) the ingest Apply bar is the import modal's **sticky footer inside the native
`<dialog>` top-layer**, which clears the bottom nav directly). **Workspace detail (DevPR13, ADR 0012; scroll model DevPR19):** the viewport-bound **three-pane**
(editor | preview | review) shows from **1120px on width alone** — rail state no longer gates the
reflow. Below 1120 the panes stack and an Editor/Preview/Reviewers **tab bar** gates one pane at a
time. **One scroller per state:** in the three-pane layout the page is pinned to the viewport and each
pane owns its own scroll; below 1120 the body is the single scroller. Soft pane minimums let the side
panes shrink so the center preview holds **≥340px**. In the three-pane range the center preview is
usually narrower than the 660px paper, so the paper reflows narrower than the PDF and the page-break
markers auto-hide (export unaffected); full preview==PDF wrapping returns once the viewport is wide
enough for the preview pane to reach 660px (roughly **≥1410**, a little higher with the rail expanded —
the rail still eats real width even though it no longer gates the reflow). New screens need explicit 375px
layouts: **Gatekeeper** stacks the gauge above the headline and collapses fixes to one column;
**Diff** stacks the before/after panes.

## Empty / loading / error / needs-sign-off / degraded states

The mockup is happy-path; these are derived from the banner/toast token patterns and live here as the
reference (don't improvise — surfacing agent failure loudly is invariant 5): spinner from the
import/analyze modal; empty pattern from the Diff empty block; **degraded-agent** and **export-blocked
(needs sign-off)** use the `--warn`/`--bad` banner. Gatekeeper with no live verdict and Diff with no
applied correction render their designed empty states.

## Design ↔ backend divergences (named — don't invent UI)

The mockup outruns the shipped backend in places; each is resolved as a named divergence (full
rationale in the plan / ADR 0011):

- **Sign-in** — the mockup's "Demo access · Operator / Reviewer" quick-role buttons are replaced by the
  real **passwordless magic-link form** (M365 SSO is the primary CTA; the demo quick-roles don't exist in
  the shipped auth — there are no roles at all post-pivot; every allowlisted account is an owner). **AA divergence (rubric §6 wins):** the footer "Secured by Microsoft 365" caption is
  `--text-2`, not the mockup's `--text-3` (which is only ~3.4:1 on `--panel`, below AA).
- **Gatekeeper** has one `recruiterNotes` (no headline/sub/impression split, no per-fix delta, no
  per-must-have note): render `recruiterNotes` in the serif **impression** slot; drop the other slots
  and the deltas (the "fixes" card reads thinner than the mockup). The dropped headline slot becomes a
  factual `<h1>` (the `JobSpec` title) for the heading outline, not invented copy. Present/met derive
  from `JobSpec` minus missing/unmet with normalized matching; the "fixes" are the verdict's anchored
  threads, each row carrying an **explicit state** (`GatekeeperFixState` — no dead unexplained rows):
  the **review panel's correctability predicate** decides "Open in Workspace" (an editable bullet).
  **Applied fix state (ADR 0016, riding ADR 0014):** a fix on an applied
  bullet (`resolvedAnchorIds` — bullet-anchored only; a cross-kind anchorId collision must not read
  applied) renders the mockup's done-state **✓ Applied chip** + `--ok` row tint/edge, with an **AA
  divergence**: the ✓ glyph carries `--ok` and the label stays `--text-2` (the mockup inks the whole
  chip `--ok`, which dips below AA in light theme). Row states: Applied chip → "Open in Workspace"
  → **blocked-dirty** (a fresh review's fix blocked only by an unsaved draft — the muted "Save your
  edits first" microcopy in the rail dirty-hint form, mono `--text-2`, no button) → **Advisory
  (non-bullet anchors, or bullets outside the editable work/projects sections)** → a **stale**
  (drift-blocked) fix gets **no tag** — reachable only under the stale banner, which explains it. The
  "N applied" sub-copy's "— re-run Review to re-check" tail and the applied-row srOnly re-run text
  **collapse when the stale banner shows** (one drift carrier per region — no per-row re-run spam).
  **AA divergences (rubric §6 wins):** present/missing keyword chip text
  stays `--text-2` (colour on the chip border/fill, not the mockup's colour-mixed text); the must-have
  ✓/✕ **mark ink** is the theme-aware `var(--agent-ink)` (computed AA on `--ok`/`--bad` in both themes —
  light `--ok` is a thin 4.51:1, so any future lightening of `--ok` must be re-checked); the Present /
  Missing sub-labels and the "Advisory" tag are `--text-2`, not eyebrow `--text-3`.
- **`gkList`** (multi-application gauge grid) and any **persisted cross-application verdict/diff snapshot
  history** are non-goals (only the *latest* run persists — a latest-only snapshot per ADR 0013; no run
  history). The Diff is **derived** from that persisted review baseline (ADR 0015), so it is cumulative
  and survives navigation/reload — no separate snapshot store. The Gatekeeper is a same-session per-CV
  subview. The Gatekeeper nav entry preserves the
  active `?cv=` so entering from a loaded CV keeps its verdict; a `?cv=` **reload now rehydrates the
  persisted review (ADR 0013)** so the verdict is restored, while the global entry (no `?cv=`) lands on
  the designed empty state.
- **Posting drawer** renders the text source from `JobSpec.raw_text`; the PDF iframe / file-download
  is dropped (no stored posting file). The new-application modal is **paste-text only** (the Parser
  takes text; the candidate-CV PDF ingest path must not be reused for postings).
- **Tracker (C1)** — collapsible rows + the stage pipeline as clickable `StageDots` + an expanded
  per-row record. Named divergences (the mockup outruns the `Application` contract = title/company/
  url/stage/events/recruiter; `ApplicationSummary` = id/title/company/stage/appliedAt/cvId):
  - **Recruiter** contact is **editable + persisted** (owner-only `PATCH …/recruiter`), but via
    **structured `<input>`s + an explicit, validated Save** (the §Master C2 convention) — NOT the
    mockup's `contenteditable`-on-blur, which the review found drops/hostages edits. Email is
    **validated before save** (inline error blocks it); the two inputs **stack vertically** with
    ≥44px targets and the card uses `align-items:flex-start` so it doesn't stretch its Posting/CV-sent
    siblings. Recruiter is on `Application` only (never the summary). A rare same-row Save/stage-move
    overlap is last-write-wins (invariant 7).
  - The mockup's standalone **Notes** card is **dropped** (no notes contract independent of a stage
    change; a note rides a `StageEvent`). The expanded **stage timeline** (`events`) shows per-stage
    notes; inline move is one-click and note-less (the note-capturing stage form stays on the
    `/applications/[id]` detail page).
  - The collapsed-row dots derive from the **current stage only** (the list summary has no timeline),
    so a **terminal** row shows an all-pending pipeline + a terminal badge — no reconstructed
    pre-terminal high-water mark. The mockup's **0.66 terminal-row dimming is dropped** (it sinks the
    secondary role text below AA — rubric §6 wins); the terminal badge carries the closed state.
  - The **active move-button** uses a tinted fill + `--text` label (not the mockup's solid fill with
    `--on-accent`), which would drop the `ok`/`muted` tones below AA. Pending **stage-dot labels** are
    `--text-2` (essential text), never the mockup's muted ink. The **CV name/stage badge** and the
    raw posting URL text are dropped (no field in the summary); the posting renders a guarded
    (`isSafeHttpUrl`) "View job posting" link, the CV an "Open the CV used →" link to the detail page.
- **Master editor (C2)** — reskinned to the `isMaster` block (banner + profile-preview header +
  eyebrow'd cards). The mockup edits **inline (contenteditable, "saves as you type")**; we adopt its
  **visuals** (chips, read-stack, the side-by-side row) but keep **structured inputs + an explicit,
  VALIDATED Save** and the richer schema (location parts, website, profiles, skill level/keywords) —
  the master PUT is a full replace requiring name+email, so autosave-on-keystroke would PUT
  partial/invalid data. The collapsed editors are **click-to-edit**: exactly one inline editor open at
  a time (page-level state — opening entry B commits-and-closes A), and a Save-validation error
  **auto-opens + focuses the first offending entry's field**, derived client-side from the same
  predicate `toMaster` applies (never by parsing its error strings). The candidate **name is the page
  `<h1>`** (styled as the 24px display name); section labels are `<h2>`s styled as the mockup's mono
  eyebrows. The banner **"Add source" is a solid `--accent` CTA** (not the section buttons' outlined
  accent-text, which would fail AA on the banner tint); it stacks full-width below the copy at phone
  width; the banner's tailored-count/updated meta is dropped (no cheap source).
  - **Skills + Languages are flat chip clouds** (chip label `name · level` / `language · fluency`),
    each with an "Add a …" input (Enter or button; **case-insensitive + trimmed dedupe** with an
    "already added" `role="status"` note) and an inline chip editor. A chip is **two SIBLING buttons**
    in a styled span — the body toggles the editor, the × removes — **never nested interactives**.
    **Languages is a named extension** (a shipped feature the mockup lacks): it renders **full-width
    below** the Skills/Education row and mirrors Skills exactly.
  - **Skills (`flex:2`) sits beside Education (`flex:1`)** in a wrap-on-phone row (`align-items:
    flex-start`, so an open editor doesn't stretch the sibling card with dead space). **Education is
    the design's read-stack** — degree (`studyType area`, the same join the renderer uses) /
    institution / dates — rendered as **≥44px `<button>` rows that expand in place** to the structured
    fields + a **44×44 Remove**; same click-to-edit / Save-error auto-open pattern as the chips.
  - **AA divergences (rubric §6 wins over the mockup):** the chip pill is **32px** tall (mockup 26) and
    the × box is **28px wide** (<44 — the editor's 44×44 Remove is the escape hatch); the chip body and
    × each carry a **−6px vertical `::after`** so a **12px cloud gap yields a 44px row pitch** with no
    overlap (11px would overlap adjacent targets by 1px). The add-input/button sit at form height (the
    structured-inputs convention), not the 44px chip target.
- **Admin editor (C3)** — reskinned to the `isAdminScreen` block (header + Reviewer-powers grid +
  Agent-configuration card). Two named divergences:
  - **Reviewer powers is skin-only** (invariant 2). The mockup's per-agent active / strictness /
    blocking controls have no backend — only the candidate's sign-off blocks export, and there is no
    per-agent strictness/blocking store. So the grid is **local preview state wired to no endpoint**,
    carrying a `--warn` "Preview · not enforced" pill, a bold "**Not saved or enforced yet**" caveat
    ("these controls reset on reload…" — DevPR7 made the non-persistence explicit, since the grid keeps
    no state across a refresh), and a `role="group"` aria-label so AT users hear the caveat — it cannot
    mislead into thinking it changes agent behaviour or is remembered. Reuses the `Switch` / `Segmented` / `AgentBadge` primitives + `colors.ts` identity.
  - **The single provider/model/temperature/baseUrl form is replaced by the real per-provider/per-tier
    admin** (write-only key + sync-models + tier→model, ADR 0006). Keys are **encrypted at rest
    server-side and never returned**, so there is no "reveal" and no "kept on this device"; temperature
    / baseUrl are dropped (not in the agent contract). The mockup's "set via the ADMIN_EMAIL env var"
    line is corrected to our reality — **every `ALLOWLIST_EMAILS` entry is an owner**
    (`auth/allowlist.py`).
  - **AA divergences (rubric §6 wins):** the "Owner only" badge ink is `--text-2` (the mockup's
    `--accent` ink is 3.85:1 on `--bg` in light); the field/control labels ("API key", "Models",
    "Strictness"), the On/Off state value, and the restricted-to line use `--text-2`, not the eyebrow
    `--text-3`; the `Switch`/`Segmented` controls use a **≥44px** hit target (AGENTS §7) vs the
    mockup's 23/26px (the `Switch` keeps its 40×23 visual centred in a transparent 44px target). The
    `.cos-rvgrid` two-column breakpoint is the **1120px** shell breakpoint (the 214px rail would crush
    the strictness Segmented at the mockup's narrower split).
- **App-shell left rail (S6/DevPR24)** — the hover-to-expand + **pin-to-lock** model: a **64px** icon
  strip (`--rail-w-collapsed`) flies out to **214px** (`--rail-w-expanded`) over the content on
  hover/`:focus-within` (no reflow — the rail is `position:fixed`, `.app-main` keeps the narrow offset),
  and a **pushpin in the brand row** locks it open (replacing the old bottom Collapse/Expand button;
  `data-rail` values, localStorage key, and the pre-paint script are unchanged — pinned ≡ `expanded`,
  unpinned ≡ `collapsed`). Named divergences: the **pin stays visible in the collapsed strip** (the
  mockup hides it until expanded) — desktop-width **touch** users (iPad) would otherwise lose the only
  expand control, since hover/`:focus-within` don't fire on tap; the pin is a **26px visual inside a
  44×44 transparent `::after` target** (rubric §6, the same target pattern as the admin `Switch`); the
  rail **defaults pinned-open** (the mockup defaults unpinned — owner choice). The collapsed brand
  stacks **logo-over-pin at a reserved 64px** height (kept in the flyout too, brand wordmark pinned
  out of flow) so entering the strip never shifts the nav rows — and, unlike the nav-row labels, the
  **brand wordmark stays clipped even in the flyout**: un-clipping it would re-flow "Contender" into
  the reserved column and grow it past 64px, re-introducing the vertical nav jump the reserve prevents
  (the logo + always-visible pin are the brand's flyout affordance; see `globals.css`). The **AI-readiness pill** ("AI ready" /
  "Set up AI", owner-only → Admin) is a shipped extension not in the mockup rail.
- **In-paper editing** — *reversed by [ADR 0012](../adr/0012-workspace-3pane-and-in-paper-editing.md)*:
  the workspace adopts in-paper editing, with the **CV paper as the single editable surface** via a
  **preview-only** interactive mode on the still-pure `ResumeTemplate` (optional, default-off props;
  the `/print`/export path never passes them, so exports stay content-identical — invariant 3). Its
  preview-only focus affordance may use chrome `var(--accent)` inside `ResumeTemplate.tsx` (never in
  `template-tokens.ts`); the **colour-literal** guard does not scan `src/render/`, so no allowlist
  change is needed (the deterministic-render guard still scans `src/render/` — keep clocks/RNG out). The correction `flashfix` **remains** an overlay in the preview wrapper, never on the
  `ResumeTemplate` (still true; see §Motion `flashfix`).
- **Diff sub-view (B4)** is **app chrome**, not the render path — so its serif BEFORE/AFTER renders on
  **chrome tokens**, NOT the paper hex (`#f7e0dd`/`#dff0e4`/`var(--paper)`) the mockup's diff bands use
  (invariant 3: only `src/render/` carries paper hex). Word marks are semantic `<del>`/`<ins>` with the
  semantic colour on a **tint + strikethrough**, the text held at `--text`/`--text-2` so removed/added
  words clear AA in both themes (rubric §6 — a divergence from the mockup's bright diff-text). The
  Diff before/after is the **4th sanctioned serif site** (the CV document voice). The per-fix delta /
  recruiter-email chrome is dropped, and cards are **neutral** (no per-line agent attribution). It is
  **derived** from the persisted review baseline (ADR 0015) — no separate CV-snapshot store — so it is
  cumulative and survives a reload/navigation.
- **Workspace list (`wsList`)** — the cards drop the mockup's stage badge, step-progress bar, posting-URL
  line, and decision+score chip: `CvSummary` carries id/version/company/jobTitle/needsSignoff/summary/
  createdAt/updatedAt only — stage/link/steps/verdict belong to `Application`/`ApplicationSummary` (the Tracker's
  contract), a pre-application CV has none, and the list deliberately does not join/display each CV's
  latest persisted review verdict (ADR 0013 persists the run per-CV; surfacing it on the list cards is a
  possible future slice, not a current gap). The header uses
  the app's page-title `<h1>` convention (23px) rather than the mockup's compact inline title + `{{appCount}}`
  chip; the count chip is dropped. (`WorkspaceList.tsx` cites this bullet.)
- **Workspace 3-pane rail + left navigator (DevPR15/16)** — both side panes are rebuilt to the design.
  **Rail (DevPR15):** the right pane (roster → Gatekeeper card → threads → Apply). Named
  divergences:
  - **Roster is settled-only + suppressed during the live stream** (the `AgentChecklist` is the live
    per-agent surface; the mockup shows the roster unconditionally). A roster count **slot is omitted
    unless there is a signal** and is gated on review PRESENCE (same-cv), so a pre-review roster
    never reads a false "0" — a **version-drifted** roster keeps its real counts/statuses (the
    `agentRosterStatus` none/interrupted kinds preserved) and **dims via the border/fill colour-mixes
    only** (ADR 0016); a failed/interrupted agent reads as **"couldn't run" / "didn't finish"**
    text (shared with `ThreadList` via `AGENT_STATUS_TEXT` so they can't drift). Parser/Tailor are
    create-time and carry **no count**.
  - **Stale marking desaturates chrome, never text (ADR 0016 — rubric §6 wins):** a version-drifted
    review's surfaces mark stale by colour-mixing **borders/fills/dots toward a neutral** (`--line` /
    `--panel`) while every text ink is untouched — the new "Out of date" chips follow the
    Applied-chip ink pattern (colour on the dot/border/tint, label `--text-2`, **never `var(--warn)`
    as text**), the new drift captions/banners are `--text-2`, and the existing `--text-3`
    roster/ThreadList status words are **not repainted**. One carrier per region owns the canonical
    `STALE_REVIEW_PHRASE`; chips carry it in their accessible name (`TopbarVerdict` / `VerdictCard`),
    and `VerdictPill` desaturates its dot/tint/border only (label stays `--text`).
  - **Section order follows the design minus its Comments block** (roster → Gatekeeper) with the
    functional `ThreadList` + **Apply corrections** (which the static mockup lacks) **appended after
    the Gatekeeper card**; Apply is a **sticky footer scoped to the 3-pane widths only** (in-flow at
    stacked/iPhone widths so it never overlaps the fixed bottom nav). The mockup's **Comments**
    section (the human-reviewer comment shell) is **retired outright** with the single-user pivot —
    the AI panel is the only reviewer, so the rail carries no comments surface.
  - **AA divergences (rubric §6 wins):** roster **rows are padded to ≥44px** (mockup ≈38px) and the
    **Gatekeeper card** is a ≥44px hit target; the roster **count number is `--text-2`** (status words
    `--text-3`, matching `ThreadList`), colour on the **22×22 glyph badge** only (`agentIdentity` ink,
    never a re-declared literal). The Gatekeeper card reuses the AA-safe **`VerdictPill`** for the
    decision (label on `--text`) + a separate **"ATS {score}/100" caption** — so the card gains the pill
    chrome the mockup's bare coloured decision lacks but keeps the score's "ATS" label. The run-level
    review error stays an in-rail warn-toned note — inked **`--ink-warn`**, the AA warn-text ink
    (raw `--warn` fails as text in light; see §Computed contrast) — it also reads a user Stop
    benignly, and is never a red banner.
  - **Left navigator (DevPR16):** `EditorPanel` becomes a **read-only structured navigator** — a
    read-only **Summary card** (summary editing is deferred, so it carries no edit affordance / hover cue;
    grounded in the summary-editing-deferral decision, not GatekeeperView's `recruiterNotes` divergence)
    + bullet rows that are real `<button>`s. The mockup's bullets are `contenteditable`; ours **navigate**
    (jump to + focus the matching paper line) — the paper is the single editable surface (ADR 0012). AA:
    nav buttons are **≥44px** with a persistent trailing **"→"** affordance (`--text-2` — the touch cue,
    since `:hover`/`cursor` don't fire on touch) + a visually-hidden "jump to this line on the CV" suffix.
  - **In-margin markers + in-place ReviewNote (DevPR17):** a `PreviewPanel` **measured overlay** (the
    page-break-layer pattern — zero `src/render/` touch; `/print` mounts `ResumeTemplate` directly, so it
    never sees them) places one marker per reviewed bullet in the paper's 52px right gutter, positioned by
    `getBoundingClientRect` deltas (not `offsetTop` — each bullet's `offsetParent` is its `data-line`
    wrapper). Named divergences: markers show on **experience bullets only** (`data-bullet-id` isn't on
    the summary — summary notes stay panel-routed to the rail; not a gap) and **auto-hide when the paper
    reflows <660** (mobile / narrow acts on notes via the navigator `ReviewInlineBadge` — AGENTS §7); **one
    marker per bullet + a count**, not the mockup's per-thread stack; the **page-break chip yields** to a
    marker (decorative vs interactive). AA: the 24px glyph is wrapped in a **≥44px** target with a roving-
    tabindex group, and carries a **resting drop-shadow + hairline ring** so the silhouette reads on the
    always-cream paper for light agent colours (`--rv-gate`/`--rv-fact`) in dark theme. The **ReviewNote**
    reuses `ThreadCard`'s content in **chrome tokens** (the chrome-on-cream precedent is `pageBreakLabel`,
    not DiffView) and **floats below the bullet** (vs the mockup's inline push — keeps the reviewed line
    visible); it's a labelled `role="dialog"` (Escape/outside-click close; focus returns to the marker on
    Escape/Dismiss) with the design's `showWorking` spinner. Actions reuse the shipped wiring (Accept & fix
    → single-thread `applyFeedback`, gated on `dirty===0 && !busy` like the top bar; **"Sign off to
    export"** — relabelled from the mockup's "Sign off — it's true" for our net-new-approval semantics,
    only when `needsSignoff`; View diff → `?view=diff`; Dismiss). "Remove line" is deferred (no delete API).
  - **Top-bar back control reads "‹ Workspace", not the mockup's "‹ Applications".** The mockup's back
    label names its *combined* list of drafts + applications; ours splits them — the **Tracker** owns the
    "Applications" name, and the derived-lock model (ADR 0009) guarantees the CV open in the editor is
    **never** applied (an applied CV is locked and redirects to the tracker). So the button returns to
    the **workspace** list (`router.push("/workspace")`); labelling it "Applications" would misname the
    destination. The `title` reads "Back to your workspace" to match.

## Per-screen fidelity rubric (the acceptance gate)

Every screen PR records, per **theme × {desktop, iPhone}**, a checklist verdict against its
`docs/design/` reference (capture a Playwright screenshot side-by-side):

1. **Machine guard green** (no stray colour literals; no chrome `var(--` in `template-tokens.ts`).
2. **Typography** — every text element maps to a role here (family + size + weight).
3. **Spacing/radii** — drawn from the scale (no arbitrary px).
4. **Colour** — every value resolves to a named token.
5. **Layout** — column order, hero composition, control placement match the reference at both widths.
6. **Contrast** — **essential text** (labels, values, decision/stage names, body copy) meets WCAG-AA
   (≥4.5:1) in **both** themes, via `--text`/`--text-2` or a verified per-element ink token (e.g. the
   badge `--ink-*`). **Never colour essential text with a bright semantic / `--rv-*` token** — put the
   colour on the dot/border/fill and keep the text readable. `--text-3` is the design's muted token for
   **secondary / eyebrow metadata** (units, captions, section eyebrows) only.
   **Warn-toned text uses `--ink-warn`, never raw `--warn`** (light `--warn` fails as text at
   3.11–3.71:1): the raw token stays for borders / fills / dots / gauge strokes, and chip chrome
   (`tagStyle`/`kwChip`/`VerdictPill`) never takes `--ink-warn` — its labels are already
   `--text`/`--text-2`.
   **The `Switch` is contrast-verified on a `--panel` host only** (`src/ui/contrast.test.ts` asserts
   the full checked-track × knob+ring × host matrix ≥3:1). It may **not** sit on `--raised` in dark
   without re-checking: the dark OFF track is 2.71:1 vs `--raised`, under the 3:1 non-text floor
   (3.27:1 vs `--panel`).

"Deviates" must name the failed row and why. The dev-only `/design` route locks the **primitives**
(swatches + every `src/ui` primitive in dark+light × desktop+iPhone); full **screen** fidelity is
judged per-screen against `docs/design/`.
