/**
 * Shared visual constants for the CV document, ported from the Claude Design handoff
 * (Contender.dc.html — the 660px "paper" surface). ResumeTemplate (live preview + the printed
 * PDF) and docx-mapper both consume these, so the three render targets stay in lockstep
 * (invariant 3: one template). Values are concrete (no CSS vars for colour/size) so they render
 * identically in the browser, in Playwright print, in a jsdom snapshot, and in the DOCX model.
 * Font *families* bind to the next/font CSS variables so the self-hosted faces apply everywhere.
 */

/** The cream "paper" palette — deliberately distinct from the dark app chrome. */
export const PAPER = {
  bg: "#faf8f3",
  bg2: "#f1eee6",
  ink: "#1b1c1e",
  ink2: "#55514a",
  ink3: "#8a857b",
  rule: "#e0dccf",
} as const;

/** Web font stacks (bound to next/font variables in src/lib/fonts.ts). */
export const FONT = {
  ui: "var(--font-archivo), system-ui, sans-serif",
  mono: "var(--font-plex-mono), ui-monospace, monospace",
  serif: "var(--font-source-serif), Georgia, serif",
} as const;

/** Bare family names for DOCX (which can't read CSS variables). */
export const DOCX_FONT = {
  ui: "Archivo",
  mono: "IBM Plex Mono",
  serif: "Source Serif 4",
} as const;

/** Type scale in px (web). DOCX converts: pt = px * 0.75; docx half-points = px * 1.5. */
export const SIZE = {
  name: 30,
  title: 14.5,
  contact: 10.5,
  summary: 15,
  sectionTitle: 11,
  role: 15,
  dates: 10.5,
  org: 13,
  bullet: 13.5,
  skill: 12.5,
  eduRole: 14,
} as const;

/** Page geometry — the design's reading measure, sized for A4 print. */
export const PAGE = {
  maxWidthPx: 660,
  padTopPx: 48,
  padXPx: 52,
  padBottomPx: 56,
} as const;

/** px → DOCX half-points (docx sizes are in half-points). */
export const docxHalfPoints = (px: number): number => Math.round(px * 1.5);
