/**
 * Pure logic for the Ingest screen — request builders + selectors + the structured per-proposal
 * edit model. Kept out of the component so it's unit-testable in the node vitest env (no DOM): the
 * screen wires these to `api()` and React state, but every decision lives here.
 *
 * The owner reviews server-built `IngestionProposal`s and may correct any field before accepting —
 * the edit is sent as a full `edited: ProposalContent` (the server honours `edited or content` at
 * apply). So this module owns the round-trip between a proposal's structured `content` and a flat,
 * textarea-friendly `ProposalDraft` (list fields as raw strings), keyed by `proposalId`.
 */
import type { Schemas } from "@/lib/api/client";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace";

type RunBundle = Schemas["IngestionRunBundle"];
type IngestRun = Schemas["IngestionRun"];
type Proposal = Schemas["IngestionProposal"];
type ProposalContent = Schemas["ProposalContent"];
type ProposalAction = Schemas["ProposalAction"];
type UnitKind = Schemas["IngestUnitKind"];

/** A ready-to-send `api(path, init)` call. */
export type ApiCall = { path: string; init?: RequestInit };

const ws = (workspaceId: string) => encodeURIComponent(workspaceId);
const seg = (value: string) => encodeURIComponent(value);

// --- Request builders -------------------------------------------------------------------------

/** Max upload size enforced client-side for instant feedback; the backend cap is authoritative. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * The two ingest POSTs — paste a CV / LinkedIn document, or upload a PDF (native document path) —
 * each opening a run; `Accept: text/event-stream` so the backend streams per-agent SSE progress
 * (F3a). Both go via raw `fetch` (the `api()` helper forces JSON), so the paste arm must set
 * `Content-Type: application/json` itself; the upload arm leaves content-type UNSET so the browser
 * writes the multipart boundary. The upload sends `cv-pdf`; the server rejects `pasted` there.
 */
export function streamIngestRequest(
  text: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  const body: Schemas["PasteIngestRequest"] = { text, sourceType: "pasted" };
  return {
    path: `/workspaces/${ws(workspaceId)}/ingest`,
    init: {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    },
  };
}

export function uploadStreamRequest(
  file: File,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  const form = new FormData();
  form.append("file", file);
  form.append("sourceType", "cv-pdf");
  return {
    path: `/workspaces/${ws(workspaceId)}/ingest/file`,
    init: { method: "POST", body: form, headers: { Accept: "text/event-stream" } },
  };
}

/** A PDF by MIME type OR `.pdf` extension — some browsers report `application/octet-stream`. */
export function isPdfFile(file: { type: string; name: string }): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** Client-side size guard (instant feedback before the upload); the backend cap is authoritative. */
export function isFileTooLarge(file: { size: number }): boolean {
  return file.size > MAX_UPLOAD_BYTES;
}

/** Runs newest-first — the primary recovery / history surface on cold load. */
export function listRunsRequest(workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/ingest` };
}

/** The run + its proposals (reload-safe, deep-linkable via `?run=`). */
export function getRunRequest(runId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/ingest/${seg(runId)}` };
}

/** Accept / decline / edit one proposal (optimistic-locked on its `version`). */
export function decideProposalRequest(
  runId: string,
  proposalId: string,
  body: Schemas["DecideProposalRequest"],
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/ingest/${seg(runId)}/proposals/${seg(proposalId)}`,
    init: { method: "POST", body: JSON.stringify(body) },
  };
}

/** Bulk accept/decline. The server re-derives eligibility from stored state (invariant 2). */
export function bulkDecideRequest(
  runId: string,
  items: Schemas["BulkDecideItem"][],
  action: ProposalAction,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  const body: Schemas["BulkDecideRequest"] = { items, action };
  return {
    path: `/workspaces/${ws(workspaceId)}/ingest/${seg(runId)}/decide`,
    init: { method: "POST", body: JSON.stringify(body) },
  };
}

/** Merge the accepted proposals into the master under the advisory lock. */
export function applyRunRequest(
  runId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/ingest/${seg(runId)}/apply`,
    init: { method: "POST" },
  };
}

