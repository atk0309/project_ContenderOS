/**
 * The rail's compact, clickable Gatekeeper card (DevPR15) — a summary + entry point that opens the full
 * recruiter read (`?view=gatekeeper`, where the keywords / must-haves / 20-second note live, so they're
 * NOT duplicated here). Reskinned to the Claude design's rail card (`docs/design/Contender.dc.html`):
 * the "Gk" badge + the decision (reusing the AA-safe `VerdictPill`, label only) + an "ATS {score}/100"
 * caption + the score bar + a 2-line recruiter note. Advisory only — it never gates export (only
 * sign-off does, invariant 2), so the card keeps the "never blocks export" caption.
 *
 * A11y: the card is a `<button>` (phrasing content only — inner blocks are `display:block` <span>s, never
 * <div>/<p>), with an `aria-label` carrying decision + score + advisory; the score caption / bar / notes
 * are visual-only (`aria-hidden`) since the name covers them. Tokens-only colours.
 *
 * Stale (ADR 0016): a version-drifted verdict stays visible — the card is the RAIL's single drift
 * carrier when a verdict exists: a SHORT "Out of date" chip (aria-hidden, so the accessible name
 * must CONTAIN its visible "Out of date" text per WCAG 2.5.3 label-in-name, followed by the full
 * canonical `STALE_REVIEW_PHRASE`) + the card chrome/pill/bar desaturated (colour-mixed toward
 * `--line`; text inks untouched, rubric §6).
 */
import type { CSSProperties } from "react";
import type { Schemas } from "@/lib/api/client";
import { agentIdentity, DECISION_META, VerdictPill } from "@/ui";
import { STALE_REVIEW_PHRASE } from "./logic";

type GatekeeperVerdict = Schemas["GatekeeperVerdict"];

const GATE = agentIdentity("gate");
const mono = { fontFamily: "var(--mono)" } as const;

export function VerdictCard({
  verdict,
  stale = false,
  onOpen,
}: {
  verdict: GatekeeperVerdict;
  /** The review is version-drifted — the verdict predates the current CV (ADR 0016). */
  stale?: boolean;
  onOpen: () => void;
}) {
  const tone = DECISION_META[verdict.decision] ?? DECISION_META.borderline;
  const chrome = stale ? `color-mix(in srgb, ${tone.color} 40%, var(--line))` : tone.color;
  const score = Math.max(0, Math.min(100, Math.round(verdict.atsMatchScore)));
  return (
    <button
      type="button"
      data-testid="verdict-card"
      onClick={onOpen}
      className="ws-gk-card"
      aria-label={`Gatekeeper verdict ${tone.label} ATS ${score}/100.${
        stale ? ` Out of date: ${STALE_REVIEW_PHRASE}.` : ""
      }${
        verdict.recruiterNotes.trim() ? ` ${verdict.recruiterNotes.trim().slice(0, 180)}` : ""
      } Advisory — never blocks export. Open the recruiter read`}
      style={card(chrome)}
    >
      <span style={headRow}>
        <span style={headLeft}>
          <span style={badge} aria-hidden>
            {GATE.glyph}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Gatekeeper</span>
        </span>
        <span style={{ ...mono, fontSize: 10, color: "var(--text-3)" }} aria-hidden>
          view →
        </span>
      </span>

      <span style={decisionRow}>
        {/* Decision label only (AA-safe via VerdictPill); the score lives once in the caption beside it
            so the "ATS" label isn't detached from its number. */}
        <VerdictPill decision={verdict.decision} stale={stale} />
        <span style={{ ...mono, fontSize: 12.5, color: "var(--text-2)" }} aria-hidden>
          ATS {score}/100
        </span>
        {stale ? (
          <span style={staleChip} aria-hidden>
            <span style={chipDot} />
            Out of date
          </span>
        ) : null}
      </span>

      {/* Score bar — purely visual (the number is in the caption above). */}
      <span aria-hidden style={bar}>
        <span
          style={{ display: "block", width: `${score}%`, height: "100%", background: chrome }}
        />
      </span>

      {verdict.recruiterNotes.trim() ? (
        <span style={notes} aria-hidden>
          {verdict.recruiterNotes}
        </span>
      ) : null}

      <span style={{ ...mono, fontSize: 10, color: "var(--text-3)" }} aria-hidden>
        Advisory — never blocks export.
      </span>
    </button>
  );
}

function card(color: string): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: 9,
    width: "100%",
    textAlign: "left",
    padding: 14,
    borderRadius: 11,
    border: `1px solid color-mix(in srgb, ${color} 35%, var(--line))`,
    background: `color-mix(in srgb, ${color} 8%, var(--panel))`,
    cursor: "pointer",
    fontFamily: "var(--ui)",
  };
}
const headRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
const headLeft: CSSProperties = { display: "flex", alignItems: "center", gap: 7 };
const badge: CSSProperties = {
  width: 18,
  height: 18,
  flex: "none",
  borderRadius: 5,
  background: GATE.color,
  color: GATE.ink,
  fontFamily: "var(--mono)",
  fontSize: 8,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const decisionRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  flexWrap: "wrap",
};
// Chip ink rule (ADR 0016): colour on the dot/border/tint; the label stays --text-2 for AA.
const staleChip: CSSProperties = {
  ...mono,
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
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
const bar: CSSProperties = {
  display: "block",
  height: 5,
  borderRadius: 3,
  background: "var(--line)",
  overflow: "hidden",
};
const notes: CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  fontSize: 11.5,
  color: "var(--text-2)",
  lineHeight: 1.5,
};
