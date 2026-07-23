"use client";

// Desktop left rail, traced from the Claude design: brand mark + a pushpin that locks the rail open,
// icon nav with an accent active-bar, then (pinned to the bottom) the AI-readiness pill, theme
// toggle, and account/sign-out. Chrome tokens only; hover is the `.cos-navrow` utility (inline
// styles can't express :hover).
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties } from "react";
import { BRAND_NAME } from "@/lib/brand";
import { AccountButton } from "./AccountButton";
import { hrefFor, isActive, NAV } from "./nav";
import { useAiReadiness } from "./ReadinessProvider";
import { useSidebar } from "./SidebarProvider";
import { ThemeToggle } from "./ThemeToggle";

export function Sidebar({
  activeView,
  activeCv = null,
}: {
  activeView: string | null;
  activeCv?: string | null;
}) {
  const pathname = usePathname();
  const { tailor } = useAiReadiness();
  const { collapsed, toggle } = useSidebar();
  const items = NAV;
  // Pinned ≡ expanded (data-rail="expanded"); unpinned ≡ collapsed (the 64px hover-flyout strip).
  const pinned = !collapsed;

  return (
    <nav className="app-rail" aria-label="Primary">
      <div className="app-railbrand" style={brandRow}>
        <span style={brandMark} aria-hidden>
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
            focusable="false"
          >
            <path d="M4 5h11M4 10h16M4 15h8M4 20h13" />
          </svg>
        </span>
        <span className="cos-rail-label" style={brandName}>
          {BRAND_NAME}
        </span>
        {/* The pin locks the rail open: pinned ≡ expanded, unpinned ≡ the 64px hover-flyout strip
            (calls the same DevPR10 SidebarProvider toggle). Divergence from the mockup: the pin stays
            VISIBLE in the collapsed strip (see globals.css) so desktop-width TOUCH users keep the only
            expand control once the old bottom button is gone. Colour/background are the data-rail-driven
            `.cos-railpin` rules (inline would beat them); only the layout box + rotation are inline. The
            dynamic action label is the accessible name (no aria-pressed — it reads ambiguously beside a
            changing label). */}
        <button
          type="button"
          onClick={toggle}
          className="cos-railpin"
          aria-label={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          title={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          style={railPin}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
            focusable="false"
            style={{
              transform: pinned ? "rotate(0deg)" : "rotate(45deg)",
              transition: "transform 0.18s",
            }}
          >
            <path d="M9 4h6l-1.2 5.5 3.2 3v1.5H7v-1.5l3.2-3z" />
            <path d="M12 14v6" />
          </svg>
        </button>
      </div>

      <div className="app-nav">
        {items.map((item) => {
          const active = isActive(pathname, activeView, item);
          const { Icon } = item;
          return (
            <Link
              key={item.href}
              href={hrefFor(item, activeCv)}
              aria-current={active ? "page" : undefined}
              className="cos-navrow"
              style={navItem(active)}
            >
              {active ? <span style={activeBar} aria-hidden /> : null}
              <span style={iconSlot}>
                <Icon size={20} />
              </span>
              <span
                className="cos-rail-label"
                style={{ whiteSpace: "nowrap", fontSize: 13.5, letterSpacing: "-0.005em" }}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />
      <div style={divider} />

      {tailor !== "unknown" ? (
        <Link
          href="/admin"
          className="app-railpill"
          style={tailor === "ready" ? aiPillReady : aiPillSetup}
          title={
            tailor === "ready"
              ? "AI tailoring is configured"
              : "Add a provider key in Admin to enable AI tailoring"
          }
        >
          <span style={tailor === "ready" ? aiDotReady : aiDotSetup} aria-hidden />
          <span className="cos-rail-label">{tailor === "ready" ? "AI ready" : "Set up AI"}</span>
        </Link>
      ) : null}

      <ThemeToggle />
      <AccountButton />
    </nav>
  );
}

// Layout (display/align/gap/height) lives in the `.app-railbrand` CSS rule so the collapsed strip can
// override it to a vertical logo-over-pin stack — an inline flex/height would beat that (inline >
// stylesheet, the documented gotcha). Only non-layout styling stays inline here.
const brandRow: CSSProperties = {
  marginBottom: 13,
  padding: "0 8px",
};
const brandMark: CSSProperties = {
  flex: "none",
  width: 32,
  height: 32,
  border: "1.5px solid var(--accent)",
  borderRadius: 8,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--accent)",
};
const brandName: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontWeight: 700,
  fontSize: 14,
  letterSpacing: "-0.01em",
  whiteSpace: "nowrap",
};

function navItem(active: boolean): CSSProperties {
  return {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 12,
    height: 42,
    borderRadius: 10,
    padding: "0 10px",
    textDecoration: "none",
    color: active ? "var(--accent)" : "var(--text-2)",
    background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
    fontWeight: active ? 600 : 500,
  };
}
const activeBar: CSSProperties = {
  position: "absolute",
  left: -10,
  top: 9,
  bottom: 9,
  width: 3,
  borderRadius: "0 3px 3px 0",
  background: "var(--accent)",
};
const iconSlot: CSSProperties = {
  flex: "none",
  width: 22,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const divider: CSSProperties = { height: 1, background: "var(--line)", margin: "6px 2px" };
// The pin's 26px visual box. Colour/background come from `.cos-railpin` (data-rail-driven) — NOT
// inline; the 44×44 touch target is its `::after`. Rotation is inline (React `pinned`, no CSS rival).
const railPin: CSSProperties = {
  flex: "none",
  width: 26,
  height: 26,
  borderRadius: 7,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const aiPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--mono)",
  fontSize: 11,
  fontWeight: 600,
  textDecoration: "none",
  borderRadius: 7,
  padding: "4px 8px",
  // `align-self` lives in CSS (.app-railpill), NOT inline — inline would beat the collapsed
  // `align-self: stretch` rule and leave a sub-44px tap target in the strip (DevPR5).
};
const aiPillReady: CSSProperties = {
  ...aiPill,
  // Essential label ink stays --text (AA in both themes); the ready/setup state colour rides the
  // dot + border + fill tint below (rubric §6 — never colour essential text with a bright semantic).
  color: "var(--text)",
  border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)",
  background: "color-mix(in srgb, var(--ok) 12%, transparent)",
};
const aiPillSetup: CSSProperties = {
  ...aiPill,
  color: "var(--text)",
  border: "1px solid color-mix(in srgb, var(--warn) 45%, transparent)",
  background: "color-mix(in srgb, var(--warn) 12%, transparent)",
};
const aiDot: CSSProperties = { width: 7, height: 7, borderRadius: "50%" };
const aiDotReady: CSSProperties = { ...aiDot, background: "var(--ok)" };
const aiDotSetup: CSSProperties = { ...aiDot, background: "var(--warn)" };
