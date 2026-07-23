/**
 * Pure logic for the Workspace screen — request builders + selectors + the live-preview draft
 * overlay. Kept out of the component so it's unit-testable in the node vitest env (no DOM): the
 * screen wires these to `api()` and React state, but every decision lives here.
 */
import { ApiError, type Schemas } from "@/lib/api/client";
import type { AgentStatus, Checklist, SseEvent } from "@/lib/sse";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace";
import { orderByRecencyDesc, type RecencyDates } from "@/render/model";

type TailoredCV = Schemas["TailoredCV"];
type RenderBundle = Schemas["RenderBundle"];
type JobSpec = Schemas["JobSpec"];
type Origin = Schemas["Origin"];
type ReviewBundle = Schemas["ReviewBundle"];
type GatekeeperVerdict = Schemas["GatekeeperVerdict"];
type AgentFailure = Schemas["AgentFailure"];
type AnchorKind = Schemas["AnchorKind"];
type Severity = Schemas["Severity"];
type FactVerdict = Schemas["FactVerdict"];
type SlopFlag = Schemas["SlopFlag"];
type SectionType = Schemas["SectionType"];

/** A ready-to-send `api(path, init)` call. */
export type ApiCall = { path: string; init?: RequestInit };

const ws = (workspaceId: string) => encodeURIComponent(workspaceId);
const cv = (cvId: string) => encodeURIComponent(cvId);

export function parseRequest(rawText: string): ApiCall {
  return { path: "/ai/parse", init: { method: "POST", body: JSON.stringify({ rawText }) } };
}

export function tailorRequest(
  jobSpec: JobSpec,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  // The master is loaded server-side from the workspace's stored profile (invariant 2) — only the
  // job crosses the wire here.
  const body: Schemas["WorkspaceTailorRequest"] = { jobSpec };
  return {
    path: `/workspaces/${ws(workspaceId)}/cv`,
    init: { method: "POST", body: JSON.stringify(body) },
  };
}

/** AI-free verbatim draft from the stored master — the keyless path to a previewable CV. */
export function fromMasterRequest(workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/cv/from-master`,
    init: { method: "POST" },
  };
}

export function readRequest(cvId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}` };
}

/** List the workspace's tailored CVs as lightweight summaries — the dashboard data source. */
export function listCvsRequest(workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/cv` };
}

/** Delete a tailored CV (and its dashboard label). Owner-only; returns 200 `{ ok }`. */
export function deleteCvRequest(cvId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}`,
    init: { method: "DELETE" },
  };
}

export function editRequest(
  cvId: string,
  bulletId: string,
  text: string,
  baseVersion: number,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  // baseVersion = the cv.version the client is viewing — the server rejects (409) a stale write.
  const body: Schemas["EditBulletRequest"] = { bulletId, text, baseVersion };
  return {
    path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}/edit`,
    init: { method: "POST", body: JSON.stringify(body) },
  };
}

export function signoffRequest(
  cvId: string,
  bulletIds: string[],
  baseVersion: number,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  const body: Schemas["SignoffRequest"] = { bulletIds, baseVersion };
  return {
    path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}/signoff`,
    init: { method: "POST", body: JSON.stringify(body) },
  };
}

/**
 * Apply the accepted review threads as Corrector rewrites → a re-grounded `RenderBundle` (PR-4).
 * Owner-only; `baseVersion` is the version the client is applying against — the server rejects (409)
 * a stale write, and the structural guard + selective re-ground are server-authoritative.
 */
export function applyFeedbackRequest(
  cvId: string,
  baseVersion: number,
  threads: Schemas["AcceptedThread"][],
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  const body: Schemas["ApplyFeedbackRequest"] = { threads, baseVersion };
  return {
    path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}/apply`,
    init: { method: "POST", body: JSON.stringify(body) },
  };
}

/**
 * Run the AI review panel over a stored CV, streaming. Owner-only; the CV + its stored JobSpec load
 * server-side. `baseVersion` is the version the client is viewing — the (billed) review is rejected
 * (409) if the stored CV changed since, so a stale tab never pays to review a version it isn't
 * seeing (matches export/apply; drift on an EXISTING review is only a presentation signal — its
 * surfaces stay visible stale-marked, ADR 0016). `Accept: text/event-stream` selects the backend's
 * SSE fan-out arm (per-agent
 * `AgentStarted → AgentReport → AgentDone` + a terminal `RunDone`) instead of the blocking
 * `ReviewBundle`. Fed to `consumeSseStream` (which bypasses `api()`), so Content-Type is set here;
 * the client rebuilds the bundle from the report frames via {@link reduceReviewBundle}.
 */
export function reviewStreamRequest(
  cvId: string,
  baseVersion: number,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  const body: Schemas["ReviewRequest"] = { baseVersion };
  return {
    path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}/review`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    },
  };
}

/**
 * GET the persisted latest review run for a CV (ADR 0013) → `SavedReview | null`. Owner-only; **200-null**
 * (never 404) when nothing is stored or the stored bundle no longer validates — the rehydrate probe fires
 * on every workspace mount, so a 404 would reintroduce console noise. Fed to `api<SavedReview | null>` on
 * load; a `.catch(() => null)` there keeps a transient network error from blocking the CV read.
 */
export function reviewLatestRequest(
  cvId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}/review` };
}

/** DELETE the persisted review for a CV — the "Clear review" action. Owner-only; idempotent (0-row-safe
 *  server-side), so a clear on a never-reviewed CV is a 200 no-op. Same path as {@link reviewLatestRequest}. */
export function deleteReviewRequest(
  cvId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}/review`,
    init: { method: "DELETE" },
  };
}

/**
 * PUT the owner's WHOLE per-finding decisions snapshot for the stored review (last-write-wins, invariant 7;
 * ADR 0013). `cvVersion` is the version the client is viewing — the server rejects a mismatch with **409**
 * (the review was re-run since), answers **404** when no review is stored, and **422** past the bounds
 * (≤512 entries, ≤512 chars/key). Silent autosave (owner decision: no Save button) — the workspace enqueues
 * this per decision click behind a single-flight, trailing-latest queue.
 */
export function saveDecisionsRequest(
  cvId: string,
  decisions: Decisions,
  cvVersion: number,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  const body: Schemas["ReviewDecisionsRequest"] = { decisions, cvVersion };
  return {
    path: `/workspaces/${ws(workspaceId)}/cv/${cv(cvId)}/review/decisions`,
    init: { method: "PUT", body: JSON.stringify(body) },
  };
}

