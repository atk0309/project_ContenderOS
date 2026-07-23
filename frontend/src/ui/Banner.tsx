// The role="alert" ok/bad banner duplicated verbatim in master, workspace, and ingest. Presentational.
import type { CSSProperties } from "react";

export function Banner({
  kind,
  text,
  style,
}: {
  kind: "ok" | "bad";
  text: string;
  style?: CSSProperties;
}) {
  const c = kind === "ok" ? "var(--ok)" : "var(--bad)";
  return (
    <div
      role="alert"
      style={{
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 12.5,
        // Alert tone is the coloured border + fill; the text is --text for WCAG-AA in both themes.
        color: "var(--text)",
        border: `1px solid color-mix(in srgb, ${c} 40%, transparent)`,
        background: `color-mix(in srgb, ${c} 12%, transparent)`,
        ...style,
      }}
    >
      {text}
    </div>
  );
}
