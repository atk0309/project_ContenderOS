// Shared button primitives — one canonical definition for the accent / ghost / action-link / danger
// styles that every authed screen used to re-declare inline (the source of cross-page drift). Pure
// presentational style objects reading the chrome CSS variables (no Tailwind, no "use client"), so they
// render in a server or client tree. `buttonStyle()` is exported for `<a>`/custom elements that can't be
// a <button>; <Button> wraps the common <button> case and spreads an incoming `style` LAST so overrides
// still win. Never import this from src/render/** — it must not touch the deterministic render path.
import type { ButtonHTMLAttributes, CSSProperties } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "ghostLink" | "danger";

const VARIANTS: Record<ButtonVariant, CSSProperties> = {
  // Accent CTA (in-card buttons AND dashboard action links).
  primary: {
    padding: "9px 14px",
    borderRadius: 9,
    border: "none",
    background: "var(--accent)",
    color: "var(--on-accent)",
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  // Neutral secondary CTA — same weight as primary, outlined (the design's secondary action).
  secondary: {
    padding: "9px 14px",
    borderRadius: 9,
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--text)",
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  // Small mono secondary control (in-card).
  ghost: {
    fontFamily: "var(--mono)",
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--text-2)",
    fontSize: 11,
  },
  // Larger secondary action link (dashboard / footer nav between screens).
  ghostLink: {
    padding: "9px 14px",
    borderRadius: 9,
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--text-2)",
    fontSize: 13,
    fontWeight: 600,
  },
  // Destructive (remove an entry / delete a row).
  danger: {
    fontFamily: "var(--mono)",
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid color-mix(in srgb, var(--bad) 40%, transparent)",
    background: "transparent",
    color: "var(--bad)",
    fontSize: 10.5,
    whiteSpace: "nowrap",
  },
};

/** Style object for a button variant — for `<a>`/custom elements (or anywhere a <button> won't do). */
export function buttonStyle(variant: ButtonVariant = "primary", disabled = false): CSSProperties {
  return {
    ...VARIANTS[variant],
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

type ButtonProps = { variant?: ButtonVariant } & ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ variant = "primary", disabled, style, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      disabled={disabled}
      style={{ ...buttonStyle(variant, disabled), ...style }}
      {...rest}
    />
  );
}

/** Square icon-only button (24–40px). The outline + ink + hover all live in the `.cos-iconbtn`
 *  utility (NOT inline here) so the hover actually fires — an inline background/color/border would
 *  beat the stylesheet. `label` is the required accessible name (the button has no visible text).
 *  Per-use overrides still work via `style` (e.g. a modal close passes `border:"none"`). */
export function IconButton({
  label,
  size = 36,
  style,
  type,
  ...rest
}: { label: string; size?: number } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className="cos-iconbtn"
      style={{
        width: size,
        height: size,
        borderRadius: 9,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        ...style,
      }}
      {...rest}
    />
  );
}