export function exportUrl(cvId: string, kind: "pdf" | "docx" | "text"): string {
  return `/api/render/${kind}?cvId=${encodeURIComponent(cvId)}`;
}

// --- Selectors over the tailored CV ----------------------------------------------------------

/** The sections whose bullets are free text we let the candidate edit (skills/education aren't). */
const EDITABLE_SECTIONS: ReadonlySet<string> = new Set(["work", "projects"]);

export type EditableBullet = {
  sectionId: string;
  itemId: string;
  sourceId: string | null;
  bulletId: string;
  text: string;
  origin: Origin;
  needsSignoff: boolean;
};

/**
 * Editable bullets grouped per item, for the editor pane. When `datesOf` is supplied, **work** sections
 * are ordered reverse-chronologically (the same `orderByRecencyDesc` the renderer uses) so the editor
 * matches the rendered CV (D1b), while **projects** keep their authored order and the sections stay in
 * `cv.sections` order — exactly the renderer's rule (it sorts only `sec.type === "work"`, never
 * Projects, regardless of whether a project id happens to resolve). Without `datesOf`, items keep their
 * document order (order-agnostic callers like `dirtyBulletIds`). Sorting only affects display order;
 * bullets stay keyed by `bulletId`.
 */
export function editableItems(
  cv: TailoredCV,
  datesOf?: (sourceId: string) => RecencyDates | null,
): { itemId: string; sourceId: string; bullets: EditableBullet[] }[] {
  const groups: { itemId: string; sourceId: string; bullets: EditableBullet[] }[] = [];
  for (const section of cv.sections) {
    if (!EDITABLE_SECTIONS.has(section.type)) continue;
    const items =
      datesOf && section.type === "work"
        ? orderByRecencyDesc(section.items, (it) => datesOf(it.sourceId))
        : section.items;
    for (const item of items) {
      const bullets = item.highlights.map((b) => ({
        sectionId: section.sectionId,
        itemId: item.itemId,
        sourceId: b.sourceId,
        bulletId: b.bulletId,
        text: b.text,
        origin: b.origin,
        needsSignoff: b.needsSignoff,
      }));
      if (bullets.length > 0)
        groups.push({ itemId: item.itemId, sourceId: item.sourceId, bullets });
    }
  }
  return groups;
}

/** Bullet ids still awaiting candidate sign-off (the export gate, invariant 2). */
export function collectUnsignedBulletIds(cv: TailoredCV): string[] {
  const ids: string[] = [];
  for (const section of cv.sections)
    for (const item of section.items)
      for (const b of item.highlights) if (b.needsSignoff) ids.push(b.bulletId);
  return ids;
}

// --- Live-preview draft overlay --------------------------------------------------------------

/** Uncommitted edits, by bulletId. A draft equal to the persisted text is not "dirty". */
export type Drafts = Record<string, string>;

/** Bullet ids whose draft differs from the persisted text (unsaved edits). */
export function dirtyBulletIds(bundle: RenderBundle, drafts: Drafts): string[] {
  const ids: string[] = [];
  for (const section of bundle.cv.sections)
    for (const item of section.items)
      for (const b of item.highlights) {
        const draft = drafts[b.bulletId];
        if (draft !== undefined && draft !== b.text) ids.push(b.bulletId);
      }
  return ids;
}

/**
 * A bundle with unsaved draft text substituted in by bulletId — what the live preview renders so the
 * "paper" updates on keystroke. Pure: the master is shared as-is and the persisted bundle is never
 * mutated. Export always uses the persisted bundle (and is blocked while dirty), so this overlay is
 * a preview affordance only — it never reaches an exported document (invariant 3).
 *
 * `frozen` (DevPR14): the bullet being edited IN the paper renders the text it had AT FOCUS (its
 * draft-or-persisted at that moment), held constant for the whole edit so React never reconciles the
 * focused contentEditable — the live DOM text + caret are left alone. Crucially this PRESERVES a
 * lingering draft (e.g. after a failed save) instead of reverting it to the persisted text. The
 * keystroke draft still drives every OTHER surface (the left mirror, slop checks, dirty/export gating);
 * on blur the line un-freezes and re-renders from the committed draft.
 */
export function overlayDrafts(
  bundle: RenderBundle,
  drafts: Drafts,
  frozen?: { bulletId: string; text: string } | null,
  optimistic?: Record<string, string>,
): RenderBundle {
  const cv: TailoredCV = {
    ...bundle.cv,
    sections: bundle.cv.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        highlights: item.highlights.map((b) => {
          if (frozen && b.bulletId === frozen.bulletId) {
            return b.text === frozen.text ? b : { ...b, text: frozen.text };
          }
          // Optimistic apply paint (ADR 0014 / DevPR29): show the accepted suggestion instantly while
          // the Corrector runs. RENDER-ONLY — never a `draft`, so it can't mark the bullet dirty (which
          // would block the very apply it's part of) and can't be blur-committed as a manual edit.
          const opt = optimistic?.[b.bulletId];
          if (opt !== undefined && opt !== b.text) return { ...b, text: opt };
          const draft = drafts[b.bulletId];
          return draft !== undefined && draft !== b.text ? { ...b, text: draft } : b;
        }),
      })),
    })),
  };
  // Spread so the bundle's jobSpec (and any future fields) is preserved — only `cv` is overlaid.
  return { ...bundle, cv };
}

// --- Review surface (read-only; PR-2b) -------------------------------------------------------
//
// The review streams as an SSE fan-out: per-agent `AgentReport`s land one report field at a time and
// are merged into a `ReviewBundle` (`reduceReviewBundle`); per-agent lifecycle for the panel is
// derived from the live checklist gated on stream-settled (`agentState`), NOT the bundle alone — a
// `null` report field is ambiguous mid-stream (not-yet-started vs genuinely-skipped). All of this is
// pure + DOM-free so it's unit-tested in node; the screen wires it to React state in PR-2b-i.

/**
 * The ONE canonical stale-review phrase (ADR 0016). Cause-neutral by design — every Apply bumps
 * `cv.version` just like a manual save, so "CV changed" covers both without blaming either. Each
 * drifted REGION renders it via exactly one carrier (the header/card chips carry it in their
 * accessible name; the rail caption and the Gatekeeper banner render it visibly); the region tests
 * count occurrences of this exact string, so paraphrases can't creep in.
 */
export const STALE_REVIEW_PHRASE = "CV changed since this review — re-run to refresh";

