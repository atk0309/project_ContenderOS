"use client";

// Layout for the (app) route group — the authed cockpit shell. It wraps ONLY the routes inside (app)/
// (home, workspace, master, ingest, admin). /sign-in and /print/[cvId] live outside the group, so they
// render with NO shell and NO session provider — the render path stays chrome-free (invariant 3).
// Route groups are URL-transparent, so moving pages under (app)/ changes no URL. This is a CLIENT
// layout (the shell needs usePathname/useState); <html>/<body> + metadata stay at root app/layout.tsx.
import type { ReactNode } from "react";
import { AppShell } from "./AppShell";
import { ReadinessProvider } from "./ReadinessProvider";
import { SessionProvider } from "./SessionProvider";
import { SidebarProvider } from "./SidebarProvider";
import { ThemeProvider } from "./ThemeProvider";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <SessionProvider>
        <ReadinessProvider>
          <SidebarProvider>
            <AppShell>{children}</AppShell>
          </SidebarProvider>
        </ReadinessProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
