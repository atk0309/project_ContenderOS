/**
 * Pure logic for the Applications tracker — request builders + selectors + the 409-code parser. Kept
 * out of the components so it's unit-testable in the node vitest env (no DOM): the screens wire these
 * to `api()` and React state, every decision lives here.
 */

import type { Schemas } from "@/lib/api/client";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace";
import type { Stage, StageTone } from "@/ui";
import type { ApiCall } from "../workspace/logic";

type ApplyRequest = Schemas["ApplyRequest"];
type StageUpdateRequest = Schemas["StageUpdateRequest"];
type RecruiterUpdateRequest = Schemas["RecruiterUpdateRequest"];
type Application = Schemas["Application"];
type ApplicationSummary = Schemas["ApplicationSummary"];
type ConflictCode = Schemas["ConflictCode"];

const ws = (workspaceId: string) => encodeURIComponent(workspaceId);
const id = (applicationId: string) => encodeURIComponent(applicationId);

/**
 * Cross-route signal: a detail-page delete sets this in sessionStorage, then navigates to the list,
 * which reads it once to restore focus to its heading (the deleted row's route is gone). Keeps the
 * focus hand-off out of router state / a Suspense param.
 */
export const FOCUS_HEADING_KEY = "applications:focus-heading";

export function applyRequest(
  body: ApplyRequest,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/applications`,
    init: { method: "POST", body: JSON.stringify(body) },
  };
}

export function listApplicationsRequest(workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/applications` };
}

export function readApplicationRequest(
  applicationId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/applications/${id(applicationId)}` };
}

/** Look up the application tracking a CV — the workspace's locked-deep-link guard. 404 if not applied. */
export function byCvRequest(cvId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): ApiCall {
  return { path: `/workspaces/${ws(workspaceId)}/applications/by-cv/${id(cvId)}` };
}

export function updateStageRequest(
  applicationId: string,
  body: StageUpdateRequest,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/applications/${id(applicationId)}/stage`,
    init: { method: "PATCH", body: JSON.stringify(body) },
  };
}