/** Owner-facing label per review Agent.id (backend ids: editor / fact-checker / spotter / gatekeeper). */
const REVIEW_AGENT_LABELS: Record<string, string> = {
  editor: "Line edits",
  "fact-checker": "Fact-check",
  spotter: "Voice review",
  gatekeeper: "Recruiter screen",
};
export const reviewAgentLabel = (agentId: string): string =>
  REVIEW_AGENT_LABELS[agentId] ?? "Reviewing…";

/**
 * `AgentFailure.detail` / `RunDone.detail` are raw Python exception class names (or the
 * `stream_ended_without_terminal` sentinel) — never render them. Map the known ones to a short
 * owner-facing phrase, with a generic catch-all so an unmapped/new class name still reads cleanly.
 */
const FAILURE_LABELS: Record<string, string> = {
  // app agent errors (providers/base.py — serialized as type(exc).__name__)
  AgentRefusal: "the model declined to answer",
  AgentTruncated: "the model's reply was cut off",
  AgentParseError: "couldn't read the model's reply",
  AgentError: "the reviewer errored",
  // provider SDK errors (openai/anthropic class names)
  RateLimitError: "rate-limited — try again shortly",
  AuthenticationError: "a provider key problem",
  PermissionDeniedError: "a provider key problem",
  NotFoundError: "the configured model is unavailable",
  BadRequestError: "the provider rejected the request",
  APIConnectionError: "a connection problem",
  APITimeoutError: "a connection problem",
  InternalServerError: "a provider error — try again",
  // shared SSE spine sentinel (RunDone.detail)
  stream_ended_without_terminal: "the review stream ended early",
};
export const failureLabel = (detail: string): string =>
  FAILURE_LABELS[detail] ?? "an unexpected error";

/** A fresh bundle stamped with the version being reviewed; reports merge in as `AgentReport`s land.
 *  `resolvedAnchorIds` starts empty — a fresh run has nothing applied yet, so it also clears any ✓
 *  chips left from a prior run (ADR 0014). */
export const emptyBundle = (cvVersion: number): ReviewBundle => ({
  cvVersion,
  failures: [],
  resolvedAnchorIds: [],
});

/** The bundle's report fields, in display order. An `AgentReport` populates exactly ONE per event. */
const REPORT_FIELDS = ["editor", "factCheck", "gatekeeper", "slop"] as const;

/**
 * Fold one SSE event into the in-progress `ReviewBundle`. An `agent_report` carries exactly one
 * populated report field — and `agentId` is NOT the field name (fact-checker→`factCheck`,
 * spotter→`slop`) — so find that field and set only it (coalesce; never spread all four, or a later
 * event's nulls would clobber prior reports). A failed `agent_done` reconstructs the `failures[]`
 * the blocking arm returns, deduped/replaced by `agentId` (mirroring the checklist's idempotency).
 * Every other event (started / progress / ok-done / run_done) leaves the bundle unchanged.
 */
export function reduceReviewBundle(bundle: ReviewBundle, ev: SseEvent): ReviewBundle {
  if (ev.type === "agent_report") {
    const field = REPORT_FIELDS.find((f) => ev[f] != null);
    return field ? { ...bundle, [field]: ev[field] } : bundle;
  }
  if (ev.type === "agent_done" && !ev.ok) {
    const failure: AgentFailure = { agentId: ev.agentId, detail: ev.detail ?? "failed" };
    return {
      ...bundle,
      failures: [...bundle.failures.filter((f) => f.agentId !== ev.agentId), failure],
    };
  }
  return bundle;
}

/**
 * The bundle-report field → backend `Agent.id`. The two differ (`factCheck`→`fact-checker`,
 * `slop`→`spotter`), so this is EXPLICIT — {@link checklistFromBundle} needs it to rebuild the settled
 * checklist a rehydrated review lost (the live stream is long gone). Distinct from {@link SOURCE_AGENT_ID}
 * (keyed by `ReviewSource`, whose spotter key is `spotter`, not the bundle's `slop`).
 */
const REPORT_FIELD_AGENT_ID: Record<(typeof REPORT_FIELDS)[number], string> = {
  editor: "editor",
  factCheck: "fact-checker",
  gatekeeper: "gatekeeper",
  slop: "spotter",
};

/**
 * Rebuild the SETTLED per-agent checklist from a persisted/complete `ReviewBundle` (ADR 0013). The live
 * SSE checklist is gone by the time a review rehydrates, and without it the rail renders nothing
 * (`agentState` reports `absent` for any agent missing from the checklist, and `ThreadList` nulls it out).
 * A populated report field → its agent is `done`; each `failures[]` entry → `failed` (a failure wins, so
 * it's appended last). An agent that never ran (a job-dependent Gatekeeper on a no-job draft) is simply
 * absent from the result, so `agentState(..., settled=true)` reports `absent` exactly as a settled-live
 * run does — i.e. a rehydrated roster equals the settled-live one.
 */
export function checklistFromBundle(bundle: ReviewBundle): Checklist {
  const order: string[] = [];
  const status: Record<string, AgentStatus> = {};
  const put = (id: string, s: AgentStatus) => {
    if (!order.includes(id)) order.push(id);
    status[id] = s;
  };
  for (const field of REPORT_FIELDS) {
    if (bundle[field] != null) put(REPORT_FIELD_AGENT_ID[field], "done");
  }
  for (const f of bundle.failures) put(f.agentId, "failed");
  return { order, status };
}

/** Per-agent lifecycle for the panel — distinct from the bundle's report fields (avoids a null flash). */
export type AgentState = "pending" | "running" | "done" | "failed" | "absent";

/** The review sources, mapped to their backend Agent.id so the panel can read per-agent state. */
export type ReviewSource = "editor" | "factCheck" | "spotter" | "gatekeeper";
export const SOURCE_AGENT_ID: Record<ReviewSource, string> = {
  editor: "editor",
  factCheck: "fact-checker",
  spotter: "spotter",
  gatekeeper: "gatekeeper",
};

/**
 * What to render for one agent, gated on whether the stream has SETTLED (a terminal `run_done` seen,
 * ≈ `!reviewing`). A failure is known immediately. Otherwise the live checklist status wins; an agent
 * absent from the checklist (no `agent_started` yet) is `pending` until settled, and only then
 * `absent` — i.e. genuinely not-run (a job-dependent agent on a no-job draft never starts). This is
 * what keeps terminal copy ("needs a target job" / "no findings") from flashing mid-stream.
 */
