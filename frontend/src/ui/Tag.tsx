// Small mono chip/badge shared across screens (status tags, reviewer chips). `tagStyle(color)` returns
// the style object for a token-coloured chip; the colour is a CSS variable the caller chooses.
import type { CSSProperties } from "react";

export function tagStyle(color: string): CSSProperties {
  // The semantic colour lives on the border + fill; the label uses --text so it stays WCAG-AA in both
  // themes (bright semantic / --rv-* colours fail AA as small text on light surfaces).
  return {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text)",
    border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    borderRadius: 6,
    padding: "2px 6px",
  };
}
