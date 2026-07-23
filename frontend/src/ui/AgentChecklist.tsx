/**
 * The live streaming-run view, shared by ingestion and the review fan-out: ONE replaceable status
 * sentence in the only `aria-live` region (a screen reader hears the delta, not the whole list each
 * tick), plus a per-agent checklist keyed by agentId with static glyphs — no spinner, so reduced
 * motion is a code obligation, not a CSS afterthought. Surface-specific bits are props: the per-agent
 * `label`, the copy, and the optional Stop escape hatch. Renders inner content only; the caller wraps
 * it in a card. Chrome tokens only — never imports from `src/render/**`.
 */
import type { CSSProperties, ReactNode } from "react";
import type { AgentStatus, Checklist } from "@/lib/sse";
import { buttonStyle } from "./Button";

const mono = { fontFamily: "var(--mono)" } as const;

const statusGlyph = (s?: AgentStatus): string => (s === "done" ? "✓" : s === "failed" ? "—" : "…");

// The Stop hatch is a mobile-reachable escape control, so it keeps a 44px tap target by default
// (AGENTS §7); a surface can override `cancelStyle` to match its own button language exactly.
const defaultCancelStyle: CSSProperties = { ...buttonStyle("ghost"), minHeight: 44 };

export function AgentChecklist({
  checklist,
  statusLine,
  label,
  busyLabel = "Working…",
  footnote,
  onCancel,
  cancelLabel = "Stop",
  cancelStyle = defaultCancelStyle,
}: {
  checklist: Checklist;
  statusLine: string;
  /** Owner-facing label for an agentId (each surface maps its own ids). */
  label: (agentId: string) => string;
  /** Shown in the live region before the first status sentence arrives. */
  busyLabel?: string;
  footnote?: ReactNode;
  /** When present, a Stop button appears once the stream is live (≥1 agent event). */
  onCancel?: () => void;
  cancelLabel?: string;
  cancelStyle?: CSSProperties;
}) {
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        style={{ ...mono, fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}
      >
        {statusLine || busyLabel}
      </div>
      {checklist.order.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "12px 0 0",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {checklist.order.map((id) => (
            <li key={id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
              <span aria-hidden style={{ ...mono, color: "var(--text-3)", width: "1em" }}>
                {statusGlyph(checklist.status[id])}
              </span>
              <span style={{ color: "var(--text)" }}>{label(id)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {footnote ? (
        <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
          {footnote}
        </p>
      ) : null}
      {onCancel && checklist.order.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={onCancel} style={cancelStyle}>
            {cancelLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}
