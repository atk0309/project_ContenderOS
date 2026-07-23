# Feature: App shell & navigation

Status: shipped (open items live under Known limitations)  
Last updated: 2026-07-22

## Purpose
The authed screens used to be five detached pages, each re-fetching `/auth/me`, drawing its own header,
and re-defining its own button/card styles — and `/admin` had no inbound link at all. This binds them
into one cockpit: a persistent navigation shell, one shared session, and a single AI-readiness
signal, so the product reads as one self-contained app rather than loosely linked URLs.

## User-facing behaviour
- A persistent **left rail** (brand mark + a **pushpin** to lock it open + **icon nav** with an accent
  active-bar) wraps every authed route on desktop (≥720px). Unpinned, the rail is a **64px icon strip**
  that flies out to its full **214px** over the content on hover/keyboard-focus (no reflow); the pin
  locks it open. On phone (<720px) the rail is replaced by a **bottom tab-bar** plus a slim top bar
  (brand + theme toggle + account avatar). There is **one nav for the one kind of account** (every
  allowlisted account is an owner — the single-user pivot):
  **Workspace** / **Gatekeeper** / **Diff** / **Tracker** / Master profile / **Admin**.
  **Workspace is home** — it absorbed the old Home dashboard (B1), so `/` is a pure redirect to
  `/workspace` (no Home nav entry).
  **Gatekeeper** (B3) and **Diff** are `?view=` **sub-views of `/workspace`** — the recruiter/ATS verdict
  (Gatekeeper) and every bullet changed since the review ran (Diff).
  The Gatekeeper stays a transient per-CV sub-view of the persisted-and-rehydrated review (ADR 0011/0013);
  the Diff is **derived from the persisted review baseline (ADR 0015)**, so it is cumulative and survives
  navigation/reload. Each entry carries the active `?cv=` so it keeps that CV's state, and lands on a
  designed empty state when there's none.
  _(Master absorbed Import (C4): import is a modal opened from Master's "Add source" — there is no
  Import nav entry; `/ingest` redirects to `/master?import=1`.)_
- A **theme toggle** (dark ↔ light) lives in the rail (and the phone top bar). Dark is the default;
  the choice persists and follows the OS on first visit. A pre-paint inline script sets the palette
  before the first frame, so there is no flash. The whole UI is built from the design tokens — see
  `docs/architecture/design-system.md` (a machine guard forbids ad-hoc colour literals).
- The active route is marked (accent colour + tint + bar + `aria-current="page"`). A visually-hidden
  **"Skip to main content"** link is the first focusable, so keyboard/SR users bypass the repeated rail.
- `/sign-in` and `/print/[cvId]` render **without** the shell — the sign-in gate and the print/PDF
  surface stay chrome-free (invariant 3).