export function updateRecruiterRequest(
  applicationId: string,
  body: RecruiterUpdateRequest,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/applications/${id(applicationId)}/recruiter`,
    init: { method: "PATCH", body: JSON.stringify(body) },
  };
}

// Mirrored VERBATIM from the backend `_RECRUITER_EMAIL_RE` (schema/application.py): a pragmatic email
// charset that EXCLUDES URI/mailto metacharacters (? # & % , + whitespace) — one `@`, a dotted domain,
// a 2+ alpha TLD. Kept identical to the backend so a value the card accepts never 422s (frontend ⊆
// backend). It gates the recruiter Save AND the render-time `mailto:`, so excluding those characters IS
// the injection guard (a stored `hr@example.test?bcc=…` could otherwise turn the mailto into a Bcc header).
const RECRUITER_EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** True when `s` looks like an email under the coarse shared rule. Empty/whitespace is NOT valid
 *  (callers treat blank as "cleared" separately). */
export function isLikelyEmail(s: string): boolean {
  return RECRUITER_EMAIL_RE.test(s.trim());
}

export function deleteApplicationRequest(
  applicationId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): ApiCall {
  return {
    path: `/workspaces/${ws(workspaceId)}/applications/${id(applicationId)}`,
    init: { method: "DELETE" },
  };
}

// --- Selectors ------------------------------------------------------------------------------

/** Display label for a tracked job: "Company — Title", else just the title. */
export function applicationLabel(app: Application | ApplicationSummary): string {
  return app.company ? `${app.company} — ${app.jobTitle}` : app.jobTitle;
}

/**
 * Parse the machine-readable conflict code from an `ApiError.message` (which carries the raw response
 * body). Apply/CV-mutation 409s carry `{code, detail}`; returns the code, or null for any other body
 * (e.g. the needs-sign-off `ExportBlocked{blockedBulletIds}`, or a non-JSON detail).
 */
export function conflictCode(message: string): ConflictCode | null {
  try {
    const body = JSON.parse(message) as { code?: ConflictCode };
    return body.code ?? null;
  } catch {
    return null;
  }
}

/** Pull the blocking bullet ids from a needs-sign-off 409 body, or [] if it isn't one. */
export function blockedBulletIds(message: string): string[] {
  try {
    const body = JSON.parse(message) as { blockedBulletIds?: string[] };
    return body.blockedBulletIds ?? [];
  } catch {
    return [];
  }
}

// --- Stage pipeline model (the Tracker) ---------------------------------------------------------
//
// The backend stage set (`DEFAULT_STAGES`) splits into a linear PROGRESS pipeline shown as dots and
// TERMINAL off-ramps shown as a badge + dedicated buttons. `stages` is editable per application but
// has no edit UI, so in practice it's always the default; these selectors classify by membership, so
// a custom stages list still renders (unknown stages fall through as accent progress entries).

export const PROGRESS_STAGES = [
  "applied",
  "acknowledged",
  "screen",
  "interview",
  "final",
  "offer",
] as const;
export const TERMINAL_STAGES = ["rejected", "withdrawn"] as const;

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_STAGES);
const PROGRESS_LIST: readonly string[] = PROGRESS_STAGES;

/** Short label under a pipeline dot (e.g. "Intv"); Title-cases anything not in the map. */
const SHORT: Record<string, string> = {
  applied: "Applied",
  acknowledged: "Ack",
  screen: "Screen",
  interview: "Intv",
  final: "Final",
  offer: "Offer",
};
export function stageShort(stage: string): string {
  return SHORT[stage] ?? stageTitle(stage);
}

/** Full, human stage name for badges / move-buttons / the timeline (Title-case fallback). */
export function stageTitle(stage: string): string {
  return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : stage;
}

export function isTerminalStage(stage: string): boolean {
  return TERMINAL_SET.has(stage);
}

/** Colour family for a stage: success at "offer", red on "rejected", grey on "withdrawn", else the
 *  accent progress blue. Drives both the dots and the move-buttons. */
export function stageTone(stage: string): StageTone {
  if (stage === "offer") return "ok";
  if (stage === "rejected") return "bad";
  if (stage === "withdrawn") return "muted";
  return "accent";
}

/**
 * The collapsed-row pipeline dots, derived from the CURRENT stage alone (the list summary carries no
 * timeline). A progress stage fills the dots up to it (current = that dot); a terminal stage shows the
 * progress pipeline all-pending — the closed state is carried by the row's terminal badge, and the
 * real journey lives in the expanded timeline. (Named divergences: we don't reconstruct a
 * pre-terminal high-water mark from the lightweight summary; the mockup's 0.66 terminal-row dimming
 * is dropped — it sinks the secondary role text below AA, see docs/architecture/design-system.md.)
 */
export function pipelineDots(current: string): Stage[] {
  const terminal = isTerminalStage(current);
  const cur = PROGRESS_LIST.indexOf(current);
  return PROGRESS_STAGES.map((stage, i) => {
    let state: Stage["state"];
    if (terminal || cur < 0) state = "pending";
    else if (i < cur) state = "done";
    else if (i === cur) state = "current";
    else state = "pending";
    return {
      key: stage,
      short: stageShort(stage),
      name: stageTitle(stage),
      state,
      tone: stageTone(stage),
    };
  });
}

export interface MoveOption {
  stage: string;
  label: string;
  active: boolean;
  tone: StageTone;
}

/** The expanded "Move to" buttons: the application's stages split into progress + terminal, in order,
 *  each flagged active when it's the current stage. */
export function moveOptions(
  stages: string[],
  current: string,
): { progress: MoveOption[]; terminal: MoveOption[] } {
  const opt = (stage: string): MoveOption => ({
    stage,
    label: stageTitle(stage),
    active: stage === current,
    tone: stageTone(stage),
  });
  return {
    progress: stages.filter((s) => !TERMINAL_SET.has(s)).map(opt),
    terminal: stages.filter((s) => TERMINAL_SET.has(s)).map(opt),
  };
}

/** Header counts: total tracked applications + how many are still active (non-terminal). */
export function trackerCounts(items: { stage: string }[]): { active: number; total: number } {
  return { total: items.length, active: items.filter((a) => !isTerminalStage(a.stage)).length };
}

/** "Stage N of M · Screen" for a live application; "Rejected · closed" once terminal. Derives the
 *  denominator + position from the application's own progress stages (so a custom pipeline counts
 *  correctly), defaulting to the canonical progress set. */
export function stageSummary(current: string, stages: readonly string[] = PROGRESS_STAGES): string {
  if (isTerminalStage(current)) return `${stageTitle(current)} · closed`;
  const progress = stages.filter((s) => !TERMINAL_SET.has(s));
  const i = progress.indexOf(current);
  if (i < 0) return stageTitle(current);
  return `Stage ${i + 1} of ${progress.length} · ${stageTitle(current)}`;
}