export function agentState(
  checklist: Checklist,
  failures: AgentFailure[],
  agentId: string,
  settled: boolean,
): AgentState {
  if (failures.some((f) => f.agentId === agentId)) return "failed";
  const status = checklist.status[agentId];
  if (status) return status; // "running" | "done" | "failed"
  return settled ? "absent" : "pending";
}

/** One home for the agent status phrasings so the rail roster and {@link ThreadList} can't drift. */
export const AGENT_STATUS_TEXT = {
  failed: "couldn’t run",
  interrupted: "didn’t finish",
  note: "note",
} as const;

/**
 * What the settled rail roster shows in an agent's count/status slot (DevPR15). The roster is a
 * settled-only aggregate, so this classifies the already-derived `agentState` + the per-source counts
 * the rail already computes (non-orphan panel threads + inline) into one of: a numeric findings count,
 * an `overall`-only "note", "couldn’t run" (failed), "didn’t finish" (settled-but-interrupted), or
 * `none` (no signal — render no slot). Mirrors {@link ThreadList}'s per-agent semantics; pure + tested.
 */
export type RosterStatus =
  | { kind: "count"; n: number }
  | { kind: "note" }
  | { kind: "failed" }
  | { kind: "interrupted" }
  | { kind: "none" };

export function agentRosterStatus(
  source: ReviewSource,
  state: AgentState,
  /** Non-orphan PANEL threads for this source (the same set ThreadList renders). */
  panelCount: number,
  /** Inline (bullet-anchored) findings for this source. */
  inlineCount: number,
  /** The editor's `overall` note exists — a real finding even with zero threads (mirrors ThreadList). */
  hasOverall: boolean,
): RosterStatus {
  if (state === "failed") return { kind: "failed" };
  if (state === "running" || state === "pending") return { kind: "interrupted" };
  const n = panelCount + inlineCount; // roster aggregate (a superset of ThreadList's panel-only badge)
  if (n > 0) return { kind: "count", n };
  if (source === "editor" && hasOverall) return { kind: "note" };
  return { kind: "none" };
}

/** One thread, normalised across the four report shapes for uniform display. */
export type ReviewThread = {
  key: string;
  source: ReviewSource;
  anchorKind: AnchorKind;
  anchorId: string;
  comment: string;
  severity: Severity;
  suggestedRevision?: string | null;
  resolved?: boolean; // the candidate applied a correction on this bullet (ADR 0014) → ✓ chip, not actionable
  claim?: string; // fact-check
  verdict?: FactVerdict; // fact-check
  sourceId?: string | null; // fact-check
  flag?: SlopFlag; // spotter
};

/**
 * Flatten the four report thread-lists into one display list, tagging each with its `source` and a
 * stable `key` = `source:anchorKind:anchorId:ordinal`. The ordinal is scoped to that group, so
 * dropping one bullet's threads never renumbers another's; `anchorKind` is in the key because the
 * backend allows the same id string as both a bullet and an item/section anchor.
 */
export function collectThreads(bundle: ReviewBundle): ReviewThread[] {
  const out: ReviewThread[] = [];
  const ordinals = new Map<string, number>();
  // resolvedAnchorIds is SERVER-controlled (set on apply, never by a model — ADR 0014). Tag each
  // thread on an applied bullet as resolved so downstream (marker/predicate/card) reads it uniformly.
  const resolved = new Set(bundle.resolvedAnchorIds);
  const add = (source: ReviewSource, t: Schemas["Thread"], extra: Partial<ReviewThread> = {}) => {
    const group = `${source}:${t.anchorKind}:${t.anchorId}`;
    const ordinal = ordinals.get(group) ?? 0;
    ordinals.set(group, ordinal + 1);
    out.push({
      key: `${group}:${ordinal}`,
      source,
      anchorKind: t.anchorKind,
      anchorId: t.anchorId,
      comment: t.comment,
      severity: t.severity,
      suggestedRevision: t.suggestedRevision,
      resolved: resolved.has(t.anchorId),
      ...extra,
    });
  };
  for (const t of bundle.editor?.threads ?? []) add("editor", t);
  for (const t of bundle.gatekeeper?.threads ?? []) add("gatekeeper", t);
  for (const t of bundle.factCheck?.threads ?? [])
    add("factCheck", t, { claim: t.claim, verdict: t.verdict, sourceId: t.sourceId });
  for (const t of bundle.slop?.threads ?? []) add("spotter", t, { flag: t.flag });
  return out;
}

/** Stable per-thread key (assigned by {@link collectThreads}); used for React keys + decisions (PR-4). */
export const threadKey = (t: ReviewThread): string => t.key;

/** Bullet ids the editor pane can edit (work/projects) — inline-thread eligibility. */
export function editableBulletIds(cv: TailoredCV): Set<string> {
  return new Set(editableItems(cv).flatMap((g) => g.bullets.map((b) => b.bulletId)));
}

/** A thread renders inline (in the editor) iff it anchors to an editable bullet; else it's panel-only. */
export function isInlineThread(t: ReviewThread, editableIds: ReadonlySet<string>): boolean {
  return t.anchorKind === "bullet" && editableIds.has(t.anchorId);
}

/** Threads anchored to a given element — the inline-badge lookup for one bullet. */
export function threadsForAnchor(
  threads: ReviewThread[],
  anchorKind: AnchorKind,
  anchorId: string,
): ReviewThread[] {
  return threads.filter((t) => t.anchorKind === anchorKind && t.anchorId === anchorId);
}

function cvAnchorIds(cv: TailoredCV): {
  sections: Set<string>;
  items: Set<string>;
  bullets: Set<string>;
} {
  const sections = new Set<string>();
  const items = new Set<string>();
  const bullets = new Set<string>();
  for (const s of cv.sections) {
    sections.add(s.sectionId);
    for (const it of s.items) {
      items.add(it.itemId);
      for (const b of it.highlights) bullets.add(b.bulletId);
    }
  }
  return { sections, items, bullets };
}

function anchorExists(
  cv: TailoredCV,
  kind: AnchorKind,
  id: string,
  ids: ReturnType<typeof cvAnchorIds>,
): boolean {
  switch (kind) {
    case "bullet":
      return ids.bullets.has(id);
    case "item":
      return ids.items.has(id);
    case "section":
      return ids.sections.has(id);
    case "summary":
      return cv.summary.trim().length > 0;
  }
}

