/**
 * The render view-model. The Tailor emits a `TailoredCV` whose items reference master entries by
 * `sourceId` (dates / company / institution live on the MasterProfile, not the tailored copy), so
 * rendering needs BOTH. `toResumeDocument` composes the exact shape the design's "paper" renders
 * (cv.header, cv.summary, previewSections). Deterministic: no `Date`, no locale — byte-stable input
 * → byte-stable output (invariant 3). Work and Education are ordered reverse-chronologically by a
 * Date-free comparator (`orderByRecencyDesc`); Projects keep their authored order.
 */
import type { components } from "@/lib/api/generated-types";

type MasterProfile = components["schemas"]["MasterProfile"];
type TailoredCV = components["schemas"]["TailoredCV"];
type SectionType = components["schemas"]["SectionType"];
type Origin = components["schemas"]["Origin"];

export type RenderInput = { master: MasterProfile; cv: TailoredCV };

export type ResumeBullet = {
  id: string;
  text: string;
  origin: Origin;
  needsSignoff: boolean;
};
export type ResumeExpItem = {
  itemId: string;
  role: string;
  org: string;
  location: string;
  dates: string;
  bullets: ResumeBullet[];
};
export type ResumeEduItem = { itemId: string; role: string; org: string; dates: string };
export type ResumeLanguage = { id: string; name: string; fluency: string };
export type ResumeSection =
  | { kind: "experience"; sectionId: string; title: string; items: ResumeExpItem[] }
  | { kind: "skills"; sectionId: string; title: string; skills: string[] }
  | { kind: "education"; sectionId: string; title: string; items: ResumeEduItem[] }
  | { kind: "languages"; sectionId: string; title: string; languages: ResumeLanguage[] };
export type ResumeHeader = {
  name: string;
  title: string;
  location: string;
  email: string;
  phone: string;
  link: string;
};
export type ResumeDocument = {
  header: ResumeHeader;
  summary: string;
  sections: ResumeSection[];
};

const SECTION_TITLES: Record<SectionType, string> = {
  work: "Experience",
  projects: "Projects",
  skills: "Skills",
  education: "Education",
};

/** "2019 – 2021", "2021 – Present", "2021", or "" — string-only, no Date parsing. */
function formatDates(start?: string | null, end?: string | null): string {
  if (!start) return end ?? "";
  return `${start} – ${end ?? "Present"}`;
}

/** One language as a single string, shared by the template / DOCX / ATS so the entry text is
 * identical across all four outputs (only the separator differs per medium): "English — Native", or
 * just "English" when no fluency is stated. */
export function formatLanguage(l: ResumeLanguage): string {
  return l.fluency ? `${l.name} — ${l.fluency}` : l.name;
}

/** Month names → 1..12, for free-form date strings like "March 2019" or "Jan 2020". */
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Markers of an ongoing role/programme (no real end) — these sort as the most recent. */
const ONGOING = /\b(?:present|current|ongoing|now|to date)\b/i;

/**
 * Parse a free-form date string to a comparable `year*100 + month` number, or `null` if it carries no
 * 4-digit year. Deterministic and Date-free (invariant 3 — the guard rejects any wall-clock `Date` in
 * the render path): never constructs a `Date`, only string parsing. Takes the **trailing** 4-digit year
 * and the month **bound to that year's token** (the trailing "YYYY-MM" / "MM/YYYY" / "Mon YYYY"), so a
 * stray earlier date in the same string can't supply the month. An ambiguous full numeric date with a
 * day ("NN/NN/YYYY" — US MM/DD vs DD/MM is unknowable), or any unrecognised month, collapses to 0 —
 * year-only ordering.
 */
