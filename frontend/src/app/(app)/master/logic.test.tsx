import { describe, expect, it } from "vitest";
import { sampleRenderInput } from "@/render/fixtures";
import {
  addLanguageFromInput,
  addSkillFromInput,
  chipLabel,
  contactParts,
  draftFromMaster,
  educationSummary,
  emptyDraft,
  firstInvalidEntry,
  getMasterRequest,
  type MasterDraft,
  newId,
  putMasterRequest,
  type SkillDraft,
  toMaster,
} from "./logic";

const filledBasics = (): MasterDraft => ({
  ...emptyDraft(),
  name: "Ada Lovelace",
  label: "Engineer",
  email: "ada@example.com",
  phone: "+44 000",
  city: "London",
  region: "England",
  countryCode: "GB",
  summary: "Builds things.",
});

describe("draftFromMaster orders work + education reverse-chronologically (D1b)", () => {
  // The editor must show roles in the SAME order as the rendered CV (sort-on-load), regardless of the
  // stored order — so a freshly imported / hand-stored master reads top-down most-recent-first.
  const master: (typeof sampleRenderInput)["master"] = {
    ...sampleRenderInput.master,
    work: [
      {
        id: "old",
        company: "C",
        position: "Old",
        startDate: "2016",
        endDate: "2019",
        highlights: [],
        tags: [],
      },
      {
        id: "now",
        company: "C",
        position: "Now",
        startDate: "2022",
        endDate: undefined,
        highlights: [],
        tags: [],
      },
      {
        id: "mid",
        company: "C",
        position: "Mid",
        startDate: "2019",
        endDate: "2022",
        highlights: [],
        tags: [],
      },
    ],
    education: [
      {
        id: "bsc",
        institution: "U",
        area: "CS",
        studyType: "BSc",
        startDate: "2012",
        endDate: "2016",
      },
      {
        id: "msc",
        institution: "U",
        area: "ML",
        studyType: "MSc",
        startDate: "2018",
        endDate: "2020",
      },
    ],
  };

  it("orders work most-recent-first (ongoing, then descending end-year)", () => {
    expect(draftFromMaster(master).work.map((w) => w.id)).toEqual(["now", "mid", "old"]);
  });

  it("orders education most-recent-first", () => {
    expect(draftFromMaster(master).education.map((e) => e.id)).toEqual(["msc", "bsc"]);
  });
});

describe("contactParts (profile-preview header)", () => {
  it("joins location and drops blank fields, in order, with a stable kind", () => {
    expect(contactParts(filledBasics())).toEqual([
      { kind: "location", value: "London, England, GB" },
      { kind: "email", value: "ada@example.com" },
      { kind: "phone", value: "+44 000" },
    ]);
  });
  it("returns [] for an empty draft", () => {
    expect(contactParts(emptyDraft())).toEqual([]);
  });
  it("includes the website when present and partial locations", () => {
    expect(
      contactParts({ ...emptyDraft(), city: "Berlin", url: "https://example.test/profile" }),
    ).toEqual([
      { kind: "location", value: "Berlin" },
      { kind: "website", value: "https://example.test/profile" },
    ]);
  });
});

