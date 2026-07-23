import { describe, expect, it } from "vitest";
import { detectSlop } from "./heuristics";

describe("detectSlop", () => {
  it("flags the antithesis cliché", () => {
    const flags = detectSlop([
      { anchorId: "summary", text: "This isn't just a role, it's a calling." },
    ]);
    expect(flags.some((f) => f.type === "not-just-construction")).toBe(true);
  });

  it("flags overused lexicon", () => {
    const flags = detectSlop([
      { anchorId: "b1", text: "Spearheaded a robust, cutting-edge platform." },
    ]);
    expect(flags.filter((f) => f.type === "overused-word").length).toBeGreaterThanOrEqual(2);
  });

  it("leaves clean CV prose alone", () => {
    const flags = detectSlop([
      { anchorId: "b1", text: "Led migration of 40 EDI partners to the new platform." },
    ]);
    expect(flags.length).toBe(0);
  });

  it("anchors every flag to the segment's stable id", () => {
    const flags = detectSlop([{ anchorId: "b7", text: "Leverage synergy and holistic tapestry." }]);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.anchorId === "b7")).toBe(true);
  });
});