- Identity (email + the Operator label) + **Sign out** live in the shell's account button.
- AI readiness: the rail shows "AI ready" / "Set up AI", linking to Admin.
- **Mid-session revocation** (an email removed from `ALLOWLIST_EMAILS`) surfaces per screen: the next
  in-page request 403s. Dedicated access-removed copy ("Your access was removed — sign in with an
  allowlisted account.") renders on the Workspace screen (its CV load and save paths) and
  `/applications/[id]` **only**; every other page fails through its generic error path, and a hard
  reload on any page bounces to `/sign-in` via `SessionProvider` (the shell's fail-closed catch-all).

## Implementation
- App Router **route group** `frontend/src/app/(app)/` wraps the authed pages. Route groups are
  URL-transparent, so moving `page.tsx`, `master/`, `ingest/`, `workspace/`, and `admin/` under `(app)/`
  changed no URL. `/sign-in`, `/print/`, and the `auth|ai|workspaces` proxies + `api/render/*` stay
  outside the group.
- `(app)/layout.tsx` (client) renders
  `<ThemeProvider><SessionProvider><ReadinessProvider><SidebarProvider><AppShell>…`;
  `<html>/<body>` + metadata + **two** pre-paint scripts stay at the root `app/layout.tsx`
  (`<html suppressHydrationWarning>`): the theme script (reads `localStorage`/`prefers-color-scheme` →
  sets `data-theme`) and the **rail script** (reads `localStorage` → sets `data-rail`, so a collapsed
  rail is the right width on the first frame — DevPR5). `AppShell` composes `Sidebar` (desktop rail),
  `MobileNav` (bottom tabs), and a phone top bar (`AccountButton` + `ThemeToggle`). Nav is defined once
  in `(app)/nav.tsx` (the flat `NAV` list — no role filtering) and shared by both; icons in
  `(app)/icons.tsx`; theme in `(app)/ThemeProvider.tsx`
  + `src/lib/theme.ts`; rail pin/collapse in `(app)/SidebarProvider.tsx` + `src/lib/sidebar.ts` (mirrors
  the theme pattern exactly: attribute is the source of truth, React state mirrors it for the pin).
- `(app)/SessionProvider.tsx` fetches `/auth/me` once and exposes `useSession()`; it owns the
  401 → `/sign-in` redirect (its catch-all also bounces a revoked-but-cookied fresh mount — the
  decided fail-closed behaviour). Pages carry no client-side role gate: the server is the authority.
  A mid-session 403 renders the dedicated access-removed copy on the Workspace screen (its CV load
  and save paths) and `/applications/[id]` **only**; other pages fail via their generic error paths,
  and any hard reload bounces through `SessionProvider`.
- `(app)/AppShell.tsx` owns the single `<main id="main">` landmark. Responsive structure lives in
  `globals.css` (`.app-frame/.app-rail/.app-main/.app-nav/.app-skip/.app-mobilehead/.app-mobilebar`),
  mirroring the `.ws-cols` utility idiom. Single breakpoint at **720px**: ≥720 shows the rail; <720
  hides it, shows the bottom tab-bar (`--bottom-nav-h`) + top bar, and `.app-main` pads its bottom to
  clear the fixed nav. Hover for nav rows/icon buttons
  is the `.cos-navrow`/`.cos-iconbtn` utilities (inline styles can't express `:hover`).
- **Sub-view entries** (Gatekeeper B3, Diff B4) are a `?view=` mode of an existing route, not a separate
  page, so the route's in-memory transient state survives entering them. `nav.tsx` carries an optional
  `view` on the item; `isActive(pathname, view, item)` makes **exactly one** of the base (Workspace) /
  sub-views (Gatekeeper / Diff) active, and `hrefFor(item, activeCv)` preserves the active `?cv=` so the
  entry keeps the loaded CV. `AppShell` reads `view`/`cv` via `useSearchParams` **wrapped in a Suspense
  boundary** (so `next build` still statically prerenders the (app) pages); the fallback renders the
  nav pathname-only.
- AI readiness (PR3) reads `GET /admin/providers` via a `tailorReady()` helper (safe for every
  account — all are owners) and refreshed after admin key/tier changes. See `ai-panel.md` for the
  agents.

## Data model
- None. Frontend-only; reuses the existing `AuthUser` and `AdminStatus` wire models (no schema change).

## Tests
- `tailorReady()` (PR3) is a pure helper with a vitest unit test (`docs/testing/strategy.md`). The
  shell/session/redirect behaviour is node-env-invisible, so it is verified via `pnpm build` +
  Playwright MCP (URL resolution, active state, shell-free `/sign-in` + `/print`, iPhone width,
  the ingest Apply bar clearing the rail).

## Decisions & trade-offs
- **Route group over a per-page `<AppShell>` import or a pathname-branching root layout:** the group
  applies the shell to exactly the wrapped routes with one client boundary and keeps `/print` out of the
  shell's module graph entirely — the strongest guarantee for the render-path invariant.
- **Left rail over a top bar** (owner decision) for the cockpit feel; it collapses to a top bar on phone
  width so the workspace (the desktop three-pane, ADR 0012, falling back to a tab bar below the
  fit threshold) and the ingest sticky bar still work.
- **The human-reviewer concept is gone** (single-user pivot, DevPR41): the reviewer-only Home entry,
  the role-filtered nav, and the reviewer placeholder screens were removed outright; the AI review
  panel (the "Reviewers tab", the agents) is unaffected.

## Known limitations & follow-ups
- [x] Workspace absorbs Home (B1): `/` is a pure redirect to `/workspace` (the Home entry is gone —
      single-user pivot).
- [x] Phone density resolved — the wrapped top bar is replaced by a bottom tab-bar + a compact top bar.
- [x] Sidebar pin model (the design's hover-to-expand + pin-to-lock rail) — **built (DevPR5; reskinned
      to the pushpin in DevPR24/S6)**. A **pushpin in the brand row** flips `data-rail` (persisted via
      `SidebarProvider` + the pre-paint `railInitScript`): `expanded` is pinned-open (**214px**,
      `--rail-w-expanded`); `collapsed` is a **64px icon strip** (`--rail-w-collapsed`) that widens to
      the full 214px over the content on hover/keyboard-focus — the rail goes `position:fixed` and
      `.app-main` keeps the narrow offset, so the flyout never reflows the workspace. The pin lights
      accent when pinned, rotates 45° when unpinned, and **stays visible in the 64px strip** (touch
      users have no hover); the brand stacks logo-over-pin there at a reserved 64px height so the flyout
      doesn't shift the nav rows. Labels stay in the DOM (clipped via `.cos-rail-label`) so the
      accessible name survives; ≥44px tap targets (the pin's is a transparent `::after`). Default is
      pinned-open (the mockup defaults unpinned). *(The old bottom Collapse/Expand button is gone.)*
- [x] Gatekeeper nav entry (B3) + Diff nav entry (B4): `?view=` sub-views of `/workspace`,
      cv-preserving.
- [x] Master absorbed Import (C4): import is a modal from Master's "Add source"; the Import nav entry
      is gone and `/ingest` redirects to `/master?import=1`.
