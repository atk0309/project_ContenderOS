/**
 * Pure logic for the Master editor — request builders + the form-draft <-> MasterProfile mapping.
 * Kept out of the component so it's unit-testable in the node vitest env (no DOM).
 *
 * Why a separate form-draft type: an empty form can't be a valid `MasterProfile` (its scalars are
 * required, non-optional), so the UI edits a permissive draft (all strings present, "" for empty)
 * and `toMaster` normalizes + validates it before PUT. Stable ids are load-bearing provenance
 * anchors (a tailored bullet's `sourceId` points back to a master highlight id), so every work /
 * education / highlight row carries a hidden id generated ONCE on creation (`newId`) and never
 * re-derived from mutable text. Skills/languages have no schema id, so each edit row carries a
 * client-only `uid` React key (stripped by `toMaster`). `certificates` aren't edited here but are
 * preserved verbatim through the round-trip so a save never drops them.
 */
import type { Schemas } from "@/lib/api/client";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace";
import { orderByRecencyDesc } from "@/render/model";

type MasterProfile = Schemas["MasterProfile"];
type Certificates = MasterProfile["certificates"];

/** A ready-to-send `api(path, init)` call. */
export type ApiCall = { path: string; init?: RequestInit };

const ws = (workspaceId: string) => encodeURIComponent(workspaceId);

export function getMasterRequest(workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/master` };
}

export function putMasterRequest(
  master: MasterProfile,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/master`,
    init: { method: "PUT", body: JSON.stringify(master) },
  };
}

// --- The editable form draft ----------------------------------------------------------------------

export type HighlightDraft = { id: string; text: string };
export type WorkDraft = {
  id: string;
  company: string;
  position: string;
  startDate: string;
  endDate: string;
  highlights: HighlightDraft[];
  tags: string; // comma-separated in the UI
};
export type EducationDraft = {
  id: string;
  institution: string;
  area: string;
  studyType: string;
  startDate: string;
  endDate: string;
};
// `uid` is a client-only React key (skills/profiles have no schema id); it's stripped by `toMaster`.
export type SkillDraft = { uid: string; name: string; level: string; keywords: string }; // keywords comma-separated
export type ProfileDraft = { uid: string; network: string; url: string };
export type LanguageDraft = { uid: string; language: string; fluency: string }; // fluency optional
export type MasterDraft = {
  schemaVersion: string;
  name: string;
  label: string;
  email: string;
  phone: string;
  url: string;
  city: string;
  region: string;
  countryCode: string;
  summary: string;
  profiles: ProfileDraft[];
  work: WorkDraft[];
  education: EducationDraft[];
  skills: SkillDraft[];
  languages: LanguageDraft[];
  certificates: Certificates; // preserved verbatim, not edited here
};

/** A fresh stable id for a new row/bullet. Charset-safe (the backend rejects ':' / whitespace); a
 * UUID is `[0-9a-f-]`, so it composes cleanly into the draft's namespaced tailored ids. Generated
 * ONCE at creation — never re-derived from text. */
export function newId(): string {
  return crypto.randomUUID();
}

export function emptyDraft(): MasterDraft {
  return {
    schemaVersion: "1",
    name: "",
    label: "",
    email: "",
    phone: "",
    url: "",
    city: "",
    region: "",
    countryCode: "",
    summary: "",
    profiles: [],
    work: [],
    education: [],
    skills: [],
    languages: [],
    certificates: null,
  };
}

export function newWork(): WorkDraft {
  return {
    id: newId(),
    company: "",
    position: "",
    startDate: "",
    endDate: "",
    highlights: [],
    tags: "",
  };
}

export function newHighlight(): HighlightDraft {
  return { id: newId(), text: "" };
}

export function newEducation(): EducationDraft {
  return { id: newId(), institution: "", area: "", studyType: "", startDate: "", endDate: "" };
}

export const newSkill = (): SkillDraft => ({ uid: newId(), name: "", level: "", keywords: "" });
export const newProfile = (): ProfileDraft => ({ uid: newId(), network: "", url: "" });
export const newLanguage = (): LanguageDraft => ({ uid: newId(), language: "", fluency: "" });

// --- chip helpers (Skills / Languages clouds) -----------------------------------------------------

/** Append a skill parsed from the "Add a skill…" input, or return `null` to reject the add. Rejects a
 * blank input (trimmed) and a case-insensitive duplicate of an existing skill name — the caller shows
 * an "already added" note only for a non-blank dup. Existing rows are returned untouched, so their
 * level/keywords survive an unrelated add (the new row starts from `newSkill()` with the typed name). */
