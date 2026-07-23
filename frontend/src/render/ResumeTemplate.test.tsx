/**
 * Renderer determinism + provenance/anchoring contract (invariant 3 + 7). The PDF byte-stability
 * and preview==PDF parity are verified separately via Playwright MCP (not the node gate); here we
 * lock the parts that ARE byte-stable in node: the view-model, the template markup, and ats-text.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { components } from "@/lib/api/generated-types";
import { renderResumeDocx } from "./docx-mapper";
import { sampleRenderInput } from "./fixtures";
import { toResumeDocument } from "./model";
import { ResumeTemplate } from "./ResumeTemplate";
import { toAtsText } from "./text-mapper";

type MasterProfile = components["schemas"]["MasterProfile"];
type TailoredCV = components["schemas"]["TailoredCV"];
type WorkEntry = components["schemas"]["WorkEntry"];
type EducationEntry = components["schemas"]["EducationEntry"];
type TailoredSection = components["schemas"]["TailoredSection"];

const doc = toResumeDocument(sampleRenderInput);

describe("toResumeDocument", () => {
  it("composes the header from master basics", () => {
    expect(doc.header.name).toBe("Sample Candidate");
    expect(doc.header.title).toBe("Senior Integration Engineer");
    expect(doc.header.location).toBe("Example City, Example Region");
  });

  it("joins dates from the master profile by sourceId", () => {
    const exp = doc.sections.find((s) => s.kind === "experience");
    expect(exp?.kind).toBe("experience");
    if (exp?.kind !== "experience") return;
    expect(exp.items[0]?.dates).toBe("2021 – Present");
    expect(exp.items[1]?.dates).toBe("2018 – 2021");
  });

  it("falls back to master skills when the skills section has no tailored items", () => {
    const skills = doc.sections.find((s) => s.kind === "skills");
    expect(skills?.kind === "skills" ? skills.skills : []).toContain("Python");
  });

  it("preserves the net-new bullet that needs sign-off", () => {
    const exp = doc.sections.find((s) => s.kind === "experience");
    if (exp?.kind !== "experience") throw new Error("no experience section");
    const netNew = exp.items.flatMap((i) => i.bullets).find((b) => b.id === "b-acme-netnew");
    expect(netNew?.origin).toBe("net-new");
    expect(netNew?.needsSignoff).toBe(true);
  });
});

describe("ResumeTemplate markup", () => {
  it("is byte-identical for identical input", () => {
    expect(renderToStaticMarkup(<ResumeTemplate doc={doc} />)).toBe(
      renderToStaticMarkup(<ResumeTemplate doc={doc} />),
    );
  });

  it("anchors every bullet by a stable data-bullet-id", () => {
    const html = renderToStaticMarkup(<ResumeTemplate doc={doc} />);
    expect(html).toContain('data-bullet-id="b-acme-edi"');
    expect(html).toContain('data-bullet-id="b-acme-netnew"');
  });

  // In-paper editing (DevPR14) is OPTIONAL + preview-only. The render/export path (/print, pdf/docx/
  // text) never passes `editableBulletIds`, so the off state must be byte-identical to before — no
  // `contenteditable` attribute anywhere — or exports would drift (invariant 3). The real preview==PDF
  // parity is the Playwright + `next build` check; this locks the node-stable half.
  it("emits NO contentEditable in the off (export) state — byte-identical export (invariant 3)", () => {
    const html = renderToStaticMarkup(<ResumeTemplate doc={doc} />);
    expect(/contenteditable/i.test(html)).toBe(false); // case-insensitive: React emits it camelCase
    // The same render with an EMPTY editable set is still off (nothing to edit) → still no attribute.
    expect(renderToStaticMarkup(<ResumeTemplate doc={doc} editableBulletIds={new Set()} />)).toBe(
      html,
    );
  });

  it("makes ONLY the named bullets contentEditable in the preview (editable) state", () => {
    const one = renderToStaticMarkup(
      <ResumeTemplate doc={doc} editableBulletIds={new Set(["b-acme-edi"])} />,
    );
    // Exactly the one named bullet becomes editable — nothing else (count is order-independent; the
    // prop only ever resolves to `true`/absent, so any contentEditable occurrence is an editable one).
    expect((one.match(/contenteditable/gi) ?? []).length).toBe(1);
    // A two-bullet set yields exactly two — the attribute is strictly per-bullet from the set.
    const two = renderToStaticMarkup(
      <ResumeTemplate doc={doc} editableBulletIds={new Set(["b-acme-edi", "b-acme-netnew"])} />,
    );
    expect((two.match(/contenteditable/gi) ?? []).length).toBe(2);
  });
});

describe("ats-text", () => {
  it("is deterministic, single-column, and recruiter-readable", () => {
    expect(toAtsText(doc)).toBe(toAtsText(doc));
    const text = toAtsText(doc);
    expect(text).toContain("EXPERIENCE");
    expect(text).toContain("- Led migration of 40 EDI partners");
    expect(text).toContain("Python, TypeScript");
  });
});

describe("docx", () => {
  it("builds a valid, non-empty .docx (zip)", async () => {
    const buf = await renderResumeDocx(doc);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK"); // zip magic
  });
});

// D2b — Languages are MASTER facts (not tailored), appended as a section from master.languages in
// AUTHORED order (like skills, never date-sorted), present across all four outputs with the SAME
// per-entry text ("name — fluency") so preview == PDF == DOCX == ats-text (invariant 3).
describe("languages (D2b)", () => {
  it("appends a Languages section from the master in authored order, last", () => {
    const langs = doc.sections.find((s) => s.kind === "languages");
    expect(langs?.kind).toBe("languages");
    if (langs?.kind !== "languages") return;
    expect(langs.languages.map((l) => l.name)).toEqual(["English", "French", "German"]);
    expect(doc.sections[doc.sections.length - 1]?.kind).toBe("languages"); // appended after cv sections
  });

  it("renders language chips on the paper as 'name — fluency'", () => {
    const html = renderToStaticMarkup(<ResumeTemplate doc={doc} />);
    expect(html).toContain("Languages");
    expect(html).toContain("English — Native");
    expect(html).toContain("German — Professional working");
  });

  it("emits the languages line in ats-text and a valid docx", async () => {
    const text = toAtsText(doc);
    expect(text).toContain("LANGUAGES");
    expect(text).toContain("English — Native, French — Native, German — Professional working");
    const buf = await renderResumeDocx(doc); // languages don't break the explicit per-kind branch
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("omits the Languages section entirely when the master has none", () => {
    const none = toResumeDocument({
      master: { ...sampleRenderInput.master, languages: [] },
      cv: sampleRenderInput.cv,
    });
    expect(none.sections.some((s) => s.kind === "languages")).toBe(false);
    expect(toAtsText(none)).not.toContain("LANGUAGES");
  });

  it("derives a unique sectionId when a tailored section already claims 'languages'", () => {
    // `section_id` is free-form, so guard against a collision that would give ResumeTemplate two
    // sections with the same React key.
    const cv2 = {
      ...sampleRenderInput.cv,
      sections: sampleRenderInput.cv.sections.map((s, i) =>
        i === 0 ? { ...s, sectionId: "languages" } : s,
      ),
    };
    const d = toResumeDocument({ master: sampleRenderInput.master, cv: cv2 });
    const ids = d.sections.map((s) => s.sectionId);
    expect(new Set(ids).size).toBe(ids.length); // all section ids unique
    expect(d.sections.find((s) => s.kind === "languages")?.sectionId).toBe("languages-");
  });

  it("survives a master with no languages key (deploy-skew: old backend payload)", () => {
    // A cross-service deploy can briefly serve a master from an old backend lacking `languages`;
    // the render must not throw on `.length` (Codex P2). Strip the key to simulate that payload.
    const { languages: _omit, ...noLangMaster } = sampleRenderInput.master;
    const d = toResumeDocument({
      master: noLangMaster as typeof sampleRenderInput.master,
      cv: sampleRenderInput.cv,
    });
    expect(d.sections.some((s) => s.kind === "languages")).toBe(false);
    expect(() => toAtsText(d)).not.toThrow();
  });

  it("renders a language with no fluency as just the name (no ' — ') across outputs", () => {
    const doc2 = toResumeDocument({
      master: { ...sampleRenderInput.master, languages: [{ language: "Italian", fluency: null }] },
      cv: sampleRenderInput.cv,
    });
    const html = renderToStaticMarkup(<ResumeTemplate doc={doc2} />);
    expect(html).toContain("Italian");
    expect(html).not.toContain("Italian —"); // the no-fluency branch: bare name, no dangling em-dash
    const text = toAtsText(doc2);
    expect(text).toContain("LANGUAGES\nItalian");
    expect(text).not.toContain("Italian —");
  });
});

// The relaxed master schema lets `label` (title) + `summary` be empty. The renderer must drop them
// cleanly — no empty italic title line, no padded blank summary block, no stray text-export blank —
// so preview == PDF == DOCX == text (invariant 3) for a sparse import. (`margin-top:5px` is the
// title div's unique signature; `data-line="summary"` the summary wrapper's.)
describe("empty optional basics (relaxed schema)", () => {
  const bare = { ...doc, header: { ...doc.header, title: "" }, summary: "" };
  const normalHtml = renderToStaticMarkup(<ResumeTemplate doc={doc} />);
  const bareHtml = renderToStaticMarkup(<ResumeTemplate doc={bare} />);

  it("renders no empty title or summary block when both are absent", () => {
    expect(normalHtml).toContain("margin-top:5px"); // title present in the populated doc
    expect(normalHtml).toContain('data-line="summary"');
    expect(bareHtml).not.toContain("margin-top:5px"); // no empty italic title line
    expect(bareHtml).not.toContain('data-line="summary"'); // no padded blank summary block
  });

  it("ats-text drops the summary with no stray blank lines", () => {
    const text = toAtsText(bare);
    expect(text).not.toContain(doc.summary); // the populated summary text is gone
    expect(text).not.toContain("\n\n\n"); // no double-blank where the summary used to be
    expect(text).toContain("EXPERIENCE"); // sections still render
  });
});

// D1 — Work + Education render reverse-chronologically (most recent first); Projects keep their
// authored order. The sort lives in model.ts (the single ResumeDocument all four outputs derive
// from), is Date-free + deterministic (invariant 3), and tiebreaks on the original index. These
// fixtures are deliberately authored OUT of order to prove the sort; the parity assertions confirm
// it flows through the template markup and ats-text (and, off the same ordered ResumeDocument, DOCX).
const wk = (id: string, position: string, startDate: string, endDate?: string): WorkEntry => ({
  id,
  company: `${id}-co`,
  position,
  startDate,
  endDate,
  highlights: [],
  tags: [],
});
const ed = (
  id: string,
  studyType: string,
  area: string,
  startDate: string,
  endDate?: string,
): EducationEntry => ({ id, institution: `${id}-uni`, area, studyType, startDate, endDate });
const sec = (
  sectionId: string,
  type: TailoredSection["type"],
  sourceIds: string[],
): TailoredSection => ({
  sectionId,
  type,
  items: sourceIds.map((sourceId) => ({
    itemId: `i-${sourceId}`,
    sourceId,
    position: null,
    company: null,
    highlights: [],
  })),
});

const orderingMaster: MasterProfile = {
  schemaVersion: "1",
  basics: {
    name: "Order Test",
    email: "o@example.com",
    label: "",
    phone: "",
    url: null,
    location: { city: "", region: "", countryCode: "" },
    profiles: [],
    summary: "",
  },
  work: [
    wk("w-now", "Current Lead", "2022"), // no endDate ⇒ ongoing ⇒ most recent
    wk("w-2022", "Recent Eng", "2020", "2022"),
    wk("w-old", "Older A", "2018", "2019"),
    wk("w-tie", "Older B", "2018", "2019"), // identical start+end to w-old ⇒ original-index tiebreak
    wk("p-a", "Proj A", "2017", "2018"),
    wk("p-b", "Proj B", "2021", "2022"),
    wk("p-c", "Proj C", "2019", "2020"),
  ],
  education: [
    ed("e-2021", "MSc", "AI", "2019", "2021"),
    ed("e-2018", "BSc", "CS", "2014", "2018"),
    ed("e-2014", "HS", "Dipl", "2010", "2014"),
  ],
  skills: [],
  languages: [],
  certificates: null,
};
const orderingCv: TailoredCV = {
  jobSpecRef: "job",
  masterVersion: "1",
  version: 1,
  parentVersion: null,
  summary: "",
  sections: [
    sec("sec-work", "work", ["w-2022", "w-old", "w-now", "w-tie"]),
    sec("sec-edu", "education", ["e-2018", "e-2021", "e-2014"]),
    sec("sec-proj", "projects", ["p-a", "p-b", "p-c"]),
  ],
};
const orderingDoc = toResumeDocument({ master: orderingMaster, cv: orderingCv });

const itemIdsOf = (sectionId: string): string[] => {
  const s = orderingDoc.sections.find((x) => x.sectionId === sectionId);
  if (s?.kind === "experience") return s.items.map((it) => it.itemId);
  if (s?.kind === "education") return s.items.map((it) => it.itemId);
  return [];
};

// Render a Work-only CV from `entries` (the master rows) referenced in `authored` order, and return
// the rendered roles top-to-bottom — a compact harness for the date-parser + comparator edge cases.
const workRoles = (entries: WorkEntry[], authored: string[]): string[] => {
  const master: MasterProfile = { ...orderingMaster, work: entries };
  const cv: TailoredCV = { ...orderingCv, sections: [sec("sec-work", "work", authored)] };
  const d = toResumeDocument({ master, cv });
  const s = d.sections.find((x) => x.sectionId === "sec-work");
  return s?.kind === "experience" ? s.items.map((i) => i.role) : [];
};

describe("D1 reverse-chronological ordering", () => {
  it("orders Work most-recent-first: ongoing, then descending end-year", () => {
    // w-now (ongoing) → w-2022 (2022) → w-old/w-tie (both 2019, original order kept)
    expect(itemIdsOf("sec-work")).toEqual(["i-w-now", "i-w-2022", "i-w-old", "i-w-tie"]);
  });

  it("breaks ties on the original index (stable, deterministic)", () => {
    // w-old and w-tie share end-year 2019; the authored order (w-old before w-tie) is preserved.
    const ids = itemIdsOf("sec-work");
    expect(ids.indexOf("i-w-old")).toBeLessThan(ids.indexOf("i-w-tie"));
  });

  it("orders Education most-recent-first", () => {
    expect(itemIdsOf("sec-edu")).toEqual(["i-e-2021", "i-e-2018", "i-e-2014"]);
  });

  it("leaves Projects in their authored order (a curation, not a timeline)", () => {
    // p-b (2022) would float to the top if Projects were sorted — they must not be.
    expect(itemIdsOf("sec-proj")).toEqual(["i-p-a", "i-p-b", "i-p-c"]);
  });

  it("flows the ordering through ats-text (parity with the view-model)", () => {
    const ats = toAtsText(orderingDoc);
    expect(ats.indexOf("Current Lead")).toBeLessThan(ats.indexOf("Recent Eng"));
    expect(ats.indexOf("Recent Eng")).toBeLessThan(ats.indexOf("Older A"));
    expect(ats.indexOf("Older A")).toBeLessThan(ats.indexOf("Older B"));
    expect(ats.indexOf("MSc AI")).toBeLessThan(ats.indexOf("BSc CS"));
    expect(ats.indexOf("BSc CS")).toBeLessThan(ats.indexOf("HS Dipl"));
    // Projects keep authored order.
    expect(ats.indexOf("Proj A")).toBeLessThan(ats.indexOf("Proj B"));
    expect(ats.indexOf("Proj B")).toBeLessThan(ats.indexOf("Proj C"));
  });

  it("flows the ordering through the template markup (parity with the view-model)", () => {
    const html = renderToStaticMarkup(<ResumeTemplate doc={orderingDoc} />);
    expect(html.indexOf("Current Lead")).toBeLessThan(html.indexOf("Recent Eng"));
    expect(html.indexOf("Recent Eng")).toBeLessThan(html.indexOf("Older A"));
    expect(html.indexOf("MSc AI")).toBeLessThan(html.indexOf("BSc CS"));
  });

  it("builds a valid DOCX from the same ordered ResumeDocument", async () => {
    const buf = await renderResumeDocx(orderingDoc);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("parses the trailing year + month, treats a literal 'Present' as ongoing", () => {
    expect(
      workRoles(
        [
          wk("m-present", "Ongoing Now", "2020", "Present"), // literal Present ⇒ ongoing ⇒ first
          wk("m-jun", "June Role", "2019", "2021-06"),
          wk("m-jan", "Jan Role", "2019", "2021-01"),
          wk("m-bare", "Bare Role", "2019", "2021"), // unknown month sorts after the dated 2021s
        ],
        ["m-jan", "m-jun", "m-present", "m-bare"],
      ),
    ).toEqual(["Ongoing Now", "June Role", "Jan Role", "Bare Role"]);
  });

  it("parses ISO, slash, and month-name end dates equivalently", () => {
    // 2021-12 > 06/2021 > Mar 2021 — exercises the iso, slash, and name branches in one sort.
    expect(
      workRoles(
        [
          wk("a", "Name Mar", "2018", "Mar 2021"),
          wk("b", "Slash Jun", "2018", "06/2021"),
          wk("c", "Iso Dec", "2018", "2021-12"),
        ],
        ["a", "b", "c"],
      ),
    ).toEqual(["Iso Dec", "Slash Jun", "Name Mar"]);
  });

  it("treats an explicit ongoing marker as +∞ even when the string also carries a year", () => {
    // "2020 – Present" must outrank a later finite end date — the ongoing check precedes year parsing.
    expect(
      workRoles(
        [wk("q", "Dated 2023", "2019", "2023"), wk("p", "Year Present", "2019", "2020 – Present")],
        ["q", "p"],
      ),
    ).toEqual(["Year Present", "Dated 2023"]);
  });

  it("binds the month to the trailing year in a multi-date string", () => {
    // "Jan 2020 – Mar 2021" must rank as Mar 2021 (202103), not Jan (202101); else it sorts BELOW
    // a 2021-02 peer and the order flips — this locks the trailing-token binding.
    expect(
      workRoles(
        [
          wk("r", "Range RoleA", "2018", "Jan 2020 – Mar 2021"),
          wk("s", "Plain Feb", "2018", "2021-02"),
        ],
        ["r", "s"],
      ),
    ).toEqual(["Range RoleA", "Plain Feb"]);
  });

  it("collapses an ambiguous full numeric date (MM/DD vs DD/MM) to year-only", () => {
    // "03/04/2021": the day-vs-month order is unknowable, so month=0 (year-only). It must sort BELOW
    // a 2021-02 peer — if the parser wrongly read the middle token as month 4 (202104 > 202102), the
    // order would flip. Day ≤ 12 is the case that hides the bug, so it is the case under test.
    expect(
      workRoles(
        [wk("amb", "Ambiguous", "2018", "03/04/2021"), wk("feb", "Clear Feb", "2018", "2021-02")],
        ["amb", "feb"],
      ),
    ).toEqual(["Clear Feb", "Ambiguous"]);
  });

  it("sinks an unparseable end date below a dated peer", () => {
    expect(
      workRoles(
        [wk("g", "Garbage", "2018", "n/a"), wk("h", "Dated 2019", "2017", "2019")],
        ["g", "h"],
      ),
    ).toEqual(["Dated 2019", "Garbage"]);
  });

  it("breaks an equal-end-year tie by the more-recent start date", () => {
    // Both end 2020; the role that STARTED more recently (2019) ranks above the 2015 starter, even
    // though it is authored second — the start date is the secondary key, before the index tiebreak.
    expect(
      workRoles(
        [wk("x", "Older Start", "2015", "2020"), wk("y", "Newer Start", "2019", "2020")],
        ["x", "y"],
      ),
    ).toEqual(["Newer Start", "Older Start"]);
  });

  it("sinks a blank/unparseable start date in an equal-end tie (start is never 'ongoing')", () => {
    // Both end 2020. The role with a blank start must NOT float above the 2018 starter — an empty
    // START ranks oldest (-∞), unlike an empty END which is ongoing (+∞).
    expect(
      workRoles(
        [wk("blank", "Blank Start", "", "2020"), wk("dated", "Dated Start", "2018", "2020")],
        ["blank", "dated"],
      ),
    ).toEqual(["Dated Start", "Blank Start"]);
  });

  it("falls back to the original index only when start AND end are equal", () => {
    expect(
      workRoles(
        [wk("t1", "Tie One", "2018", "2020"), wk("t2", "Tie Two", "2018", "2020")],
        ["t1", "t2"],
      ),
    ).toEqual(["Tie One", "Tie Two"]);
  });

  it("sinks a dangling sourceId (no master entry) to the bottom, never the top", () => {
    const master: MasterProfile = {
      ...orderingMaster,
      work: [wk("real", "Real Role", "2017", "2019")],
    };
    const cv: TailoredCV = {
      ...orderingCv,
      sections: [sec("sec-work", "work", ["ghost", "real"])], // "ghost" resolves to no master row
    };
    const d = toResumeDocument({ master, cv });
    const s = d.sections.find((x) => x.sectionId === "sec-work");
    const ids = s?.kind === "experience" ? s.items.map((i) => i.itemId) : [];
    expect(ids).toEqual(["i-real", "i-ghost"]); // resolved role leads; the blank dangling item sinks
  });

  it("is deterministic — identical input yields identical order", () => {
    const a = toResumeDocument({ master: orderingMaster, cv: orderingCv });
    const b = toResumeDocument({ master: orderingMaster, cv: orderingCv });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
