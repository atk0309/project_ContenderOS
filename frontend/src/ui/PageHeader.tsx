// The eyebrow + h1 + optional subtitle block every authed screen repeats. The subtitle is `children`
// (ReactNode) so a page can embed a link (e.g. the workspace's "master CV"). Presentational only.
import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header style={{ marginBottom: 18 }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-3)",
        }}
      >
        {eyebrow}
      </div>
      <h1 style={{ margin: "8px 0 4px", fontSize: 24, letterSpacing: "-0.02em" }}>{title}</h1>
      {children ? (
        <p style={{ margin: 0, color: "var(--text-2)", fontSize: 13, lineHeight: 1.5 }}>
          {children}
        </p>
      ) : null}
    </header>
  );
}