/** Abandon a run — the escape hatch that frees the workspace for a new ingest. */
export function discardRunRequest(
  runId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/ingest/${seg(runId)}/discard`,
    init: { method: "POST" },
  };
}

// --- Selectors --------------------------------------------------------------------------------

/** The non-terminal states the one-open-run guard keys on. `review` is OPEN (a new import is 409). */
const OPEN_STATES: ReadonlySet<string> = new Set(["extracting", "reconciling", "review"]);

/** The ≤1 run currently blocking a new import (the workspace allows one open run). */
export function openRun(runs: IngestRun[]): IngestRun | null {
  return runs.find((r) => OPEN_STATES.has(r.status)) ?? null;
}

/** The content the owner is acting on — a saved edit wins over the original extraction. */
export function effectiveContent(p: Proposal): ProposalContent {
  return p.edited ?? p.content;
}

/**
 * Proposals in the bundle's order — the server already orders by `created_at`, and the proposal wire
 * model exposes no timestamp to client-sort on, so we just preserve that order. NEVER re-sort by
 * status, or a card would jump under the user's cursor when they accept it (stable-identity, inv 7).
 */
export function orderedProposals(bundle: RunBundle): Proposal[] {
  return [...bundle.proposals];
}

export const pendingCount = (proposals: Proposal[]): number =>
  proposals.filter((p) => p.status === "pending").length;
export const acceptedCount = (proposals: Proposal[]): number =>
  proposals.filter((p) => p.status === "accepted").length;

const isNetNew = (p: Proposal): boolean => p.relationship === "net-new";

/**
 * The pending NET-NEW proposals as bulk items — what "Add all new items" submits. The server also
 * re-derives this from stored relationship and rejects any non-net-new id (invariant 2), so an
 * enrich/correction is never bulk-accepted; the owner accepts those per item.
 */
export function netNewPendingItems(proposals: Proposal[]): Schemas["BulkDecideItem"][] {
  return proposals
    .filter((p) => p.status === "pending" && isNetNew(p))
    .map((p) => ({ proposalId: p.proposalId, baseVersion: p.version }));
}

/** How many new items "Add all new items" would add — drives the button count + its disabled state. */
export const netNewPendingCount = (proposals: Proposal[]): number =>
  proposals.filter((p) => p.status === "pending" && isNetNew(p)).length;

/**
 * True when there are still pending enrich/correction proposals to review. Gates the "these update
 * entries already in your master" helper: it must NOT show on a first import (all net-new, no
 * updates) NOR once every update has been decided — only while there is a pending update to act on.
 */
export const hasPendingUpdateProposals = (proposals: Proposal[]): boolean =>
  proposals.some((p) => p.status === "pending" && !isNetNew(p));

/** A `review` run that yielded zero proposals = "we couldn't read anything" (NOT an error). */
export function extractedNothing(bundle: RunBundle): boolean {
  return bundle.run.status === "review" && bundle.proposals.length === 0;
}

// --- Structured per-proposal edit model -------------------------------------------------------

/**
 * A flat, textarea-friendly view of a proposal's editable content, discriminated by unit kind. List
 * fields are raw strings (highlights one-per-line; tags/keywords comma-separated); `endDate`/`level`
 * are "" when absent. Basics carries its immutable `fieldPath` (display-only) so the converter can
 * echo it back — `fieldPath` is the key the server's allowlist resolves, so losing it drops the edit.
 */
export type ProposalDraft =
  | { kind: "basics-field"; fieldPath: string; value: string }
  | {
      kind: "work";
      company: string;
      position: string;
      startDate: string;
      endDate: string;
      highlights: string;
      tags: string;
    }
  | {
      kind: "education";
      institution: string;
      area: string;
      studyType: string;
      startDate: string;
      endDate: string;
    }
  | { kind: "skill"; name: string; level: string; keywords: string }
  | { kind: "certificate"; name: string; issuer: string; date: string }
  | { kind: "profile"; network: string; url: string }
  | { kind: "language"; language: string; fluency: string }
  // enrich: a single new bullet for an existing role. Only the text is editable — the target work
  // entry is the server-owned `targetWorkId`/`targetLabel` on the envelope (invariant 2).
  | { kind: "highlight"; text: string };

/** Uncommitted structured edits, by proposalId. Absent = the card shows the persisted content. */
export type Drafts = Record<string, ProposalDraft>;

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
const commas = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const joinLines = (xs: string[]): string => xs.join("\n");
const joinCommas = (xs: string[]): string => xs.join(", ");
const orNull = (s: string): string | null => (s.trim() ? s.trim() : null);

/** Seed an editable draft from a proposal's effective content (a saved edit, else the extraction). */
export function seedDraft(p: Proposal): ProposalDraft {
  const c = effectiveContent(p);
  switch (p.unitKind) {
    case "basics-field":
      return {
        kind: "basics-field",
        fieldPath: c.field?.fieldPath ?? "",
        value: c.field?.value ?? "",
      };
    case "work":
      return {
        kind: "work",
        company: c.work?.company ?? "",
        position: c.work?.position ?? "",
        startDate: c.work?.startDate ?? "",
        endDate: c.work?.endDate ?? "",
        highlights: joinLines(c.work?.highlights ?? []),
        tags: joinCommas(c.work?.tags ?? []),
      };
    case "education":
      return {
        kind: "education",
        institution: c.education?.institution ?? "",
        area: c.education?.area ?? "",
        studyType: c.education?.studyType ?? "",
        startDate: c.education?.startDate ?? "",
        endDate: c.education?.endDate ?? "",
      };
    case "skill":
      return {
        kind: "skill",
        name: c.skill?.name ?? "",
        level: c.skill?.level ?? "",
        keywords: joinCommas(c.skill?.keywords ?? []),
      };
    case "certificate":
      return {
        kind: "certificate",
        name: c.certificate?.name ?? "",
        issuer: c.certificate?.issuer ?? "",
        date: c.certificate?.date ?? "",
      };
    case "profile":
      return {
        kind: "profile",
        network: c.profile?.network ?? "",
        url: c.profile?.url ?? "",
      };
    case "language":
      return {
        kind: "language",
        language: c.language?.language ?? "",
        fluency: c.language?.fluency ?? "",
      };
    case "highlight":
      return { kind: "highlight", text: c.highlight?.text ?? "" };
  }
}

/**
 * Rebuild a full `ProposalContent` from an edited draft, emitting exactly the sub-field that matches
 * the draft's kind (the server does NOT validate the sub-field against `unitKind` at decide time, so
 * a mismatch would silently become an apply conflict). `base` carries the non-edited internals
 * (the extractor's `evidence` string) so they survive the round-trip.
 */
export function draftToContent(draft: ProposalDraft, base: ProposalContent): ProposalContent {
  switch (draft.kind) {
    case "basics-field":
      return { field: { fieldPath: draft.fieldPath, value: draft.value } };
    case "work":
      return {
        work: {
          company: draft.company,
          position: draft.position,
          startDate: draft.startDate,
          endDate: orNull(draft.endDate),
          highlights: lines(draft.highlights),
          tags: commas(draft.tags),
          evidence: base.work?.evidence ?? "",
        },
      };
    case "education":
      return {
        education: {
          institution: draft.institution,
          area: draft.area,
          studyType: draft.studyType,
          startDate: draft.startDate,
          endDate: orNull(draft.endDate),
          evidence: base.education?.evidence ?? "",
        },
      };
    case "skill":
      return {
        skill: {
          name: draft.name,
          level: orNull(draft.level),
          keywords: commas(draft.keywords),
          evidence: base.skill?.evidence ?? "",
        },
      };
    case "certificate":
      return {
        certificate: {
          name: draft.name,
          issuer: draft.issuer,
          date: draft.date,
          evidence: base.certificate?.evidence ?? "",
        },
      };
    case "profile":
      return { profile: { network: draft.network, url: draft.url } };
    case "language":
      return {
        language: {
          language: draft.language,
          fluency: orNull(draft.fluency),
          evidence: base.language?.evidence ?? "",
        },
      };
    case "highlight":
      return { highlight: { text: draft.text } };
  }
}

/** The content to send on a decide, IFF the draft changed something (else send no `edited`). */
export function editedContent(
  p: Proposal,
  draft: ProposalDraft | undefined,
): ProposalContent | undefined {
  if (!draft) return undefined;
  return isProposalDirty(p, draft) ? draftToContent(draft, effectiveContent(p)) : undefined;
}

/**
 * Has the draft diverged from the proposal's effective content? Both sides are normalised through
 * `draftToContent` (identical key order) so a stable string compare is exact — and list re-joining
 * (e.g. a trailing blank line) doesn't read as a change.
 */
export function isProposalDirty(p: Proposal, draft: ProposalDraft): boolean {
  const base = effectiveContent(p);
  const norm = (d: ProposalDraft) => JSON.stringify(draftToContent(d, base));
  return norm(draft) !== norm(seedDraft(p));
}

/** Pending proposals whose in-memory draft has unsaved edits — these GATE bulk-accept, which can't
 * carry `edited` and would otherwise commit the stale extracted content (the named trust failure). */
export function dirtyPendingProposalIds(proposals: Proposal[], drafts: Drafts): string[] {
  return proposals
    .filter((p) => p.status === "pending")
    .filter((p) => {
      const d = drafts[p.proposalId];
      return d !== undefined && isProposalDirty(p, d);
    })
    .map((p) => p.proposalId);
}

/**
 * Net-new pending proposals with unsaved edits — these (and ONLY these) gate "Add all new items". A
 * dirty enrich/correction must not disable a bulk action that never included it (it's accepted per
 * item), so the bulk button's dirty-guard is scoped to net-new.
 */
export function dirtyNetNewPendingProposalIds(proposals: Proposal[], drafts: Drafts): string[] {
  const netNew = new Set(proposals.filter(isNetNew).map((p) => p.proposalId));
  return dirtyPendingProposalIds(proposals, drafts).filter((id) => netNew.has(id));
}

// --- Display helpers --------------------------------------------------------------------------

const UNIT_LABELS: Record<UnitKind, string> = {
  "basics-field": "Detail",
  work: "Work",
  education: "Education",
  skill: "Skill",
  certificate: "Certificate",
  profile: "Profile",
  language: "Language",
  highlight: "Highlight",
};
export const unitKindLabel = (kind: UnitKind): string => UNIT_LABELS[kind];

// Owner-facing label for a non-net-new relationship — plain language, no build-side jargon (the
// ai-panel/frontend copy rules). net-new gets no extra badge (the "New" status badge already says it).
const RELATIONSHIP_LABELS: Partial<Record<Schemas["IngestRelationship"], string>> = {
  enrich: "Adds to an existing role",
  correction: "Updates a detail",
};
export const relationshipLabel = (r: Schemas["IngestRelationship"]): string | null =>
  RELATIONSHIP_LABELS[r] ?? null;

// Mirrors the backend `JUDGE_UNAVAILABLE` marker (agents/ingest.py): set on every verdict when the
// advisory Judge couldn't be reached, so the UI shows one quiet line instead of a wall of warnings.
export const JUDGE_UNAVAILABLE_REASON = "suggestions unavailable";

const VERDICT_LABELS: Partial<Record<Schemas["IngestVerdict"], string>> = {
  "needs-review": "Worth a look",
  exclude: "Suggested skip",
};
// Owner-facing label for an advisory verdict; `include` gets no badge (a positive verdict is noise).
export const verdictLabel = (v: Schemas["IngestVerdict"]): string | null =>
  VERDICT_LABELS[v] ?? null;

/** The verdict badge for a proposal's card — null when there's no decision, the verdict is `include`,
 * or the advisory Judge was unavailable (that degraded marker shows as one page-level line instead). */
export function proposalVerdictLabel(p: Proposal): string | null {
  if (!p.decision || p.decision.reason === JUDGE_UNAVAILABLE_REASON) return null;
  return verdictLabel(p.decision.verdict);
}

// Generic stand-in when the Judge flagged an item but gave no reason: the omitted-decision path sets
// `reason: ""` server-side (agents/ingest.py), so a `needs-review`/`exclude` badge can carry an empty
// string — without this the flag would render with no "why" at all (the bug this fixes).
export const VERDICT_FALLBACK_REASON = "Flagged for your review — double-check this one.";

/** The reason line shown beneath a proposal's verdict badge. Gated by `proposalVerdictLabel` (so it
 * never shows when the badge itself is suppressed — include / no decision / Judge-unavailable), then
 * the Judge's own phrase, falling back to generic copy when that phrase is blank. Never returns an
 * empty string, so the card never renders a dangling line. */
export function proposalVerdictReason(p: Proposal): string | null {
  if (proposalVerdictLabel(p) === null) return null;
  return p.decision?.reason.trim() || VERDICT_FALLBACK_REASON;
}

/** True when the advisory Judge was unavailable for this run (every decided proposal carries the
 * degraded marker) — the page shows one quiet "suggestions unavailable" line, cards suppress badges. */
export function judgeUnavailable(proposals: Proposal[]): boolean {
  const decided = proposals.filter((p) => p.decision);
  return (
    decided.length > 0 && decided.every((p) => p.decision?.reason === JUDGE_UNAVAILABLE_REASON)
  );
}

// Recommended (but not required) basics, in display order. Only name + email block an import; these
// default empty and the applied summary nudges (yellow) to add them. `location` is ONE concept keyed
// on the RENDERED fields (city || region — country alone never shows on the CV header). `phone number`
// (not "phone") reads correctly after the "a " article in `joinRecommended`.
const RECOMMENDED_BASICS: { label: string; missing: (b: Schemas["Basics"]) => boolean }[] = [
  { label: "headline", missing: (b) => !b.label.trim() },
  { label: "phone number", missing: (b) => !b.phone.trim() },
  { label: "location", missing: (b) => !(b.location.city.trim() || b.location.region.trim()) },
  { label: "summary", missing: (b) => !b.summary.trim() },
];

/** The recommended basics that the applied master is missing, in display order (empty when complete). */
export function recommendedMissing(basics: Schemas["Basics"]): string[] {
  return RECOMMENDED_BASICS.filter((r) => r.missing(basics)).map((r) => r.label);
}

/** Grammatical list for the "add …" nudge: "a summary" / "a headline and summary" / "a headline,
 * phone number, location and summary" (one leading article, no Oxford comma). null when nothing's
 * missing. The single "a " assumes consonant-initial labels (all current ones are). */
export function joinRecommended(labels: string[]): string | null {
  if (labels.length === 0) return null;
  const joined =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `a ${joined}`;
}

/**
 * Pull a clean message out of an `ApiError.message`: the shared `api()` client stores the raw
 * response text, and a FastAPI error body is `{"detail": "…"}`, so without this the owner would see
 * raw JSON (e.g. the first-run "missing required fields" message). Falls back to the raw text.
 */
export function parseDetail(message: string): string {
  try {
    const body = JSON.parse(message) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    /* not JSON — use the raw message */
  }
  return message;
}

/**
 * The user-facing message for a failed ingest call, keyed on HTTP status. Shared by the paste arm
 * (which has an `ApiError`) and the upload arm (raw `fetch`, so a status + the raw body text). 503/
 * 502/413 get friendly copy; everything else — notably a 422's actionable server detail (e.g. the
 * first-run "missing required fields", or "please upload a PDF file") — falls through to the parsed
 * `detail`. Behaviour-preserving for the paste arm's existing 502 + 422-passthrough handling.
 */
export function ingestErrorMessage(status: number, detail: string): string {
  if (status === 503) return "The AI provider isn't set up yet — add an API key in Admin (/admin).";
  if (status === 502)
    return "We couldn't read this document. Try pasting cleaner or more complete text.";
  if (status === 413) return "That PDF is too large — please keep it under 10 MB and 30 pages.";
  return parseDetail(detail) || "Request failed.";
}

// --- SSE progress (the streaming ingest run) --------------------------------------------------

// The SSE spine — frame split/parse, the per-agent checklist reducer, and the stream reader — is
// shared with the review fan-out and lives in `@/lib/sse`. Re-exported here so this screen's logic
// + tests keep one import surface (behaviour unchanged; just relocated).
export type { AgentStatus, Checklist, SseEvent } from "@/lib/sse";
export { emptyChecklist, parseSseFrame, reduceChecklist, splitSseFrames } from "@/lib/sse";

// Owner-facing label per canonical Agent.id (matches the backend ids; never shows build-side jargon).
const AGENT_LABELS: Record<string, string> = {
  "extractor-basics": "Reading your basics",
  "extractor-work": "Reading your work history",
  "extractor-qualifications": "Reading your education & skills",
  "reconciler-work": "Checking against your master",
  judge: "Reviewing suggestions",
};
export const agentLabel = (agentId: string): string => AGENT_LABELS[agentId] ?? "Working…";
