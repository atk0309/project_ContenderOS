/**
 * The top bar's live Gatekeeper verdict cluster, extracted from page.tsx as a PRESENTATIONAL
 * component so the header region is testable in the renderToStaticMarkup harness (ADR 0016).
 * A click opens the full recruiter read (`?view=gatekeeper`); the visible "<decision> <score>/100"
 * is embedded in the accessible name (WCAG 2.5.3).
 *
 * When the review is version-drifted the cluster STAYS visible, stale-marked (ADR 0016): the pill
 * desaturates and a SHORT "Out of date" chip appears — the full canonical `STALE_REVIEW_PHRASE`
 * (45 chars) would wrap the topbar at 1120–1300px widths, so it rides the button's EXTENDED
 * aria-label instead. The chip is aria-hidden, so the name must CONTAIN its visible "Out of date"
 * text (WCAG 2.5.3 label-in-name — a voice-control user speaks what they see) ahead of the
 * canonical phrase. Chip ink follows the Applied-chip rule: colour on the dot/border/tint only,
 * label at `--text-2` — never warn-as-text.
 */
import type { CSSProperties } from "react";
import type { Schemas } from "@/lib/api/client";
import { DECISION_META, VerdictPill } from "@/ui";
import { STALE_REVIEW_PHRASE } from "./logic";
import { mono } from "./styles";

export function TopbarVerdict({
  verdict,
  stale,
  onOpen,
}: {
  verdict: Schemas["GatekeeperVerdict"];
  /** The review is version-drifted — the verdict predates the current CV (ADR 0016). */
  stale: boolean;
  onOpen: () => void;
}) {
  const label = (DECISION_META[verdict.decision] ?? DECISION_META.borderline).label;
  const score = Math.max(0, Math.min(100, Math.round(verdict.atsMatchScore)));
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Gatekeeper verdict ${label} ${score}/100 — ${
        stale ? `Out of date: ${STALE_REVIEW_PHRASE} — ` : ""
      }open the recruiter read`}
      style={btn}
    >
      <VerdictPill decision={verdict.decision} score={verdict.atsMatchScore} stale={stale} />
      {stale ? (
        <span style={staleChip} aria-hidden>
          <span style={chipDot} />
          Out of date
        </span>
      ) : null}
    </button>
  );
}

const btn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  minHeight: 44,
  background: "transparent",
  border: "none",
  padding: "0 2px",
  borderRadius: 7,
  cursor: "pointer",
};

const staleChip: CSSProperties = {
  ...mono,
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  // Chip ink rule (ADR 0016): colour on the dot/border/tint; the label stays --text-2 for AA.
  color: "var(--text-2)",
  background: "color-mix(in srgb, var(--warn) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--warn) 32%, var(--line))",
  borderRadius: 6,
  padding: "3px 8px",
};

const chipDot: CSSProperties = {
  width: 6,
  height: 6,
  flex: "none",
  borderRadius: "50%",
  background: "var(--warn)",
};
