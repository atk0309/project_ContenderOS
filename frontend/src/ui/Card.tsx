// Panel surface shared by the authed screens (the `card` object every page re-declared). Presentational
// only — no "use client". `cardStyle` is exported for spots that style a different element; <Card>
// covers the common case and spreads `style` last so per-use tweaks (maxWidth, etc.) still win.
import type { CSSProperties, ReactNode } from "react";

export const cardStyle: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: "18px 18px 16px",
};

export function Card({
  as: Tag = "article",
  style,
  children,
}: {
  as?: "article" | "section";
  style?: CSSProperties;
  children: ReactNode;
}) {
  return <Tag style={{ ...cardStyle, ...style }}>{children}</Tag>;
}