/** Threads whose anchor no longer resolves to any element in the current CV (e.g. after a re-tailor). */
export function orphanedThreads(threads: ReviewThread[], cv: TailoredCV): ReviewThread[] {
  const ids = cvAnchorIds(cv);
  return threads.filter((t) => !anchorExists(cv, t.anchorKind, t.anchorId, ids));
}

const SECTION_LABELS: Partial<Record<SectionType, string>> = {
  work: "Work experience",
  projects: "Projects",
  education: "Education",
  skills: "Skills",
};
const sectionLabel = (type: SectionType): string =>
  SECTION_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);

const snippet = (text: string, max = 60): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** A human label for a panel-routed thread's anchor (an inline thread shows next to its bullet instead). */
export function anchorLabel(t: ReviewThread, cv: TailoredCV): string {
  switch (t.anchorKind) {
    case "summary":
      return "Summary";
    case "section": {
      const s = cv.sections.find((x) => x.sectionId === t.anchorId);
      return s ? sectionLabel(s.type) : "Section";
    }
    case "item": {
      for (const s of cv.sections)
        for (const it of s.items)
          if (it.itemId === t.anchorId)
            return [it.position, it.company].filter(Boolean).join(" · ") || "Role";
      return "Role";
    }
    case "bullet": {
      for (const s of cv.sections)
        for (const it of s.items)
          for (const b of it.highlights) if (b.bulletId === t.anchorId) return snippet(b.text);
      return "Bullet";
    }
  }
}

// --- Apply corrections (PR-4): accept/reject decisions + the per-bullet lifecycle -------------
//
// The candidate accepts/rejects bullet-anchored threads, then "Apply corrections" sends the accepted
// ones to the Corrector. The server is authoritative on what persists (it re-grounds + structurally
// guards), so these selectors only decide what's *offered* and what's *sent*.

export type ThreadDecision = Schemas["ThreadDecision"];
/** Accept/reject by `threadKey`. An absent key is undecided. Survives an unrelated bullet's save, and is
 *  persisted per click (ADR 0013 — a whole-snapshot PUT, last-write-wins per invariant 7). */
export type Decisions = Record<string, ThreadDecision>;

/** Toggle a thread's decision immutably; re-applying the same decision clears it. */
export function decide(decisions: Decisions, key: string, d: ThreadDecision): Decisions {
  const next = { ...decisions };
  if (next[key] === d) delete next[key];
  else next[key] = d;
  return next;
}

/** Snapshot the reviewed bullet texts at review-start, so a later *saved* edit can be detected as
 *  drift from what the reviewer judged (a save deletes the draft, so dirty-only can't catch it). */
export function reviewedTextSnapshot(cv: TailoredCV): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of cv.sections)
    for (const item of section.items) for (const b of item.highlights) out[b.bulletId] = b.text;
  return out;
}

/** Bullet ids whose review notes are stale: the SAVED text drifted from the review snapshot, OR the
 *  bullet has an unsaved draft. A bullet absent at review (no snapshot key) is never stale. */
export function staleReviewBulletIds(
  reviewedText: Record<string, string>,
  savedCv: TailoredCV,
  drafts: Drafts,
): Set<string> {
  const stale = new Set<string>();
  for (const section of savedCv.sections)
    for (const item of section.items)
      for (const b of item.highlights) {
        const snap = reviewedText[b.bulletId];
        if (snap !== undefined && snap !== b.text) stale.add(b.bulletId); // saved-text drift
        const draft = drafts[b.bulletId];
        if (draft !== undefined && draft !== b.text) stale.add(b.bulletId); // unsaved draft
      }
  return stale;
}

/**
 * The SINGLE acceptability predicate — shared by the Accept button, the "(N)" count, and the POST
 * projection so display and payload can't drift. A thread is correctable iff it anchors an editable
 * bullet that still exists (orphan guard, via `isInlineThread`), isn't stale, isn't already
 * **resolved** (the candidate applied a correction on this bullet — ADR 0014; gating on `resolved`
 * here — not just leaning on `stale` — matters when a corrector rewrite happens to equal the current
 * text, so the bullet never goes stale), and isn't a *supported* fact-check (positive, not a
 * correction — rewriting it re-words a verified bullet).
 */
/** A positive fact-check (the reviewer confirmed the claim) — NOT a correction. Rendered as a read-only
 *  "verified" chip, excluded from the acceptable/actionable set, and counted separately on the marker. */
export function isSupportedFactCheck(t: ReviewThread): boolean {
  return t.source === "factCheck" && t.verdict === "supported";
}

export function isAcceptableThread(
  t: ReviewThread,
  staleIds: ReadonlySet<string>,
  editableIds: ReadonlySet<string>,
): boolean {
  return (
    isInlineThread(t, editableIds) &&
    !staleIds.has(t.anchorId) &&
    !t.resolved &&
    !isSupportedFactCheck(t)
  );
}

/** For the in-paper single-marker apply: a decisions map with the clicked thread PLUS every
 *  NON-REJECTED note on the SAME bullet (accepted OR undecided). Whole-bullet resolve (ADR 0014)
 *  consumes the whole bullet on apply and flips ALL its notes to `resolved`, so a same-bullet critique
 *  that isn't sent here is silently dropped and can NEVER be applied on a second pass. Sending every
 *  non-rejected sibling matches the server's whole-bullet rewrite (the Corrector addresses every
 *  comment on the bullet in one go). We accept undecided siblings but exclude explicit rejects — a
 *  dismissal must not be resurrected into the payload. Not filtered for acceptability here: the
 *  callers re-filter through `acceptedThreads`/`acceptedThreadSources` → `isAcceptableThread`, which
 *  still drops stale/resolved/orphan/supported-fact-check siblings. One-bullet only — decisions on
 *  OTHER bullets are left untouched. */
export function sameBulletApply(
  clicked: ReviewThread,
  threads: ReviewThread[],
  decisions: Decisions,
): Decisions {
  const out: Decisions = { [clicked.key]: "accepted" };
  for (const t of threads) {
    if (t.anchorId === clicked.anchorId && decisions[t.key] !== "rejected") {
      out[t.key] = "accepted";
    }
  }
  return out;
}

/** The batch ("Apply corrections") analogue of {@link sameBulletApply}, across ALL bullets: for every
 *  bullet that already has ≥1 ACCEPTED thread, fold its non-rejected siblings to accepted too. The apply
 *  resolves the whole bullet (ADR 0014), so an undecided sibling left out of the payload would be silently
 *  resolved-and-dropped — never appliable on a second pass. Folding matches the in-paper path so both apply
 *  surfaces obey the same one-rewrite-per-line invariant. Bullets with no accepted thread are untouched. */
