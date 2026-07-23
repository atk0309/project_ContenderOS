"use client";

// The phone bottom tab-bar (shown < 720px; the desktop rail is hidden there). Same nav source as the
// Sidebar so they never drift. Fixed to the bottom; `.app-main` reserves space for it in globals.css.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties } from "react";
import { hrefFor, isActive, NAV } from "./nav";

export function MobileNav({
  activeView,
  activeCv = null,
}: {
  activeView: string | null;
  activeCv?: string | null;
}) {
  const pathname = usePathname();
  const items = NAV;

  return (
    <nav className="app-mobilebar" aria-label="Primary">
      {items.map((item) => {
        const active = isActive(pathname, activeView, item);
        const { Icon } = item;
        return (
          <Link
            key={item.href}
            href={hrefFor(item, activeCv)}
            aria-current={active ? "page" : undefined}
            style={tab(active)}
          >
            <Icon size={21} />
            <span style={{ fontSize: 10, letterSpacing: "-0.01em" }}>{item.short}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function tab(active: boolean): CSSProperties {
  return {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    padding: "5px 2px",
    minHeight: 48,
    borderRadius: 10,
    textDecoration: "none",
    color: active ? "var(--accent)" : "var(--text-2)",
    fontWeight: active ? 600 : 500,
  };
}
