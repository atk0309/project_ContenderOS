"use client";

// The persistent app shell, composed from the design's pieces: the desktop left rail (Sidebar), a
// phone top bar (brand + theme + account) and bottom tab-bar (MobileNav), wrapping the single <main>
// landmark every authed page renders into. Session is non-null here (SessionProvider gates it), so
// identity/sign-out live in exactly one place. Responsive switch is CSS (globals.css): the rail shows
// ≥720px, the phone bar + bottom nav show below it.
import { useSearchParams } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { BRAND_NAME } from "@/lib/brand";
import { AccountButton } from "./AccountButton";
import { MobileNav } from "./MobileNav";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";

// The active `?view=` sub-view (Gatekeeper, B3) decides which nav entry highlights, and the active
// `?cv=` is carried into the Gatekeeper href so entering it from a loaded CV keeps that CV's live
// verdict (ADR 0011). Reading the params needs useSearchParams, which must sit under a Suspense
// boundary or `next build` bails out of static generation for every (app) page (the workspace page
// wraps its own read the same way). The fallback renders the nav with no sub-view active
// (pathname-only) — resolved on the client where the params are available synchronously.
function SidebarWithView() {
  const params = useSearchParams();
  return <Sidebar activeView={params.get("view")} activeCv={params.get("cv")} />;
}
function MobileNavWithView() {
  const params = useSearchParams();
  return <MobileNav activeView={params.get("view")} activeCv={params.get("cv")} />;
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-frame">
      <a href="#main" className="app-skip">
        Skip to main content
      </a>
      <Suspense fallback={<Sidebar activeView={null} />}>
        <SidebarWithView />
      </Suspense>
      <main id="main" tabIndex={-1} className="app-main">
        <header className="app-mobilehead">
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>
            {BRAND_NAME}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <ThemeToggle compact />
            <AccountButton compact />
          </div>
        </header>
        {children}
      </main>
      <Suspense fallback={<MobileNav activeView={null} />}>
        <MobileNavWithView />
      </Suspense>
    </div>
  );
}