export function foldSameBulletDecisions(decisions: Decisions, threads: ReviewThread[]): Decisions {
  const acceptedBullets = new Set<string>();
  for (const t of threads) if (decisions[t.key] === "accepted") acceptedBullets.add(t.anchorId);
  if (acceptedBullets.size === 0) return decisions;
  const out: Decisions = { ...decisions };
  for (const t of threads) {
    if (acceptedBullets.has(t.anchorId) && decisions[t.key] !== "rejected") out[t.key] = "accepted";
  }
  return out;
}

/** Accepted, correctable threads → `AcceptedThread[]` for the apply request (frontend-only fields —
 *  `key`/`source`/`claim`/`verdict`/`flag` — dropped; the backend is `extra="ignore"` regardless). */
export function acceptedThreads(
  threads: ReviewThread[],
  decisions: Decisions,
  staleIds: ReadonlySet<string>,
  editableIds: ReadonlySet<string>,
): Schemas["AcceptedThread"][] {
  return threads
    .filter((t) => isAcceptableThread(t, staleIds, editableIds) && decisions[t.key] === "accepted")
    .map((t) => ({
      anchorId: t.anchorId,
      anchorKind: t.anchorKind,
      comment: t.comment,
      severity: t.severity,
      suggestedRevision: t.suggestedRevision ?? null,
    }));
}

/** One per-bullet marker for the in-margin overlay (DevPR17): a single glyph per reviewed bullet,
 *  coloured by its primary (highest-severity) note's source, with a total count + actionable/stale
 *  flags. A fully-dismissed bullet (every note rejected) gets NO marker. Pure + unit-tested — the DOM
 *  y-position is measured in PreviewPanel; the glyph/state derives from this. */
export type BulletMarker = {
  bulletId: string;
  source: ReviewSource;
  count: number; // total non-dismissed notes on the bullet (kept for existing consumers)
  actionableCount: number; // notes a fix would address (drives the numeric badge — verified/stale/resolved excluded)
  verifiedCount: number; // supported fact-checks on the bullet (positives, not corrections)
  actionable: boolean;
  stale: boolean;
  resolved: boolean; // the candidate applied a correction here (ADR 0014) → ✓ chip; precedence over stale
};

const SEVERITY_RANK: Record<string, number> = { major: 3, minor: 2, info: 1 };

export function bulletMarkers(
  threads: ReviewThread[],
  decisions: Decisions,
  staleIds: ReadonlySet<string>,
  editableIds: ReadonlySet<string>,
): BulletMarker[] {
  const byBullet = new Map<string, ReviewThread[]>();
  for (const t of threads) {
    if (!isInlineThread(t, editableIds)) continue; // bullet-anchored on an editable bullet only
    if (decisions[t.key] === "rejected") continue; // dismissed → no longer marked
    // A resolved thread is NOT skipped (unlike rejected): it stays as a ✓ chip until the next run.
    const list = byBullet.get(t.anchorId) ?? [];
    list.push(t);
    byBullet.set(t.anchorId, list);
  }
  const out: BulletMarker[] = [];
  for (const [bulletId, list] of byBullet) {
    const primary = list.reduce((a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) > (SEVERITY_RANK[a.severity] ?? 0) ? b : a,
    );
    out.push({
      bulletId,
      source: primary.source,
      count: list.length,
      actionableCount: list.filter((t) => isAcceptableThread(t, staleIds, editableIds)).length,
      verifiedCount: list.filter(isSupportedFactCheck).length,
      actionable: list.some((t) => isAcceptableThread(t, staleIds, editableIds)),
      stale: staleIds.has(bulletId),
      // Per-bullet: resolvedAnchorIds is bulletId-keyed, so any thread carrying it means the bullet
      // was applied. Renders as ✓ with precedence over `stale` (an applied bullet is also stale).
      resolved: list.some((t) => t.resolved),
    });
  }
  return out;
}

/** The apply gate — NOT `canExport` (which requires sign-off, and so is dead while net-new bullets
 *  await it). ≥1 accepted correctable thread, no unsaved drafts, nothing else in flight. */
export function canApplyCorrections(args: {
  acceptedCount: number;
  dirty: number;
  busy: boolean;
}): boolean {
  return args.acceptedCount >= 1 && args.dirty === 0 && !args.busy;
}

// --- Gatekeeper subview (B3): met/unmet must-haves + present/missing keywords -----------------
//
// The Gatekeeper view (ADR 0011 — a same-session, per-CV subview of the live `ReviewBundle.gatekeeper`,
// never persisted) derives "what the posting asks for, and what this CV covers" from the live verdict
// against the stored `JobSpec` (BE-1's `RenderBundle.jobSpec`). The verdict only carries the NEGATIVES
// (`unmetMustHaves` / `missingKeywords`); the positives are derived here as the JobSpec list MINUS the
// flagged negatives, with NORMALIZED (case- + whitespace-folded) matching so a phrasing/casing wobble
// between the Parser's spec and the Gatekeeper's flag doesn't mark a covered requirement unmet. Pure +
// DOM-free so it's unit-tested in node; the screen wires it to React in GatekeeperView.

/** Fold a posting token to a comparison key: trimmed, lowercased, internal whitespace collapsed. */
const normToken = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Drop later items whose normalized `key` already appeared — first (display) form + order survive.
 *  Keeps the rendered list unique (no duplicate rows / no duplicate React keys) on dirty model output. */
function dedupeByNorm<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = normToken(key(it));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export type MustHaveStatus = { label: string; met: boolean };

/**
 * The posting's must-haves, each tagged met/unmet by the verdict's `unmetMustHaves` (normalized match).
 * Met = a JobSpec must-have whose normalized form is NOT in the unmet set. An unmet entry the JobSpec
 * list doesn't contain verbatim (model rephrasing, or no JobSpec at all) is appended as unmet rather
 * than silently dropped — the verdict's negatives are authoritative and must always surface (§2). The
 * combined list is deduped by normalized label (spec entries precede, so a met/unmet spec label wins
 * over a rephrased unmet duplicate).
 */
export function gatekeeperMustHaves(
  jobSpec: JobSpec | null,
  verdict: GatekeeperVerdict,
): MustHaveStatus[] {
  const unmetNorm = new Set((verdict.unmetMustHaves ?? []).map(normToken));
  const combined: MustHaveStatus[] = [
    ...(jobSpec?.mustHaves ?? []).map((label) => ({
      label,
      met: !unmetNorm.has(normToken(label)),
    })),
    ...(verdict.unmetMustHaves ?? []).map((label) => ({ label, met: false })),
  ];
  return dedupeByNorm(combined, (m) => m.label);
}

