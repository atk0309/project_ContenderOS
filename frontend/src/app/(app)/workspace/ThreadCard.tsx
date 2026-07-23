/**
 * One review thread. Shared by the per-agent ThreadList (panel, display-only) and the per-bullet
 * ReviewInlineBadge (editor). When `acceptable` (PR-4 — an editable, non-stale bullet thread that
 * isn't a *supported* fact-check) it renders Accept / Reject; otherwise the `suggestedRevision` is
 * advisory text. The accepted threads feed the "Apply corrections" Corrector call — the server
 * re-grounds + structurally guards, so nothing here reaches a document directly (invariant 1).
 */
import type { CSSProperties } from "react";
import type { Schemas } from "@/lib/api/client";
import { agentIdentity, tagStyle } from "@/ui";
import { anchorLabel, type ReviewSource, type ReviewThread, type ThreadDecision } from "./logic";

type TailoredCV = Schemas["TailoredCV"];
type FactVerdict = Schemas["FactVerdict"];

/** Per-source review-panel label; the colour comes from the canonical identity (`src/ui/colors.ts`). */
export const SOURCE_META: Record<ReviewSource, { label: string; color: string }> = {
  editor: { label: "Line edits", color: agentIdentity("editor").color },
  factCheck: { label: "Fact-check", color: agentIdentity("factCheck").color },
  spotter: { label: "Voice review", color: agentIdentity("spotter").color },
  gatekeeper: { label: "Recruiter", color: agentIdentity("gatekeeper").color },
};

const factVerdictColor = (v: FactVerdict): string =>
  v === "supported" ? "var(--ok)" : v === "overstated" ? "var(--warn)" : "var(--bad)";

const mono = { fontFamily: "var(--mono)" } as const;
const metaLabel: CSSProperties = { ...mono, fontSize: 10, color: "var(--text-3)" };
// The suggested rewrite reads in the document voice (serif), boxed like the ReviewNote.dc.html
// "SUGGESTED" block. Serif here is the third sanctioned serif site (design-system.md §Typography roles
// names CV paper + Gatekeeper impression + THIS review-note rewrite).
const suggestionBox: CSSProperties = {
  marginTop: 10,
  padding: "9px 11px",
  borderRadius: 7,
  background: "var(--panel)",
  border: "1px dashed var(--line)",
};
const suggestionText: CSSProperties = {
  margin: 0,
  fontFamily: "var(--serif)",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--text)",
};

// One note card, ported from docs/design/ReviewNote.dc.html (paper literals → chrome tokens): the
// AGENT colour rims the card + tints the header; the glyph badge + filled Accept take that colour.
const ctrlBtnBase: CSSProperties = {
  fontFamily: "var(--ui)",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 8,
  padding: "8px 10px",
  minHeight: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
};

