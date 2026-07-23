// The application-stage pipeline: a row of dots + connectors + short labels. Each dot carries a
// `state` (how far the pipeline has progressed) and a `tone` (its colour family) so the visual matches
// the Claude design — a blue (accent) progress line that turns green at "Offer" and red/grey when an
// application closes (rejected/withdrawn). The current step glows. Presentational + reusable (the
// Tracker wires its stage model + move handler to it). When `onPick` is set, the WHOLE cell (dot +
// label, ≥44px) is the tap target — not just the 16px dot — so it meets the iPhone-width touch
// requirement (frontend/AGENTS.md §7); the 16px dot stays the visual.
import type { CSSProperties } from "react";

export type StageState = "done" | "current" | "pending";
/** Colour family for a dot when it's reached (done/current). Resolved by the caller per stage. */
export type StageTone = "accent" | "ok" | "bad" | "muted";

export interface Stage {
  key: string;
  /** Short visible label under the dot (e.g. "Intv"). */
  short: string;
  /** Full stage name for the move-button aria-label (falls back to `short`). */
  name?: string;
  state: StageState;
  tone: StageTone;
}

const TONE: Record<StageTone, string> = {
  accent: "var(--accent)",
  ok: "var(--ok)",
  bad: "var(--bad)",
  muted: "var(--text-3)",
};

export function StageDots({
  stages,
  onPick,
  company,
}: {
  stages: Stage[];
  onPick?: (key: string) => void;
  /** For the per-stage aria-label ("Move {company} to {stage}"). */
  company?: string;
}) {
  // Interactive: each tappable stage stays ≥44px wide (minWidth on the cell) and the row scrolls
  // horizontally if the full pipeline can't fit (the labels can exceed a phone width).
  const interactive = !!onPick;
  return (
    <div style={interactive ? rowScroll : row}>
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1] : undefined;
        const inner = (
          <>
            <span aria-hidden style={dotStyle(s)} />
            <span style={labelStyle(s.state)}>{s.short}</span>
          </>
        );
        return (
          <div key={s.key} style={interactive ? cellTap : cell}>
            {prev ? <span aria-hidden style={connector(prev)} /> : null}
            {onPick ? (
              <button
                type="button"
                aria-label={`Move ${company ?? "application"} to ${s.name ?? s.short}`}
                // Announce the current stage on the dot itself (parity with the expanded move buttons).
                aria-current={s.state === "current" ? "step" : undefined}
                onClick={(e) => {
                  // Stop the click reaching a clickable row wrapper (tap to move ≠ open the row).
                  e.stopPropagation();
                  onPick(s.key);
                }}
                className="cos-dot"
                style={{ ...target, minHeight: 44, cursor: "pointer" }}
              >
                {inner}
              </button>
            ) : (
              <div style={target}>{inner}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function dotStyle(s: Stage): CSSProperties {
  const reached = s.state !== "pending";
  const c = TONE[s.tone];
  return {
    width: 16,
    height: 16,
    borderRadius: "50%",
    border: `2px solid ${reached ? c : "var(--line-strong)"}`,
    background: reached ? c : "var(--panel)",
    // The current step glows (an accent ring), matching the design.
    boxShadow:
      s.state === "current" ? `0 0 0 4px color-mix(in srgb, ${c} 22%, transparent)` : "none",
  };
}

function labelStyle(state: StageState): CSSProperties {
  return {
    fontFamily: "var(--mono)",
    fontSize: 8.5,
    // Stage names are ESSENTIAL text (rubric §6) — every label stays AA-readable via --text/--text-2;
    // state shows on the dot fill/ring/connector colour, never by dropping the label to muted
    // --text-3 (which fails AA at this 8.5px size in both themes).
    color: state === "current" ? "var(--text)" : "var(--text-2)",
    fontWeight: state === "current" ? 600 : 500,
    whiteSpace: "nowrap",
  };
}

const row: CSSProperties = { display: "flex", alignItems: "flex-start" };
const rowScroll: CSSProperties = { ...row, overflowX: "auto" };
const cell: CSSProperties = { position: "relative", flex: 1, minWidth: 0, display: "flex" };
// Interactive cells never shrink below a 44px tap target; the row scrolls instead.
const cellTap: CSSProperties = { ...cell, minWidth: 44 };
// The dot+label stack sits at the top of the (taller, tappable) cell button, so the connector — pinned
// to the dot's vertical centre — still lines up across cells.
const target: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: 6,
  width: "100%",
  padding: 0,
  border: "none",
  background: "transparent",
  position: "relative",
  zIndex: 1,
};
// The connector leading INTO a dot is coloured iff the previous dot is reached (done/current), in that
// dot's tone; otherwise it's a hairline. (Only "Offer" is `ok`-toned and it's always last, so the line
// stays uniformly accent in the normal pipeline — matching the design.)
function connector(prev: Stage): CSSProperties {
  const reached = prev.state !== "pending";
  return {
    position: "absolute",
    top: 7,
    right: "50%",
    left: "-50%",
    height: 2,
    background: reached ? TONE[prev.tone] : "var(--line)",
  };
}
