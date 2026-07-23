/**
 * The single source of review-agent identity + verdict colours, verbatim from the Claude design
 * (`docs/design/Contender.dc.html` — the `REV` map) and `docs/architecture/design-system.md`.
 * Every surface that shows an agent badge / colour / name, or a Gatekeeper decision, reads from here —
 * never re-declare the map. Chrome tokens only (`var(--rv-*)` / `var(--ok|warn|bad)`); the machine
 * guard in `scripts/check-invariants.mjs` forbids ad-hoc colour literals in `src/app` + `src/ui`.
 */
import type { Schemas } from "@/lib/api/client";

export type AgentKey = "parser" | "tailor" | "editor" | "fact" | "spotter" | "gate" | "agent";

export interface AgentIdentity {
  key: AgentKey;
  /** Owner-facing name. */
  name: string;
  /** Two-character badge glyph. */
  glyph: string;
  /** Identity colour — a chrome token, never a literal. */
  color: string;
  /** Badge glyph ink — a theme-aware token chain (per-agent override → theme default), WCAG-AA on the
   *  identity colour in both themes (see globals.css `--agent-ink` / `--ink-*`). */
  ink: string;
  /** One-line description of what the agent does. */
  role: string;
}

const ink = (key: string): string => `var(--ink-${key}, var(--agent-ink))`;

export const AGENT_IDENTITY: Record<AgentKey, AgentIdentity> = {
  parser: {
    key: "parser",
    name: "Parser",
    glyph: "Pr",
    color: "var(--rv-parser)",
    ink: ink("parser"),
    role: "Reads the posting",
  },
  tailor: {
    key: "tailor",
    name: "Tailor",
    glyph: "Ta",
    color: "var(--rv-tailor)",
    ink: ink("tailor"),
    role: "Rewrites to match",
  },
  editor: {
    key: "editor",
    name: "Editor",
    glyph: "Ed",
    color: "var(--rv-editor)",
    ink: ink("editor"),
    role: "Clarity & concision",
  },
  fact: {
    key: "fact",
    name: "Fact-Checker",
    glyph: "Fc",
    color: "var(--rv-fact)",
    ink: ink("fact"),
    role: "Flags overstatement",
  },
  spotter: {
    key: "spotter",
    name: "AI-Language Spotter",
    glyph: "Sp",
    color: "var(--rv-spotter)",
    ink: ink("spotter"),
    role: "Flags generic phrasing",
  },
  gate: {
    key: "gate",
    name: "Gatekeeper",
    glyph: "Gk",
    color: "var(--rv-gate)",
    ink: ink("gate"),
    role: "Recruiter / ATS verdict",
  },
  agent: {
    // The neutral fallback identity for an unrecognized agent/source key (the human-reviewer
    // identity was retired with the single-user pivot).
    key: "agent",
    name: "Agent",
    glyph: "Ag",
    color: "var(--accent)",
    ink: ink("agent"),
    role: "Review agent",
  },
};

/**
 * The codebase has three key spaces for the same agents: the design ids (above), the review-source
 * space (`Thread.source` / `ReviewSource` = editor | factCheck | spotter | gatekeeper), and the
 * backend SSE Agent.id space (editor | fact-checker | spotter | gatekeeper). Map any of them to one
 * identity so callers never branch.
 */
const TO_AGENT: Record<string, AgentKey> = {
  parser: "parser",
  tailor: "tailor",
  editor: "editor",
  fact: "fact",
  factCheck: "fact",
  "fact-checker": "fact",
  spotter: "spotter",
  gate: "gate",
  gatekeeper: "gate",
  agent: "agent",
};

/** Resolve any agent / review-source / SSE-id key to its canonical identity. Falls back to the
 *  neutral `agent`. */
export const agentIdentity = (key: string): AgentIdentity =>
  AGENT_IDENTITY[TO_AGENT[key] ?? "agent"];

/** Gatekeeper decision → semantic colour + owner-facing label. */
export const DECISION_META: Record<Schemas["Decision"], { label: string; color: string }> = {
  pass: { label: "Likely pass", color: "var(--ok)" },
  borderline: { label: "Borderline", color: "var(--warn)" },
  reject: { label: "Likely reject", color: "var(--bad)" },
};
