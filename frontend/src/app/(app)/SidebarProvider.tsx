"use client";

// Reads the rail state the pre-hydration script (src/lib/sidebar.ts) already set on <html data-rail>,
// and exposes a toggle that flips the attribute + persists it. The attribute is the source of truth
// (so the script and React never disagree, and the rail's collapsed width is CSS-driven from the first
// frame — no flash); React state only mirrors it for the toggle's icon/`aria-pressed`. Mirrors
// ThemeProvider: a deterministic default + a `useEffect` sync (never a `useState(() => document…)`
// initializer, which would throw during SSR).
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { RAIL_KEY, type RailState } from "@/lib/sidebar";

type SidebarContext = { collapsed: boolean; toggle: () => void };

const Ctx = createContext<SidebarContext | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(document.documentElement.dataset.rail === "collapsed");
  }, []);

  const toggle = useCallback(() => {
    // Flip from the LIVE attribute (the source of truth the pre-paint script set), NOT React `prev`:
    // on a persisted-collapsed first paint the state may not have synced yet, and toggling from a
    // stale `prev` would no-op a fast first click (DevPR10). Writing the attribute keeps the CSS
    // correct; `setCollapsed` keeps the toggle's icon/label in step.
    const next = document.documentElement.dataset.rail !== "collapsed";
    const state: RailState = next ? "collapsed" : "expanded";
    document.documentElement.dataset.rail = state;
    try {
      localStorage.setItem(RAIL_KEY, state);
    } catch {
      // private mode / storage disabled — the in-memory toggle still works for this session.
    }
    setCollapsed(next);
  }, []);

  return <Ctx.Provider value={{ collapsed, toggle }}>{children}</Ctx.Provider>;
}

export function useSidebar(): SidebarContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
  return ctx;
}
