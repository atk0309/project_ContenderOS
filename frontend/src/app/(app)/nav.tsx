// The single nav definition shared by the desktop Sidebar and the mobile bottom-nav, so the two never
// drift. Route-based (the design's single-page `data-screen` switch maps to our App Router routes).
//
// Convergence note: the design's nav is Workspace / Gatekeeper / Diff / Tracker / Master / Admin.
// Gatekeeper (B3) + Diff (B4) are per-CV subviews (ADR 0011) reached as a `?view=` MODE of the
// `/workspace` route — NOT separate pages — so the transient, in-session review verdict survives
// entering them. Workspace absorbed Home (B1) and Master absorbed Import (C4 — import is a modal opened
// from Master's "Add source"; `/ingest` redirects to `/master?import=1`), so neither has a nav entry.
import type { ComponentType } from "react";
import {
  AdminIcon,
  DiffIcon,
  GatekeeperIcon,
  MasterIcon,
  TrackerIcon,
  WorkspaceIcon,
} from "./icons";

export interface NavItem {
  href: string;
  label: string;
  /** Short label for the mobile bottom-nav. */
  short: string;
  Icon: ComponentType<{ size?: number }>;
  /** A `?view=` sub-view of `href`'s path (e.g. Gatekeeper). Active iff that view is the current one;
   *  its presence also makes the BASE entry (same path, no `view`) inactive while the sub-view shows. */
  view?: string;
}

// One nav for the one kind of account (every allowlisted account is an owner). `/` has no entry:
// the Workspace screen absorbed the dashboard (B1), so `/` is a pure redirect to /workspace.
export const NAV: NavItem[] = [
  {
    href: "/workspace",
    label: "Workspace",
    short: "Workspace",
    Icon: WorkspaceIcon,
  },
  {
    // The Gatekeeper recruiter/ATS read for the active CV (ADR 0011). A `?view=` mode of /workspace;
    // lands on the designed empty state when there's no live verdict in this session.
    href: "/workspace?view=gatekeeper",
    label: "Gatekeeper",
    short: "Gate",
    Icon: GatekeeperIcon,
    view: "gatekeeper",
  },
  {
    // The before/after of the active CV's last applied correction (ADR 0011). A `?view=` mode of
    // /workspace; designed empty state when there's no in-session correction.
    href: "/workspace?view=diff",
    label: "Diff",
    short: "Diff",
    Icon: DiffIcon,
    view: "diff",
  },
  {
    href: "/applications",
    label: "Tracker",
    short: "Tracker",
    Icon: TrackerIcon,
  },
  {
    href: "/master",
    label: "Master profile",
    short: "Profile",
    Icon: MasterIcon,
  },
  // Import has no nav entry: it was absorbed into the Master editor (C4) as a modal opened from
  // Master's "Add source". `/ingest` still exists, but only as a redirect to `/master?import=1`.
  { href: "/admin", label: "Admin", short: "Admin", Icon: AdminIcon },
];

/** The href to navigate to, preserving the active `?cv=` for a sub-view entry (Gatekeeper) so
 *  entering it from a loaded CV keeps that CV — and its live, in-session verdict (ADR 0011) — instead
 *  of dropping the param and landing on the empty state. Base entries use their static href. */
export const hrefFor = (item: NavItem, activeCv: string | null): string => {
  if (!item.view || !activeCv) return item.href;
  const base = item.href.split("?")[0];
  return `${base}?cv=${encodeURIComponent(activeCv)}&view=${item.view}`;
};

/** Is `item` the active nav entry, given the current pathname + `?view=` param? Path must match first;
 *  then a sub-view entry needs its `view` active, and a base entry goes inactive while a sibling
 *  sub-view of the same path is showing (so exactly one of Workspace / Gatekeeper highlights). */
export const isActive = (pathname: string, view: string | null, item: NavItem): boolean => {
  const base = item.href.split("?")[0];
  const pathMatches = pathname === base || pathname.startsWith(`${base}/`);
  if (!pathMatches) return false;
  if (item.view) return view === item.view;
  if (!view) return true;
  const siblingViews = NAV.filter((n) => n.view && n.href.split("?")[0] === base).map(
    (n) => n.view,
  );
  return !siblingViews.includes(view);
};
