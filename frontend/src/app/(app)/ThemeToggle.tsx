"use client";

// Dark/light toggle. Shows the icon of the theme you'll switch TO. Full-width row in the sidebar;
// a 36px icon button in the mobile header.
import type { CSSProperties } from "react";
import { MoonIcon, SunIcon } from "./icons";
import { useTheme } from "./ThemeProvider";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggle } = useTheme();
  const toLight = theme === "dark";
  const label = toLight ? "Light mode" : "Dark mode";
  const Icon = toLight ? SunIcon : MoonIcon;

  if (compact) {
    return (
      <button
        type="button"
        onClick={toggle}
        title={label}
        aria-label={label}
        className="cos-iconbtn"
        style={iconBtn}
      >
        <Icon size={18} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className="cos-navrow"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 40,
        borderRadius: 10,
        padding: "0 8px",
        width: "100%",
        color: "var(--text-2)",
        fontSize: 13.5,
      }}
    >
      <span style={{ flex: "none", width: 22, display: "flex", justifyContent: "center" }}>
        <Icon size={19} />
      </span>
      <span className="cos-rail-label" style={{ whiteSpace: "nowrap" }}>
        {label}
      </span>
    </button>
  );
}

const iconBtn: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 9,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-2)",
  border: "1px solid var(--line)",
  background: "transparent",
  cursor: "pointer",
};