function parseYearMonth(s: string): number | null {
  const years = [...s.matchAll(/\d{4}/g)];
  const last = years[years.length - 1];
  if (!last) return null;
  const year = Number(last[0]);
  const at = last.index ?? 0;
  const after = s.slice(at + 4); // chars after the trailing year: "2021-06" → "-06"
  const before = s.slice(0, at); // chars before it: "Mar 2021" → "Mar ", "06/2021" → "06/"
  let month = 0;
  const isoMonth = after.match(/^[-/](\d{1,2})\b/); // YYYY-MM(-DD)
  const numMonth = before.match(/(\d{1,2})[-/]\s*$/); // MM/YYYY (the token just before the year)
  const nameMonth = before.toLowerCase().match(/([a-z]{3,9})[\s.,-]*$/); // "March YYYY"
  // A two-token numeric tail ("MM/DD/YYYY" vs "DD/MM/YYYY") can't be disambiguated → year-only.
  const ambiguousNumeric = /\d{1,2}[-/]\d{1,2}[-/]\s*$/.test(before);
  if (isoMonth?.[1]) month = Number(isoMonth[1]);
  else if (numMonth?.[1] && !ambiguousNumeric) month = Number(numMonth[1]);
  else if (nameMonth?.[1]) month = MONTHS[nameMonth[1].slice(0, 3)] ?? 0;
  if (!(month >= 1 && month <= 12)) month = 0; // garbled/absent month sorts before any dated month
  return year * 100 + month;
}

/**
 * Rank an **end** date: higher ⇒ more recent ⇒ sorts first. An empty value, or an explicit ongoing
 * marker ("Present"/"Current"/… — even alongside a year, e.g. "2020 – Present"), is ongoing (`+∞`); an
 * unparseable value is `-∞` (sinks). The ongoing check runs BEFORE year extraction.
 */
function endRank(value?: string | null): number {
  const s = (value ?? "").trim();
  if (s === "") return Number.POSITIVE_INFINITY; // no end date ⇒ ongoing ⇒ most recent
  if (ONGOING.test(s)) return Number.POSITIVE_INFINITY; // "…– Present" is ongoing even with a year
  return parseYearMonth(s) ?? Number.NEGATIVE_INFINITY;
}

/**
 * Rank a **start** date (the secondary key). Unlike `endRank`, an empty/unparseable start is the
 * *oldest* (`-∞`), never ongoing — "ongoing" is a property of an end date, so a blank start must not
 * masquerade as the most-recent start in a tie.
 */
function startRank(value?: string | null): number {
  return parseYearMonth((value ?? "").trim()) ?? Number.NEGATIVE_INFINITY;
}

/**
 * A reverse-chronological sort key: rank the **end** date, then the **start** date (so two roles that
 * end the same year order by the more-recent start — the recruiter convention), then `resolved` (a
 * dangling `sourceId` always sinks below a real row, even one whose dates are equally unparseable), and
 * finally the original array index as the stable tiebreak for genuinely equal entries.
 */
type RecencyKey = { end: number; start: number; resolved: boolean };
const UNRESOLVED: RecencyKey = {
  end: Number.NEGATIVE_INFINITY,
  start: Number.NEGATIVE_INFINITY,
  resolved: false, // a blank, dangling entry sinks below every resolved row
};

/** The free-form start/end of an entry; `null` from `datesOf` means the row didn't resolve (sinks). */
export type RecencyDates = { startDate?: string | null; endDate?: string | null };

/**
 * Order items reverse-chronologically (most recent first), stably and deterministically (invariant 3).
 * `datesOf` yields each item's start/end (or `null` for an unresolved row, which sinks). Shared with
 * the Master editor + the workspace structured editor so the editable lists display in the SAME order
 * as the rendered CV. Items are decorated with their original index, so the comparator is a strict
 * total order regardless of the engine's sort stability; `±∞` ranks are compared by identity/`<`, never
 * subtracted (so two ongoing roles don't yield `∞ − ∞ = NaN`).
 */
export function orderByRecencyDesc<T>(items: T[], datesOf: (item: T) => RecencyDates | null): T[] {
  return items
    .map((item, index) => {
      const d = datesOf(item);
      const key: RecencyKey = d
        ? { end: endRank(d.endDate), start: startRank(d.startDate), resolved: true }
        : UNRESOLVED;
      return { item, index, key };
    })
    .sort((a, b) => {
      if (a.key.end !== b.key.end) return a.key.end < b.key.end ? 1 : -1;
      if (a.key.start !== b.key.start) return a.key.start < b.key.start ? 1 : -1;
      if (a.key.resolved !== b.key.resolved) return a.key.resolved ? -1 : 1; // resolved first
      return a.index - b.index;
    })
    .map((d) => d.item);
}

