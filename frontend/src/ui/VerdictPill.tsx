// The Gatekeeper decision pill (dot + decision label + optional ATS score), coloured by the decision
// via the canonical DECISION_META (src/ui/colors.ts). Used in the workspace header and verdict views.
import type { Schemas } from "@/lib/api/client";
import { DECISION_META } from "./colors";

export function VerdictPill({
  decision,
  score,
  stale = false,
}: {
  decision: Schemas["Decision"];
  score?: number;
  /** The verdict predates the current CV (ADR 0016): desaturate the CHROME only — the dot, tint,
   *  and border mix toward the neutral `--line`; the label stays `--text` and the score `--text-2`
   *  (stale-marking never dims essential text — rubric §6). */
  stale?: boolean;
}) {
  const meta = DECISION_META[decision] ?? DECISION_META.borderline;
  const chrome = stale ? `color-mix(in srgb, ${meta.color} 40%, var(--line))` : meta.color;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 11px",
        borderRadius: 7,
        background: `color-mix(in srgb, ${chrome} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${chrome} 40%, transparent)`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: chrome }} aria-hidden />
      {/* Decision is colour-coded by the dot + border/fill; the label uses --text so it stays WCAG-AA
          on the light tint (the bright semantic colours fail AA as text in light theme). */}
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text)",
        }}
      >
        {meta.label}
      </span>
      {typeof score === "number" ? (
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-2)" }}>
          {Math.max(0, Math.min(100, Math.round(score)))}/100
        </span>
      ) : null}
    </span>
  );
}