export function addSkillFromInput(skills: SkillDraft[], raw: string): SkillDraft[] | null {
  const name = raw.trim();
  if (!name) return null;
  const dup = skills.some((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  if (dup) return null;
  return [...skills, { ...newSkill(), name }];
}

/** Languages mirror of {@link addSkillFromInput} — trim + case-insensitive dedupe on the language name. */
export function addLanguageFromInput(
  languages: LanguageDraft[],
  raw: string,
): LanguageDraft[] | null {
  const language = raw.trim();
  if (!language) return null;
  const dup = languages.some((l) => l.language.trim().toLowerCase() === language.toLowerCase());
  if (dup) return null;
  return [...languages, { ...newLanguage(), language }];
}

/** A chip's visible label: the entity name, plus " · {qualifier}" when the qualifier (a skill's level
 * / a language's fluency) is non-blank. Presentational — the stored name is shown verbatim. */
export function chipLabel(name: string, qualifier: string): string {
  const q = qualifier.trim();
  return q ? `${name} · ${q}` : name;
}

/** The read-stack an education entry shows collapsed (the design's degree / org / dates lines). `degree`
 * is `studyType area` — the SAME join the renderer uses (`render/model.ts`) so the editor preview matches
 * the CV; `dates` is `start – end`. `blank` (all three empty — a just-added entry) drives the "New
 * education entry" placeholder so the row is never an empty, unlabelled tap target. Presentational. */
export function educationSummary(edu: {
  institution: string;
  area: string;
  studyType: string;
  startDate: string;
  endDate: string;
}): { degree: string; org: string; dates: string; blank: boolean } {
  const degree = [edu.studyType, edu.area]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
  const org = edu.institution.trim();
  const dates = [edu.startDate, edu.endDate]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" – ");
  return { degree, org, dates, blank: !degree && !org && !dates };
}

const csv = (xs: string[]): string => xs.join(", ");
const splitCsv = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Fill the form from a stored (or sample) master — existing ids are reused, not regenerated. Work and
 * education are ordered **reverse-chronologically on load** (the same `orderByRecencyDesc` the renderer
 * uses), so the editor shows roles in the order they appear on the CV (the stored order is immaterial —
 * the renderer always sorts). Sort-on-load, not live, so editing a date doesn't make a card jump. */
export function draftFromMaster(master: MasterProfile): MasterDraft {
  const b = master.basics;
  const datesOf = (e: { startDate: string; endDate?: string | null }) => ({
    startDate: e.startDate,
    endDate: e.endDate,
  });
  return {
    schemaVersion: master.schemaVersion,
    name: b.name,
    label: b.label,
    email: b.email,
    phone: b.phone,
    url: b.url ?? "",
    city: b.location.city,
    region: b.location.region,
    countryCode: b.location.countryCode,
    summary: b.summary,
    profiles: (b.profiles ?? []).map((p) => ({ uid: newId(), network: p.network, url: p.url })),
    work: orderByRecencyDesc(master.work, datesOf).map((w) => ({
      id: w.id,
      company: w.company,
      position: w.position,
      startDate: w.startDate,
      endDate: w.endDate ?? "",
      highlights: w.highlights.map((h) => ({ id: h.id, text: h.text })),
      tags: csv(w.tags ?? []),
    })),
    education: orderByRecencyDesc(master.education, datesOf).map((e) => ({
      id: e.id,
      institution: e.institution,
      area: e.area,
      studyType: e.studyType,
      startDate: e.startDate,
      endDate: e.endDate ?? "",
    })),
    skills: master.skills.map((s) => ({
      uid: newId(),
      name: s.name,
      level: s.level ?? "",
      keywords: csv(s.keywords ?? []),
    })),
    languages: (master.languages ?? []).map((l) => ({
      uid: newId(),
      language: l.language,
      fluency: l.fluency ?? "",
    })),
    certificates: master.certificates ?? null,
  };
}

/** A labeled part of the profile-preview contact line. `kind` is a stable React key (contact values
 * are arbitrary user input and could collide). */
export interface ContactPart {
  kind: "location" | "email" | "phone" | "website";
  value: string;
}

/** The contact line for the master profile-preview header (the design's `isMaster` identity card):
 * location · email · phone · website, in order, with blank parts dropped. Presentational, derived
 * live from the draft. */
export function contactParts(draft: MasterDraft): ContactPart[] {
  const location = [draft.city, draft.region, draft.countryCode]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
  const parts: ContactPart[] = [
    { kind: "location", value: location },
    { kind: "email", value: draft.email.trim() },
    { kind: "phone", value: draft.phone.trim() },
    { kind: "website", value: draft.url.trim() },
  ];
  return parts.filter((p) => p.value);
}

export type MasterResult = { ok: true; master: MasterProfile } | { ok: false; errors: string[] };

/** Normalize + validate the draft into a `MasterProfile`, or return human-readable field errors.
 * Required scalars (basics + each row's key fields, incl. each language name) must be non-blank;
 * empty work/education/skills/languages lists are allowed. Trims everything; splits tags/keywords;
 * fluency is optional; preserves `certificates` verbatim. */
export function toMaster(draft: MasterDraft): MasterResult {
  const errors: string[] = [];
  const t = (s: string): string => s.trim();
  const req = (value: string, label: string): string => {
    const v = t(value);
    if (!v) errors.push(`${label} is required`);
    return v;
  };

  // Only name + email are required (mirrors the relaxed `Basics` schema — both NonBlank server-side).
  // Headline / phone / location / summary are recommended: trimmed and stored as-is (may be ""), never
  // an error. NB `req` stays in use for work/education/skill row fields below — don't relax it globally.
  const name = req(draft.name, "Name");
  const email = req(draft.email, "Email");
  const label = t(draft.label);
  const phone = t(draft.phone);
  const city = t(draft.city);
  const region = t(draft.region);
  const countryCode = t(draft.countryCode);
  const summary = t(draft.summary);

  const work = draft.work.map((w, i) => ({
    id: w.id,
    company: req(w.company, `Work #${i + 1} company`),
    position: req(w.position, `Work #${i + 1} role`),
    startDate: req(w.startDate, `Work #${i + 1} start date`),
    endDate: t(w.endDate) || undefined,
    highlights: w.highlights.map((h, j) => ({
      id: h.id,
      text: req(h.text, `Work #${i + 1} bullet #${j + 1}`),
    })),
    tags: splitCsv(w.tags),
  }));

  const education = draft.education.map((e, i) => ({
    id: e.id,
    institution: req(e.institution, `Education #${i + 1} institution`),
    area: req(e.area, `Education #${i + 1} area`),
    studyType: req(e.studyType, `Education #${i + 1} study type`),
    startDate: req(e.startDate, `Education #${i + 1} start date`),
    endDate: t(e.endDate) || undefined,
  }));

  const skills = draft.skills.map((s, i) => ({
    name: req(s.name, `Skill #${i + 1} name`),
    level: t(s.level) || undefined, // preserved from import; omitted when blank
    keywords: splitCsv(s.keywords),
  }));

  const languages = draft.languages.map((l, i) => ({
    language: req(l.language, `Language #${i + 1} name`), // matches the "<Entity> #n <field>" shape
    fluency: t(l.fluency) || undefined, // optional (JSON Resume); omitted when blank
  }));

  const profiles = draft.profiles
    .filter((p) => t(p.network) || t(p.url))
    .map((p) => ({ network: t(p.network), url: t(p.url) }));

  if (errors.length > 0) return { ok: false, errors };

  const master: MasterProfile = {
    schemaVersion: t(draft.schemaVersion) || "1",
    basics: {
      name,
      label,
      email,
      phone,
      url: t(draft.url) || undefined,
      location: { city, region, countryCode },
      profiles,
      summary,
    },
    work,
    education,
    skills,
    languages,
    certificates: draft.certificates ?? null,
  };
  return { ok: true, master };
}

/** The first master entry a Save would reject AND that the UI shows as a collapsed editor — a skill or
 * language whose trimmed name is blank, or an education entry with a blank required field. Lets the page
 * auto-open + focus that editor on a Save error WITHOUT parsing `toMaster`'s human-readable strings: it
 * re-applies the SAME blank predicates `toMaster` uses (`req`). Scanned in reading order (Skills, then
 * Education, then Languages — the DevPR26 layout). Sections without a collapsed editor (basics, work)
 * stay covered by the error banner. `uid` is the entry's key (a skill/language `uid`, an education `id`);
 * for education, `field` is the first offending field so the page can focus it precisely. */
export type EducationField = "institution" | "area" | "studyType" | "startDate";
export type InvalidEntry =
  | { kind: "skill"; uid: string }
  | { kind: "language"; uid: string }
  | { kind: "education"; uid: string; field: EducationField };

export function firstInvalidEntry(draft: MasterDraft): InvalidEntry | null {
  const skill = draft.skills.find((s) => !s.name.trim());
  if (skill) return { kind: "skill", uid: skill.uid };
  for (const e of draft.education) {
    if (!e.institution.trim()) return { kind: "education", uid: e.id, field: "institution" };
    if (!e.area.trim()) return { kind: "education", uid: e.id, field: "area" };
    if (!e.studyType.trim()) return { kind: "education", uid: e.id, field: "studyType" };
    if (!e.startDate.trim()) return { kind: "education", uid: e.id, field: "startDate" };
  }
  const language = draft.languages.find((l) => !l.language.trim());
  if (language) return { kind: "language", uid: language.uid };
  return null;
}