export function ThreadCard({
  thread,
  cv,
  showAnchor,
  acceptable = false,
  decision,
  onDecide,
  disabled = false,
  hideActions = false,
}: {
  thread: ReviewThread;
  cv: TailoredCV;
  /** Panel-routed threads show their anchor label; inline threads sit next to their bullet already. */
  showAnchor: boolean;
  /** PR-4: a correctable bullet thread renders Accept / Reject. Defaults false (panel = read-only). */
  acceptable?: boolean;
  decision?: ThreadDecision;
  onDecide?: (key: string, d: ThreadDecision) => void;
  /** Disable the toggles while an apply is in flight (the CV is mid-rewrite). */
  disabled?: boolean;
  /** DevPR17: render the note CONTENT only (correct SUGGESTED label from `acceptable`) but skip the
   *  Accept/Dismiss row — the in-margin ReviewNote supplies its own action row. */
  hideActions?: boolean;
}) {
  const id = agentIdentity(thread.source);
  const label = SOURCE_META[thread.source].label;
  // The visible button text — also embedded verbatim at the START of each aria-label so the accessible
  // name CONTAINS the visible label (WCAG 2.5.3, "Label in Name"; speech-input users can say it).
  const acceptLabel =
    decision === "accepted"
      ? "✓ Accepted"
      : thread.suggestedRevision
        ? "Accept & fix"
        : "Accept — reword from this note";
  const dismissLabel = decision === "rejected" ? "Dismissed" : "Dismiss";
  return (
    <div
      style={{
        border: `1px solid ${id.color}`,
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--panel-2)",
        boxShadow: "0 12px 30px -16px rgba(0, 0, 0, 0.45)",
        fontFamily: "var(--ui)",
      }}
    >
      {/* Header: agent glyph badge + label, severity on the right as muted metadata (not colour-coded —
          a bright severity colour as small text fails AA + the rubric; the card border carries colour). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "9px 11px",
          background: `color-mix(in srgb, ${id.color} 16%, var(--panel-2))`,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 20,
            height: 20,
            flex: "none",
            borderRadius: 6,
            background: id.color,
            color: id.ink,
            ...mono,
            fontSize: 9,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {id.glyph}
        </span>
        {/* Name stays --text (not the mockup's agent-tinted ink) for WCAG-AA in both themes; the agent
            identity is already carried by the badge + card border. */}
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{label}</span>
        {/* --text-2 (not the mockup's faintest ink): severity is decision-relevant, and --text-3 on
            the agent-tinted header dips below WCAG-AA. A named AA divergence from the mockup. */}
        <span
          style={{
            marginLeft: "auto",
            ...mono,
            fontSize: 9,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: "var(--text-2)",
          }}
        >
          {thread.severity}
        </span>
      </div>

      <div style={{ padding: "11px 12px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Fact verdict / spotter flag — AA-safe tagStyle chips (label on --text, colour on border+fill). */}
        {thread.verdict || thread.flag ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {thread.verdict ? (
              <span style={{ ...tagStyle(factVerdictColor(thread.verdict)), fontSize: 10 }}>
                {thread.verdict}
              </span>
            ) : null}
            {thread.flag ? (
              <span style={{ ...tagStyle("var(--rv-spotter)"), fontSize: 10 }}>
                {thread.flag.replace(/-/g, " ")}
              </span>
            ) : null}
          </div>
        ) : null}

        {thread.claim ? (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-3)", lineHeight: 1.45 }}>
            <span style={metaLabel}>CLAIM</span> {thread.claim}
          </p>
        ) : null}

        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>
          {thread.comment}
        </p>

        {thread.suggestedRevision ? (
          <div style={suggestionBox}>
            <div
              style={{
                ...mono,
                fontSize: 9,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "var(--text-3)",
                marginBottom: 4,
              }}
            >
              SUGGESTED{acceptable ? "" : " — advisory"}
            </div>
            <p style={suggestionText}>{thread.suggestedRevision}</p>
          </div>
        ) : null}

        {acceptable && !hideActions ? (
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="cos-brighten"
              aria-pressed={decision === "accepted"}
              aria-label={`${acceptLabel} — correction on ${anchorLabel(thread, cv)}`}
              disabled={disabled}
              onClick={() => onDecide?.(thread.key, "accepted")}
              style={{
                ...ctrlBtnBase,
                flex: 1,
                background: id.color,
                color: id.ink,
                opacity: disabled ? 0.55 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {acceptLabel}
            </button>
            <button
              type="button"
              className="cos-ghostbtn"
              aria-pressed={decision === "rejected"}
              aria-label={`${dismissLabel} — this note on ${anchorLabel(thread, cv)}`}
              disabled={disabled}
              onClick={() => onDecide?.(thread.key, "rejected")}
              style={{
                ...ctrlBtnBase,
                fontWeight: 500,
                padding: "8px 12px",
                background: "transparent",
                color: "var(--text-2)",
                border: "1px solid var(--line)",
                opacity: disabled ? 0.55 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {dismissLabel}
            </button>
          </div>
        ) : null}

        {/* The master-bullet source is what a fact-check is verified against — keep it visible even on an
            inline card (where the anchor label is omitted) so an inline supported/overstated note still
            shows what it's traced to (Codex). */}
        {thread.sourceId ? <div style={metaLabel}>Source: {thread.sourceId}</div> : null}
        {showAnchor ? <div style={metaLabel}>On: {anchorLabel(thread, cv)}</div> : null}
      </div>
    </div>
  );
}