/** Why the Gatekeeper sub-view has no live verdict to show (drives its designed empty state). */
export type GatekeeperEmptyReason =
  | "no-cv"
  | "no-job"
  | "running"
  | "drifted"
  | "failed"
  | "no-review";

/**
 * The honest empty-state reason when there's no live Gatekeeper verdict (invariant 5 — surface a
 * failure loudly, never mask it). Order matters: a CV with no job has no verdict by design; a FAILED
 * Gatekeeper agent (`gateFailed`) is reported BEFORE `running`, because its verdict will never arrive
 * so "running" would mislead; a still-streaming run with no Gatekeeper failure yet is honestly
 * `running`; a post-review edit is `drifted`; a settled run-level failure for this CV (`reviewFailed`)
 * reads `failed` rather than falling through to `no-review` ("never reviewed"). Pure + unit-tested.
 */
export function gatekeeperEmptyReason(s: {
  hasPreview: boolean;
  hasJobSpec: boolean;
  gateFailed: boolean;
  reviewing: boolean;
  versionDrifted: boolean;
  reviewFailed: boolean;
}): GatekeeperEmptyReason {
  if (!s.hasPreview) return "no-cv";
  if (!s.hasJobSpec) return "no-job";
  if (s.gateFailed) return "failed";
  if (s.reviewing) return "running";
  if (s.versionDrifted) return "drifted";
  if (s.reviewFailed) return "failed";
  return "no-review";
}

export type KeywordMatch = { present: string[]; missing: string[] };

/**
 * ATS keywords split present/missing. Present = the JobSpec's `atsKeywords` the verdict did NOT flag
 * missing (normalized) — i.e. a scanned-for keyword the Gatekeeper didn't call out, distinct from a
 * keyword the posting never listed (which is simply absent here, not "present"). The Parser produces
 * `atsKeywords` and the Gatekeeper produces `missingKeywords` against possibly different sets, so this
 * is "not flagged missing", not a hard confirmation. Missing = the verdict's `missingKeywords`
 * verbatim (the authoritative negative). Order follows each source list.
 */
export function gatekeeperKeywords(
  jobSpec: JobSpec | null,
  verdict: GatekeeperVerdict,
): KeywordMatch {
  const missingNorm = new Set((verdict.missingKeywords ?? []).map(normToken));
  const present = dedupeByNorm(
    (jobSpec?.atsKeywords ?? []).filter((k) => !missingNorm.has(normToken(k))),
    (k) => k,
  );
  return { present, missing: dedupeByNorm(verdict.missingKeywords ?? [], (k) => k) };
}

/** How a recruiter-fix row renders (GatekeeperView) — ONE explicit discriminant per fix, so the
 *  view never guesses a row's reason:
 *  - `applied` — the candidate applied a correction on this bullet (ADR 0014 `resolvedAnchorIds`
 *    → the ✓ chip);
 *  - `applicable` — {@link isAcceptableThread} → the "Open in Workspace →" CTA;
 *  - `blocked-dirty` — an editable-bullet fix on a FRESH review, blocked only by an unsaved draft
 *    on its bullet → the "Save your edits first" microcopy (temporary — saving or discarding the
 *    draft makes it applicable again);
 *  - `advisory` — permanently non-actionable: a non-bullet anchor (item/section/summary) OR a
 *    bullet outside the editable sections (education/skills, or an orphaned id) → the "Advisory"
 *    tag ("edit it in the Workspace yourself");
 *  - `stale` — a would-be-actionable bullet fix on a version-drifted review → NO tag (only
 *    reachable when `versionDrifted`, so the stale banner is guaranteed co-present and explains
 *    the row; "Advisory" would misread as non-bullet). */
export type GatekeeperFixState = "applied" | "applicable" | "blocked-dirty" | "advisory" | "stale";

export type GatekeeperFix = {
  key: string;
  /** The recruiter's note. */
  comment: string;
  /** Human label for the anchored element (a bullet snippet / "Summary" / role). */
  context: string;
  /** How the row renders — see {@link GatekeeperFixState}. */
  state: GatekeeperFixState;
};

/** Classify one gatekeeper thread into its row state. Precedence: applied → applicable → advisory
 *  (permanently non-actionable) → the staleIds fall-through. That fall-through is an editable,
 *  unresolved bullet blocked ONLY by `staleIds`: under a fresh review a SAVED-text drift is
 *  impossible (a save bumps `cv.version` → `versionDrifted`), so fresh staleness is exactly an
 *  unsaved draft → `blocked-dirty`; under a drifted review the banner explains it → `stale`. */
function gatekeeperFixState(
  t: ReviewThread,
  staleIds: ReadonlySet<string>,
  editableIds: ReadonlySet<string>,
  versionDrifted: boolean,
): GatekeeperFixState {
  if (t.resolved && t.anchorKind === "bullet") return "applied";
  if (isAcceptableThread(t, staleIds, editableIds)) return "applicable";
  if (t.anchorKind !== "bullet" || !editableIds.has(t.anchorId)) return "advisory";
  return versionDrifted ? "stale" : "blocked-dirty";
}

/**
 * The Gatekeeper subview's fixes, derived from the same-cv review threads (pure — the screen passes
 * `collectThreads` output). `applied` requires `resolved && anchorKind === "bullet"`: anchor ids
 * COLLIDE across kinds and `resolvedAnchorIds` holds only bulletIds (ADR 0014), so `collectThreads`
 * marks a summary/item/section thread `resolved` when its id merely equals an applied bulletId —
 * the kind check keeps that collision from rendering a false Applied chip. Whole-bullet supersession
 * is deliberate: applying one note resolves the whole bullet, so every gatekeeper thread on it reads
 * applied (its critique of the old text is superseded). `versionDrifted` splits the old no-tag
 * fall-through: only a DRIFTED review may yield `stale` (banner-explained); a fresh review's blocked
 * bullet reads `blocked-dirty` — no dead unexplained rows under a fresh-looking verdict.
 */
export function gatekeeperFixes(
  threads: ReviewThread[],
  cv: TailoredCV,
  staleIds: ReadonlySet<string>,
  editableIds: ReadonlySet<string>,
  versionDrifted: boolean,
): GatekeeperFix[] {
  return threads
    .filter((t) => t.source === "gatekeeper")
    .map((t) => ({
      key: t.key,
      comment: t.comment,
      context: anchorLabel(t, cv),
      state: gatekeeperFixState(t, staleIds, editableIds, versionDrifted),
    }));
}