describe("request builders", () => {
  it("targets the workspace-scoped master path", () => {
    expect(getMasterRequest().path).toBe("/workspaces/default/master");
    const result = toMaster(filledBasics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const put = putMasterRequest(result.master);
    expect(put.path).toBe("/workspaces/default/master");
    expect(put.init?.method).toBe("PUT");
  });
});

describe("draftFromMaster <-> toMaster round-trip", () => {
  it("preserves the sample master byte-for-byte through a round-trip", () => {
    // The sample work is intentionally already reverse-chronological (2021–present, then 2018–2021)
    // and education is a single entry, so D1b's sort-on-load is a no-op here and the round-trip stays
    // identity. (Sort-on-load + save does rewrite a non-sorted stored order — harmless: render sorts.)
    const result = toMaster(draftFromMaster(sampleRenderInput.master));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // JSON round-trip both sides so `undefined` vs omitted keys compare equal.
    expect(JSON.parse(JSON.stringify(result.master))).toEqual(
      JSON.parse(JSON.stringify(sampleRenderInput.master)),
    );
  });

  it("keeps stable work/highlight ids unchanged (provenance anchors)", () => {
    const draft = draftFromMaster(sampleRenderInput.master);
    expect(draft.work[0]?.id).toBe("acme-integration-lead");
    expect(draft.work[0]?.highlights[0]?.id).toBe("acme-edi");
  });
});

describe("toMaster validation + normalization", () => {
  it("requires only name + email; the recommended basics no longer block", () => {
    const result = toMaster(emptyDraft());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Name is required");
    expect(result.errors).toContain("Email is required");
    // Headline / phone / location / summary are recommended now — not required-field errors.
    expect(result.errors).not.toContain("Summary is required");
    expect(result.errors).not.toContain("Headline is required");
    expect(result.errors).not.toContain("City is required");
  });

  it("accepts a name+email-only draft; recommended basics default empty", () => {
    const result = toMaster({ ...emptyDraft(), name: "Jane", email: "jane@example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.master.basics.label).toBe("");
    expect(result.master.basics.summary).toBe("");
    expect(result.master.basics.location).toEqual({ city: "", region: "", countryCode: "" });
  });

  it("trims scalars and splits comma-separated tags/keywords", () => {
    const draft: MasterDraft = {
      ...filledBasics(),
      work: [
        {
          id: newId(),
          company: "  Acme  ",
          position: "Lead",
          startDate: "2020",
          endDate: "",
          highlights: [{ id: newId(), text: "  Shipped a thing.  " }],
          tags: "edi, api ,  ",
        },
      ],
      skills: [{ uid: newId(), name: "Python", level: "", keywords: "web, async" }],
    };
    const result = toMaster(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.master.work[0]?.company).toBe("Acme");
    expect(result.master.work[0]?.endDate).toBeUndefined();
    expect(result.master.work[0]?.tags).toEqual(["edi", "api"]);
    expect(result.master.work[0]?.highlights[0]?.text).toBe("Shipped a thing.");
    expect(result.master.skills[0]?.keywords).toEqual(["web", "async"]);
    expect(result.master.skills[0]?.level).toBeUndefined(); // blank level omitted
  });

  it("preserves a skill level through the round-trip (not just on save)", () => {
    const master = draftFromMaster({
      ...sampleRenderInput.master,
      skills: [{ name: "Python", level: "Expert", keywords: ["async"] }],
    });
    expect(master.skills[0]?.level).toBe("Expert"); // carried into the form draft
    const result = toMaster(master);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.master.skills[0]?.level).toBe("Expert"); // and back out on save
  });

  it("preserves certificates verbatim even though they aren't edited", () => {
    const certs = [{ name: "AWS SA", issuer: "Amazon", date: "2023" }];
    const result = toMaster({ ...filledBasics(), certificates: certs });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.master.certificates).toEqual(certs);
  });

  it("validates + normalizes editable languages: trims the name, omits a blank fluency (D2b)", () => {
    const result = toMaster({
      ...filledBasics(),
      languages: [
        { uid: "a", language: "  English  ", fluency: "Native" },
        { uid: "b", language: "German", fluency: "  " }, // blank fluency → omitted
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.master.languages).toEqual([
      { language: "English", fluency: "Native" },
      { language: "German", fluency: undefined },
    ]);
  });

  it("requires a non-blank language name, like a skill name (D2b)", () => {
    const result = toMaster({
      ...filledBasics(),
      languages: [{ uid: "a", language: "  ", fluency: "Native" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Language #1 name is required");
  });

  it("carries languages into the draft with a client uid; null fluency → '' (D2b)", () => {
    const draft = draftFromMaster({
      ...sampleRenderInput.master,
      languages: [
        { language: "French", fluency: "C1" },
        { language: "Spanish", fluency: null },
      ],
    });
    expect(draft.languages.map((l) => ({ language: l.language, fluency: l.fluency }))).toEqual([
      { language: "French", fluency: "C1" },
      { language: "Spanish", fluency: "" },
    ]);
    expect(draft.languages.every((l) => typeof l.uid === "string" && l.uid.length > 0)).toBe(true);
  });
});

describe("newId", () => {
  it("never contains the ':' namespacing delimiter or whitespace", () => {
    for (let i = 0; i < 20; i++) {
      const id = newId();
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("addSkillFromInput / addLanguageFromInput (chip clouds)", () => {
  const skill = (name: string, extra: Partial<SkillDraft> = {}): SkillDraft => ({
    uid: name,
    name,
    level: "",
    keywords: "",
    ...extra,
  });

  it("trims the input and appends a new skill row with a fresh client key", () => {
    const next = addSkillFromInput([], "  Rust  ");
    expect(next).not.toBeNull();
    expect(next?.map((s) => s.name)).toEqual(["Rust"]);
    expect(next?.[0]?.uid).toBeTruthy();
  });

  it("rejects a case-insensitive duplicate name (returns null)", () => {
    expect(addSkillFromInput([skill("Python")], "python")).toBeNull();
    expect(addSkillFromInput([skill("Python")], "  PYTHON ")).toBeNull();
  });

  it("treats a blank / whitespace-only input as a no-op (returns null)", () => {
    expect(addSkillFromInput([], "")).toBeNull();
    expect(addSkillFromInput([], "   ")).toBeNull();
  });

  it("leaves existing rows' level + keywords untouched by an unrelated add", () => {
    const existing = skill("Python", { level: "Expert", keywords: "async, web" });
    const next = addSkillFromInput([existing], "Rust");
    expect(next).not.toBeNull();
    expect(next?.[0]).toBe(existing); // same reference — never re-created
    expect(next?.[0]?.level).toBe("Expert");
    expect(next?.[0]?.keywords).toBe("async, web");
    expect(next?.[1]?.name).toBe("Rust");
  });

  it("addLanguageFromInput mirrors it on the language name", () => {
    const langs = [{ uid: "a", language: "English", fluency: "Native" }];
    expect(addLanguageFromInput(langs, "english")).toBeNull(); // case-insensitive dup
    const next = addLanguageFromInput(langs, "  German ");
    expect(next?.map((l) => l.language)).toEqual(["English", "German"]);
    expect(next?.[0]?.fluency).toBe("Native"); // existing row untouched
    expect(addLanguageFromInput(langs, "  ")).toBeNull(); // blank no-op
  });
});

describe("chipLabel", () => {
  it("appends ' · qualifier' when the qualifier is set", () => {
    expect(chipLabel("Python", "Expert")).toBe("Python · Expert");
    expect(chipLabel("English", "Native")).toBe("English · Native");
  });
  it("shows only the name when the qualifier is blank / whitespace", () => {
    expect(chipLabel("Python", "")).toBe("Python");
    expect(chipLabel("Python", "   ")).toBe("Python");
  });
});

describe("firstInvalidEntry (Save-error auto-open)", () => {
  it("returns null when every skill + language name is non-blank", () => {
    const draft: MasterDraft = {
      ...emptyDraft(),
      skills: [{ uid: "s1", name: "Python", level: "", keywords: "" }],
      languages: [{ uid: "l1", language: "English", fluency: "" }],
    };
    expect(firstInvalidEntry(draft)).toBeNull();
  });

  it("flags the first blank-named skill before any language", () => {
    const draft: MasterDraft = {
      ...emptyDraft(),
      skills: [
        { uid: "s1", name: "Python", level: "", keywords: "" },
        { uid: "s2", name: "  ", level: "", keywords: "" },
      ],
      languages: [{ uid: "l1", language: "  ", fluency: "" }],
    };
    expect(firstInvalidEntry(draft)).toEqual({ kind: "skill", uid: "s2" });
  });

  it("falls through to the first blank-named language when skills are clean", () => {
    const draft: MasterDraft = {
      ...emptyDraft(),
      skills: [{ uid: "s1", name: "Python", level: "", keywords: "" }],
      languages: [
        { uid: "l1", language: "English", fluency: "" },
        { uid: "l2", language: "", fluency: "Native" },
      ],
    };
    expect(firstInvalidEntry(draft)).toEqual({ kind: "language", uid: "l2" });
  });
});

describe("firstInvalidEntry — education (DevPR26)", () => {
  const edu = (over: Partial<MasterDraft["education"][number]> = {}) => ({
    id: "e1",
    institution: "MIT",
    area: "CS",
    studyType: "BSc",
    startDate: "2016",
    endDate: "2020",
    ...over,
  });

  it("flags a blank required education field with the offending field name", () => {
    const draft: MasterDraft = { ...emptyDraft(), education: [edu({ area: "  " })] };
    expect(firstInvalidEntry(draft)).toEqual({ kind: "education", uid: "e1", field: "area" });
  });

  it("checks fields in order (institution → area → studyType → startDate)", () => {
    const draft: MasterDraft = {
      ...emptyDraft(),
      education: [edu({ institution: "", studyType: "" })],
    };
    expect(firstInvalidEntry(draft)).toEqual({
      kind: "education",
      uid: "e1",
      field: "institution",
    });
  });

  it("ranks Skills before Education before Languages", () => {
    const draft: MasterDraft = {
      ...emptyDraft(),
      skills: [{ uid: "s1", name: "", level: "", keywords: "" }],
      education: [edu({ institution: "" })],
      languages: [{ uid: "l1", language: "", fluency: "" }],
    };
    expect(firstInvalidEntry(draft)).toEqual({ kind: "skill", uid: "s1" });
  });

  it("returns education before languages when skills are clean", () => {
    const draft: MasterDraft = {
      ...emptyDraft(),
      education: [edu({ startDate: "" })],
      languages: [{ uid: "l1", language: "", fluency: "" }],
    };
    expect(firstInvalidEntry(draft)).toEqual({
      kind: "education",
      uid: "e1",
      field: "startDate",
    });
  });
});

describe("educationSummary (read-stack)", () => {
  it("joins studyType + area into the degree and start – end into the dates", () => {
    expect(
      educationSummary({
        institution: "MIT",
        area: "Computer Science",
        studyType: "BSc",
        startDate: "2016",
        endDate: "2020",
      }),
    ).toEqual({ degree: "BSc Computer Science", org: "MIT", dates: "2016 – 2020", blank: false });
  });

  it("drops blank parts and flags an all-blank (just-added) entry", () => {
    expect(
      educationSummary({
        institution: "",
        area: "Computer Science",
        studyType: "",
        startDate: "2016",
        endDate: "",
      }),
    ).toEqual({ degree: "Computer Science", org: "", dates: "2016", blank: false });
    expect(
      educationSummary({ institution: "", area: "", studyType: "", startDate: "", endDate: "" }),
    ).toEqual({ degree: "", org: "", dates: "", blank: true });
  });
});