function headerOf(master: MasterProfile): ResumeHeader {
  const { basics } = master;
  const loc = [basics.location.city, basics.location.region].filter(Boolean).join(", ");
  const link = basics.profiles[0]?.url ?? basics.url ?? "";
  return {
    name: basics.name,
    title: basics.label,
    location: loc,
    email: basics.email,
    phone: basics.phone,
    link,
  };
}

export function toResumeDocument({ master, cv }: RenderInput): ResumeDocument {
  const workById = new Map(master.work.map((w) => [w.id, w]));
  const eduById = new Map(master.education.map((e) => [e.id, e]));

  const sections: ResumeSection[] = cv.sections.map((sec) => {
    const title = SECTION_TITLES[sec.type];

    if (sec.type === "skills") {
      const fromTailored = sec.items.flatMap((it) => it.highlights.map((h) => h.text));
      const skills = fromTailored.length > 0 ? fromTailored : master.skills.map((s) => s.name);
      return { kind: "skills", sectionId: sec.sectionId, title, skills };
    }

    if (sec.type === "education") {
      const ordered = orderByRecencyDesc(sec.items, (it) => {
        const e = eduById.get(it.sourceId);
        return e ? { startDate: e.startDate, endDate: e.endDate } : null;
      });
      const items: ResumeEduItem[] = ordered.map((it) => {
        const edu = eduById.get(it.sourceId);
        const role = it.position ?? (edu ? `${edu.studyType} ${edu.area}`.trim() : "");
        return {
          itemId: it.itemId,
          role,
          org: it.company ?? edu?.institution ?? "",
          dates: formatDates(edu?.startDate, edu?.endDate),
        };
      });
      return { kind: "education", sectionId: sec.sectionId, title, items };
    }

    // work | projects -> experience block. Work is reverse-chronological (most recent role first);
    // Projects keep their authored order (a deliberate curation, not a timeline).
    const ordered =
      sec.type === "work"
        ? orderByRecencyDesc(sec.items, (it) => {
            const w = workById.get(it.sourceId);
            return w ? { startDate: w.startDate, endDate: w.endDate } : null;
          })
        : sec.items;
    const items: ResumeExpItem[] = ordered.map((it) => {
      const work = workById.get(it.sourceId);
      return {
        itemId: it.itemId,
        role: it.position ?? work?.position ?? "",
        org: it.company ?? work?.company ?? "",
        location: "",
        dates: formatDates(work?.startDate, work?.endDate),
        bullets: it.highlights.map((b) => ({
          id: b.bulletId,
          text: b.text,
          origin: b.origin,
          needsSignoff: b.needsSignoff,
        })),
      };
    });
    return { kind: "experience", sectionId: sec.sectionId, title, items };
  });

  // Languages are MASTER facts (not tailored — no sourceId / sign-off), so they're not part of
  // cv.sections; append a Languages section from the master in AUTHORED order (like skills, never
  // date-sorted) when any are present. `?? []` is deploy-skew defense: a cross-service deploy can
  // briefly serve a master from an OLD backend with no `languages` key (the generated TS says the
  // field is required, but the runtime payload may predate it), so never read `.length` off undefined.
  // `section_id` is a free-form string (not derived from SectionType — drafts mint bare "work"/"skills"
  // but nothing reserves "languages"), so derive a render-only id guaranteed UNIQUE against the existing
  // sections — else ResumeTemplate would key two sections the same. Deterministic (no Date/RNG): a
  // collision just appends "-" (invariant 3).
  const masterLanguages = master.languages ?? [];
  if (masterLanguages.length > 0) {
    const usedSectionIds = new Set(sections.map((s) => s.sectionId));
    let sectionId = "languages";
    while (usedSectionIds.has(sectionId)) sectionId = `${sectionId}-`;
    sections.push({
      kind: "languages",
      sectionId,
      title: "Languages",
      languages: masterLanguages.map((l, i) => ({
        id: `lang-${i}`,
        name: l.language,
        fluency: l.fluency ?? "",
      })),
    });
  }

  return { header: headerOf(master), summary: cv.summary, sections };
}
