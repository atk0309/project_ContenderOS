// Workspace-local style atoms shared across the split-out preview/editor/review components. Lifted
// verbatim out of page.tsx so the sibling components can import them without re-declaring (or a
// circular page import). Tokens-only colours — these are existing styles, moved unchanged.

export const mono = { fontFamily: "var(--mono)" } as const;

export const bulletBox = {
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: "10px 10px 8px",
  background: "var(--panel-2)",
} as const;

// The bespoke editor / job-posting textarea (lineHeight + vertical resize) — distinct from the shared
// @/ui inputStyle. Spread + overridden at a couple of call-sites (minHeight / fontSize).
export const editorTextarea = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: 9,
  border: "1px solid var(--line-strong)",
  background: "var(--panel-2)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "var(--ui)",
  lineHeight: 1.5,
  resize: "vertical",
  boxSizing: "border-box",
} as const;

// Visually-hidden but screen-reader-audible (mirrors the ingest screen's srOnly).
export const srOnly = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;