// --- Diff subview (B4): word-level before/after of the last applied correction ------------------
//
// The Diff view (ADR 0011 — a same-session, per-CV subview, client-derived, never persisted) compares
// the CV held in session BEFORE vs AFTER the most recent Apply-corrections, matched by stable bulletId
// (ADR 0003). Pure + DOM-free so it's unit-tested; the screen captures the pre/post-apply CV + renders.

export type DiffTokenType = "same" | "del" | "add";
/** `key` is a stable per-render ordinal so the component can key the token spans without using the
 *  array index (the token streams never reorder, but biome forbids index-as-key). */
export type DiffToken = { key: number; t: string; type: DiffTokenType };

/**
 * Word-level diff via an LCS over whitespace-split tokens (whitespace kept as tokens, so spacing is
 * preserved). Returns the BEFORE stream (`same`/`del`) and the AFTER stream (`same`/`add`) — the same
 * algorithm as the design's `wordDiff`. Pure + deterministic (no Date/randomness — render-path safe).
 */
export function wordDiff(
  before: string,
  after: string,
): { before: DiffToken[]; after: DiffToken[] } {
  const a = String(before).split(/(\s+)/);
  const b = String(after).split(/(\s+)/);
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] vs b[j:]. (`?? 0`/`as` keep noUncheckedIndexedAccess happy on the
  // guaranteed-in-bounds reads/writes.)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    const next = dp[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const beforeOut: DiffToken[] = [];
  const afterOut: DiffToken[] = [];
  let k = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? "";
    const bj = b[j] ?? "";
    if (ai === bj) {
      beforeOut.push({ key: k++, t: ai, type: "same" });
      afterOut.push({ key: k++, t: bj, type: "same" });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      beforeOut.push({ key: k++, t: ai, type: "del" });
      i++;
    } else {
      afterOut.push({ key: k++, t: bj, type: "add" });
      j++;
    }
  }
  while (i < n) {
    beforeOut.push({ key: k++, t: a[i] ?? "", type: "del" });
    i++;
  }
  while (j < m) {
    afterOut.push({ key: k++, t: b[j] ?? "", type: "add" });
    j++;
  }
  return { before: beforeOut, after: afterOut };
}

export type DiffBullet = {
  bulletId: string;
  /** Human context label for the bullet (its role · company, or the section). */
  context: string;
  beforeText: string;
  afterText: string;
};

/**
 * The bullets whose text differs from a per-bulletId BASELINE, matched by stable bulletId (ADR 0003),
 * in AFTER document order. Only bullets present in BOTH the baseline and `after` are compared — a
 * net-new bullet has no baseline entry, and the Corrector keeps ids, so a corrected bullet always
 * matches its prior self. The baseline is a snapshot map (e.g. `review.reviewedText`), so the Diff is
 * derived — cumulative since the review ran + navigation-surviving — with no separate snapshot store
 * (ADR 0015).
 */
export function diffChangedBulletsFromSnapshot(
  baseline: Record<string, string>,
  after: TailoredCV,
): DiffBullet[] {
  const out: DiffBullet[] = [];
  for (const s of after.sections) {
    for (const it of s.items) {
      for (const b of it.highlights) {
        const prev = baseline[b.bulletId];
        if (prev !== undefined && prev !== b.text) {
          const context =
            [it.position, it.company].filter(Boolean).join(" · ") || sectionLabel(s.type);
          out.push({ bulletId: b.bulletId, context, beforeText: prev, afterText: b.text });
        }
      }
    }
  }
  return out;
}

/** Diff two whole CVs by stable bulletId — {@link diffChangedBulletsFromSnapshot} over a snapshot of
 *  `before`. Retained for its unit tests / any full-CV caller. */
export function diffChangedBullets(before: TailoredCV, after: TailoredCV): DiffBullet[] {
  return diffChangedBulletsFromSnapshot(reviewedTextSnapshot(before), after);
}

// --- New-application flow (B1) -------------------------------------------------------------------

/** A user-entered posting URL is safe to store + later render as an `href` only if it's an absolute
 *  http(s) URL — guards against a `javascript:` / `data:` value becoming a stored navigation/script
 *  sink in the Posting drawer (the field is owner-supplied + owner-viewed, but we never trust input). */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Merge the owner-supplied posting URL into a parsed JobSpec just before tailoring. The URL is a
 *  STORED string (never fetched/parsed); trimmed, validated to http(s), and blank/invalid → null so a
 *  no-URL spec stays clean and legacy back-compat holds. `postingUrl` is owner-supplied here — the
 *  Parser never produces it. */
export function withPostingUrl(spec: Schemas["JobSpec"], url: string): Schemas["JobSpec"] {
  const trimmed = url.trim();
  return { ...spec, postingUrl: trimmed && isSafeHttpUrl(trimmed) ? trimmed : null };
}

/** Owner-facing copy for a failed parse / tailor / draft-from-master, mapped to the backend's contract
 *  (main.py): 404 = no master saved yet; 503 = provider key/model not configured (→ Admin); 502 = the
 *  provider call failed/cut-off/garbled (a transient run failure, NOT misconfiguration → retry); other
 *  ApiErrors (e.g. 422 refusal) surface the server detail. Shared by the New-application modal and the
 *  keyless-draft path so the messaging never drifts. */
export function newApplicationError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return "Add your master CV first (Profile or Import), then start an application.";
    }
    if (err.status === 503) {
      return "AI tailoring isn’t set up yet — add a provider key in Admin (/admin).";
    }
    if (err.status === 502) {
      return "The AI provider couldn’t complete the request — please try again.";
    }
    return apiDetail(err.message) || "Couldn’t start the application — please try again.";
  }
  return "Something went wrong — please try again.";
}

/** FastAPI errors are `{"detail": "..."}` and `api()` stores that raw JSON body as `ApiError.message`
 *  — unwrap a string `detail` for display, falling back to the raw message for plain-text or
 *  non-`{detail}` bodies (e.g. a pydantic array detail). */
function apiDetail(message: string): string {
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed && typeof parsed === "object" && "detail" in parsed) {
      const d = (parsed as { detail: unknown }).detail;
      if (typeof d === "string") return d;
    }
  } catch {
    // Not JSON — the message is already display-ready.
  }
  return message;
}
