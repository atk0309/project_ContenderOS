/**
 * Deterministic AI-language detector — runs on every keystroke for free, no model call.
 * The model pass (Spotter agent, backend) only handles what regex can't: tonal blandness,
 * faux-confidence, individually-clean-but-generic phrasing.
 *
 * CV-aware: action-verb openers (Led, Built, Shipped) are legitimate CV style and are NOT
 * flagged. We flag the LLM *tells*, not normal résumé conventions.
 *
 * Anchored by stable id (`anchorId` — a bulletId/itemId/sectionId), never an array index, so a
 * flag tracks its bullet through edits and Corrector reorders (see ADR 0003).
 */

export type SlopFlag = {
  anchorId: string;
  type:
    | "overused-word"
    | "em-dash-density"
    | "not-just-construction"
    | "adverb-opener"
    | "low-variance"
    | "tricolon-stacking";
  severity: "info" | "minor" | "major";
  evidence: string;
};

// The usual LLM tells + CV clichés. Tune freely.
const OVERUSED = [
  "delve",
  "leverage",
  "robust",
  "tapestry",
  "underscore",
  "showcase",
  "seamless",
  "seamlessly",
  "cutting-edge",
  "game-changer",
  "synergy",
  "holistic",
  "spearheaded",
  "passionate",
  "results-driven",
  "detail-oriented",
  "dynamic",
];

const ADVERB_OPENERS = ["successfully", "effectively", "efficiently", "proactively"];

const wordCount = (t: string): number => (t.match(/\b\w+\b/g) ?? []).length;
const sentences = (t: string): string[] => t.split(/(?<=[.!?])\s+/).filter(Boolean);

export function detectSlop(segments: { anchorId: string; text: string }[]): SlopFlag[] {
  const flags: SlopFlag[] = [];

  for (const { anchorId, text } of segments) {
    const lower = text.toLowerCase();
    const words = Math.max(wordCount(text), 1);

    // 1. Overused lexicon
    for (const w of OVERUSED) {
      if (new RegExp(`\\b${w}\\b`, "i").test(text)) {
        flags.push({ anchorId, type: "overused-word", severity: "minor", evidence: w });
      }
    }

    // 2. Em-dash density (> ~1 per 40 words reads machine-set)
    const emDashes = (text.match(/—/g) ?? []).length;
    if (emDashes / words > 1 / 40) {
      flags.push({
        anchorId,
        type: "em-dash-density",
        severity: "minor",
        evidence: `${emDashes} em-dashes in ${words} words`,
      });
    }

    // 3. "Not just X, it's Y" / "not only ... but also" — incl. contractions ("isn't just … it's").
    const antithesis = /\b(?:not|[a-z]+n['’]t)\s+just\b.*\b(?:it['’]?s|but)\b/i;
    if (antithesis.test(text) || /\bnot only\b.*\bbut also\b/i.test(lower)) {
      flags.push({
        anchorId,
        type: "not-just-construction",
        severity: "major",
        evidence: 'antithesis cliché ("not just X, but Y")',
      });
    }

    // 4. Adverb openers ("Successfully delivered ...")
    for (const a of ADVERB_OPENERS) {
      if (new RegExp(`(^|\\.\\s+)${a}\\b`, "i").test(text)) {
        flags.push({ anchorId, type: "adverb-opener", severity: "info", evidence: a });
      }
    }

    // 5. Low sentence-length variance across a multi-sentence block (robotic uniformity)
    const lens = sentences(text).map(wordCount);
    if (lens.length >= 3) {
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
      if (variance < 4 && mean > 8) {
        flags.push({
          anchorId,
          type: "low-variance",
          severity: "info",
          evidence: `uniform sentence lengths (variance ${variance.toFixed(1)})`,
        });
      }
    }

    // 6. Tricolon stacking ("X, Y, and Z" rule-of-three overuse)
    const tricolons = (text.match(/\b\w+,\s+\w+,?\s+and\s+\w+/g) ?? []).length;
    if (tricolons >= 2) {
      flags.push({
        anchorId,
        type: "tricolon-stacking",
        severity: "minor",
        evidence: `${tricolons} rule-of-three lists`,
      });
    }
  }

  return flags;
}
