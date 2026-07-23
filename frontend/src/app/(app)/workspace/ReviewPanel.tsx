/**
 * The right-hand REVIEW RAIL (DevPR15) — reskinned to the Claude design's rail
 * (`docs/design/Contender.dc.html`): the Review trigger + the live `AgentChecklist`, then the settled
 * **agent roster** (identity + a per-agent count/status that mirrors `ThreadList`), the compact
 * clickable **Gatekeeper card**, the per-agent **ThreadList**, and **Apply corrections**. (The
 * design's human-comments shell was retired with the single-user pivot — the AI panel is the only
 * reviewer.) Judgment-state copy is gated on stream-settled (no false flash).
 *
 * A **version-drifted review stays visible, stale-marked (ADR 0016)** — a saved edit no longer hides
 * the verdict/threads. ONE carrier per region owns the canonical `STALE_REVIEW_PHRASE`: the
 * `VerdictCard` chip when a verdict exists, ELSE the drift caption; `ThreadList`/roster only
 * desaturate (chrome-mix, no text). Bullet inline notes stay per-bullet stale in the editor (PR-4).
 *
 * The roster is **settled-only** (the checklist owns the live stream); its count slot is **omitted
 * unless there is a signal** and gated on review PRESENCE, so a pre-review roster never shows a false
 * "0" while a drifted roster keeps its real counts (dimmed via row border/tint mixes only — the
 * identity badge keeps its contrast-tested fill+ink pair).
 * The run-level error stays here (a soft warn note that styles a user Stop benignly), NOT a banner.
 */
import type { CSSProperties, Ref } from "react";
import type { Schemas } from "@/lib/api/client";
import type { Checklist } from "@/lib/sse";
import { AGENT_IDENTITY, AgentChecklist, type AgentKey, buttonStyle } from "@/ui";
import type { Readiness } from "../ReadinessProvider";
import {
  AGENT_STATUS_TEXT,
  agentRosterStatus,
  agentState,
  collectThreads,
  editableBulletIds,
  isInlineThread,
  orphanedThreads,
  type ReviewSource,
  type RosterStatus,
  reviewAgentLabel,
  SOURCE_AGENT_ID,
  STALE_REVIEW_PHRASE,
} from "./logic";
import { ThreadList } from "./ThreadList";
import { VerdictCard } from "./VerdictCard";

type TailoredCV = Schemas["TailoredCV"];
type ReviewBundle = Schemas["ReviewBundle"];

const mono = { fontFamily: "var(--mono)" } as const;
const eyebrow: CSSProperties = {
  ...mono,
  fontSize: 10,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--text-3)",
};
const infoText: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: "var(--text-2)",
  lineHeight: 1.5,
};
// Warn-toned essential text → the AA --ink-warn ink, never raw --warn (fails as text in light).
const note: CSSProperties = { ...mono, fontSize: 10.5, color: "var(--ink-warn)", marginTop: 8 };
// Actionable guidance (save first / accept a note / what Apply does) → --text-2 for WCAG-AA, not the
// muted --text-3 reserved for metadata/eyebrows (design-system §6). DevPR4.
const hint: CSSProperties = { ...mono, fontSize: 10.5, color: "var(--text-2)", marginTop: 8 };
const ghostBtn = (disabled: boolean) => buttonStyle("ghost", disabled);
const primaryBtn = (disabled: boolean) => buttonStyle("primary", disabled);

// The roster lists every panel agent in the design's order. Parser/Tailor are create-time (no review
// report → no count); the four adjudicators map to a review source the roster counts.
const ROSTER: { key: AgentKey; source: ReviewSource | null }[] = [
  { key: "parser", source: null },
  { key: "tailor", source: null },
  { key: "editor", source: "editor" },
  { key: "fact", source: "factCheck" },
  { key: "spotter", source: "spotter" },
  { key: "gate", source: "gatekeeper" },
];

export function ReviewPanel({
  cv,
  bundle,
  reviewing,
  mutating,
  clearing,
  versionDrifted,
  reviewRestored,
  saveFailed,
  decideSaveFailed,
  reviewLoadFailed,
  dirtyCount,
  checklist,
  statusLine,
  reviewError,
  reviewReadiness,
  headingRef,
  onReview,
  onCancel,
  onRetryReview,
  onOpenGatekeeper,
  showApply,
  acceptedCount,
  canApply,
  applyDisabledReason,
  applying,
  applyError,
  onApply,
  onClearReview,
}: {
  cv: TailoredCV;
  /** The SAME-cv review bundle (built progressively): the verdict + panel threads for the CV in
   *  preview — fresh OR version-drifted (ADR 0016 keeps a drifted review visible, stale-marked via
   *  `versionDrifted`). Null only when no review exists for this cv. */
  bundle: ReviewBundle | null;
  reviewing: boolean;
  /** A save/sign-off OR an apply in flight — Review must stay disabled (it judges the saved CV). */
  mutating: boolean;
  /** A "Clear review" DELETE is in flight — Review stays disabled until it settles (else a new run's
   *  row could be removed by the late unconditional delete). */
  clearing: boolean;
  /** A review exists for this CV but an older version (a save since) — the verdict is stale. */
  versionDrifted: boolean;
  /** This review was rehydrated from persistence on load (S4) — drives the restored provenance caption. */
  reviewRestored: boolean;
  /** The review finished but couldn't be persisted (`RunDone(ok, detail="save_failed")`) — it won't
   *  survive leaving the page (decisions stay local for this run too). */
  saveFailed: boolean;
  /** A per-decision autosave PUT failed on an otherwise-persisted run — a soft, retry-on-next-click note. */
  decideSaveFailed: boolean;
  /** The persisted-review GET FAILED after retries on this CV (transport/5xx) — distinct from a clean
   *  200-null "no review". Surfaces a non-blocking Retry so a transient failure never reads as "vanished". */
  reviewLoadFailed: boolean;
  dirtyCount: number;
  checklist: Checklist;
  statusLine: string;
  reviewError: string | null;
  reviewReadiness: Readiness;
  headingRef: Ref<HTMLHeadingElement>;
  onReview: () => void;
  onCancel: () => void;
  /** Re-run the CV load (and thus the persisted-review probe) — the failed-load Retry target. */
  onRetryReview: () => void;
  /** Open the full recruiter read (`?view=gatekeeper`) — the rail card's click target. */
  onOpenGatekeeper: () => void;
  /** Render the Apply control (≥1 bullet-anchored thread on an editable bullet exists, stale or not)
   *  so its disabled-reason can show even when every accept just went stale. */
  showApply: boolean;
  acceptedCount: number;
  canApply: boolean;
  applyDisabledReason: string | null;
  applying: boolean;
  applyError: string | null;
  onApply: () => void;
  /** Clear the persisted review + all client review state (the "Clear review" action). */
  onClearReview: () => void;
}) {
  const settled = !reviewing;
  // PRESENT vs FRESH (ADR 0016): a review is present for this cv whenever `bundle` is non-null
  // (fresh OR drifted — a drifted review stays visible, stale-marked); it is fresh only when it also
  // judged the current version. Trigger label + the dirty hint key on PRESENCE; the gatekeeper
  // empty-copy fallback + the run-level error stay FRESH-only (stale ones are superseded, not news).
  const reviewPresent = bundle !== null;
  const reviewFresh = reviewPresent && !versionDrifted;
  // A review exists to clear whether or not it's version-fresh (`versionDrifted` kept defensively —
  // presence already covers it). Gate the Clear control on this so it never shows on a
  // never-reviewed panel (the absent state), only when there's actually a run to wipe.
  const reviewExists = reviewPresent || versionDrifted;
  const threads = bundle ? collectThreads(bundle) : [];
  const editableIds = editableBulletIds(cv);
  const panelThreads = threads.filter((t) => !isInlineThread(t, editableIds));
  const inlineCountBySource = threads.reduce(
    (acc, t) => {
      if (isInlineThread(t, editableIds)) acc[t.source] += 1;
      return acc;
    },
    { editor: 0, factCheck: 0, spotter: 0, gatekeeper: 0 } as Record<ReviewSource, number>,
  );
  const verdict = bundle?.gatekeeper ?? null;
  const gatekeeperState = agentState(checklist, bundle?.failures ?? [], "gatekeeper", settled);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 1 — header + trigger */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        {/* tabIndex=-1 so focusSoon can land here on stream-done; keep the default focus ring so a
            keyboard user can SEE where focus went. */}
        <h2 ref={headingRef} tabIndex={-1} style={{ margin: 0, fontSize: 15 }}>
          AI review
        </h2>
        {reviewReadiness === "not-ready" ? (
          <a
            href="/admin"
            style={{ ...ghostBtn(false), textDecoration: "none" }}
            title="Add an OpenAI + Anthropic key + strong-tier models in Admin to run Review"
          >
            Configure AI → Admin
          </a>
        ) : (
          <button
            type="button"
            onClick={onReview}
            disabled={reviewing || mutating || dirtyCount > 0 || clearing}
            style={ghostBtn(reviewing || mutating || dirtyCount > 0 || clearing)}
          >
            {reviewing ? "Screening…" : reviewPresent ? "Re-run" : "Review"}
          </button>
        )}
      </div>

      {/* 1b — the persisted-review GET failed after retries (S4 / ADR 0013): surface it honestly with a
          Retry instead of a silently-empty panel (invariant 5). Never shown mid-stream (a live run owns
          the surface). A valid in-memory review, if any, still renders below — this only adds the note. */}
      {reviewLoadFailed && !reviewing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
          <p style={{ ...note, marginTop: 0 }}>
            Couldn&rsquo;t load your saved review — it may still be there. Try again.
          </p>
          <button type="button" onClick={onRetryReview} style={ghostBtn(false)}>
            Retry loading review
          </button>
        </div>
      ) : null}

      {/* 2 — live fan-out: the ONE aria-live surface during a stream (the roster is settled-only). */}
      {reviewing ? (
        <AgentChecklist
          checklist={checklist}
          statusLine={statusLine}
          label={reviewAgentLabel}
          busyLabel="Screening…"
          onCancel={onCancel}
        />
      ) : null}

      {/* 2c — Clear review: wipes the run + decisions + diff (persist-until-cleared). Shown only when a
          review exists (fresh OR drifted) and nothing's in flight — not while streaming (`settled`), while
          a correction apply/save runs (`mutating`, else the apply races the wipe — Codex P2), or while a
          prior clear's DELETE is still settling (`clearing`). */}
      {reviewExists && settled && !mutating && !clearing ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClearReview}
            style={{ ...ghostBtn(false), minHeight: 44 }}
            title="Remove this review run, your accept/reject decisions, and the diff"
          >
            Clear review
          </button>
        </div>
      ) : null}

      {/* 3 — agent roster (settled only — never duplicates the live checklist). */}
      {settled ? (
        <AgentRoster
          cv={cv}
          bundle={bundle}
          checklist={checklist}
          settled={settled}
          stale={versionDrifted}
          panelThreads={panelThreads}
          inlineCountBySource={inlineCountBySource}
        />
      ) : null}

      {/* 4 — Gatekeeper: the compact clickable card when a same-cv verdict exists (stale-marked when
          drifted — the card chip is then the rail's drift carrier, ADR 0016), else the relocated
          guidance copy KEEPING the `!reviewing` outer guard + the inner gating verbatim (so a mid-stream
          gatekeeper failure can't flash "re-run" beside the live checklist, a failed-run note doesn't
          double, and the intro never leaks into dirty/drifted). */}
      {verdict ? (
        <VerdictCard verdict={verdict} stale={versionDrifted} onOpen={onOpenGatekeeper} />
      ) : settled ? (
        reviewError && reviewFresh ? null : reviewFresh ? (
          gatekeeperState === "failed" ? (
            <p style={infoText}>
              Gatekeeper unavailable — the recruiter screen couldn&rsquo;t run this time. Re-run to
              try again.
            </p>
          ) : gatekeeperState === "absent" ? (
            <p style={infoText}>
              No recruiter screen yet — this draft has no target job. Tailor it to a posting to get
              a pass/borderline/reject verdict.
            </p>
          ) : null
        ) : dirtyCount > 0 ? null : versionDrifted ? null : (
          <p style={infoText}>
            Get an AI read on this CV — a recruiter/ATS verdict, line edits, fact-checks, and an
            AI-language voice screen. Advisory; it never blocks export.
          </p>
        )
      ) : null}

      {/* Run-level / interruption notice for the CURRENT review (stale ones hidden); soft warn, NOT a
          red banner — this also carries the benign user-Stop copy. */}
      {reviewError && reviewFresh ? (
        <p style={{ ...note, marginTop: verdict ? 8 : 0 }}>{reviewError}</p>
      ) : null}

      {/* 5 — the per-agent panel detail (settled): line edits / fact-checks / voice review / recruiter.
          A drifted review's threads stay visible (ADR 0016) — desaturated only, no text line. */}
      {settled && bundle ? (
        <ThreadList
          bundle={bundle}
          cv={cv}
          panelThreads={panelThreads}
          inlineCountBySource={inlineCountBySource}
          checklist={checklist}
          settled={settled}
          stale={versionDrifted}
        />
      ) : null}

      {/* Why Review is disabled while dirty — covers both never-reviewed and stale. */}
      {dirtyCount > 0 ? (
        <p style={hint}>
          {reviewPresent
            ? "Unsaved edits aren’t reviewed yet — save them, then re-run Review."
            : "Save your edits to review the latest."}
        </p>
      ) : null}

      {/* Drift caption (ADR 0016) — the rail's single drift carrier when NO verdict card exists,
          BUILT from the canonical phrase. Governed: when the card chip shows (a verdict exists), the
          chip carries the phrase and this caption keeps ONLY the accepted-notes sentence — rendering
          NOTHING at zero accepts (never an empty <p>). Kept a SEPARATE element for the NON-restored
          live-drift case; suppressed for a restored-stale review (suppression is exactly
          `versionDrifted && reviewRestored`) — the provenance caption's stale-restored variant covers
          that one. */}
      {versionDrifted && !reviewRestored ? (
        verdict ? (
          acceptedCount > 0 ? (
            <p style={{ ...infoText, marginTop: 8 }}>Your accepted bullet notes still apply.</p>
          ) : null
        ) : (
          <p style={{ ...infoText, marginTop: 8 }}>
            {STALE_REVIEW_PHRASE}.
            {acceptedCount > 0 ? " Your accepted bullet notes still apply." : ""}
          </p>
        )
      ) : null}

      {/* ONE provenance / save-state caption slot (S4). Precedence: streaming → nothing; a failed persist
          wins (the soft --ink-warn note — the review + its decisions won't survive leaving the page); else a restored
          verdict's freshness (--text-2 functional text). A save_failed run is never a restore, so the two
          are mutually exclusive in practice — the precedence is defensive. The restored-stale variant is
          governed like the live-drift caption (ADR 0016): the card chip, when present, carries the
          phrase, so the caption keeps only the accepted-notes sentence — or renders nothing. */}
      {settled && saveFailed ? (
        <p style={{ ...note, marginTop: verdict ? 8 : 0 }}>
          Review finished but couldn&rsquo;t be saved — it won&rsquo;t survive leaving this page.
        </p>
      ) : settled && reviewRestored ? (
        versionDrifted ? (
          verdict ? (
            acceptedCount > 0 ? (
              <p style={{ ...infoText, marginTop: 8 }}>Your accepted bullet notes still apply.</p>
            ) : null
          ) : (
            <p style={{ ...infoText, marginTop: 0 }}>
              Restored from an earlier run. {STALE_REVIEW_PHRASE}.
              {acceptedCount > 0 ? " Your accepted bullet notes still apply." : ""}
            </p>
          )
        ) : (
          <p style={{ ...infoText, marginTop: verdict ? 8 : 0 }}>
            Review restored from your last run — decisions save as you click.
          </p>
        )
      ) : null}

      {/* A per-decision autosave that failed (soft; the next click retries it). Distinct from save_failed,
          which means the whole run never persisted so no decision PUT ever fires. */}
      {decideSaveFailed ? (
        <p style={note}>
          Couldn&rsquo;t save your last decision — it&rsquo;ll retry on your next click.
        </p>
      ) : null}

      {/* 6 — Apply corrections: a sticky footer at desktop (scoped in CSS), in-flow at stacked/iPhone. */}
      {showApply ? (
        <div className="ws-rail-apply">
          <button
            type="button"
            onClick={onApply}
            disabled={!canApply}
            style={primaryBtn(!canApply)}
          >
            {applying
              ? "Applying corrections…"
              : `Apply corrections${acceptedCount > 0 ? ` (${acceptedCount})` : ""}`}
          </button>
          {applyError ? <p style={note}>{applyError}</p> : null}
          {!canApply && !applying && applyDisabledReason ? (
            <p style={hint}>{applyDisabledReason}</p>
          ) : null}
          {canApply && !applying ? (
            <p style={hint}>
              Accept only stages a note — Apply rewrites each line to address every note on it, so
              dismiss any you don&rsquo;t want first.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The settled agent roster: identity rows + a per-agent count/status slot (omitted when no signal).
 *  A drifted roster keeps its REAL counts/statuses (`agentRosterStatus` none/interrupted kinds
 *  preserved — never a false "0") and dims via the ROW border/tint colour-mixes only (ADR 0016);
 *  the status words keep their shipped `--text-3`/`--text-2` inks and the identity badge keeps its
 *  full contrast-tested fill+ink pair. */
function AgentRoster({
  cv,
  bundle,
  checklist,
  settled,
  stale,
  panelThreads,
  inlineCountBySource,
}: {
  cv: TailoredCV;
  bundle: ReviewBundle | null;
  checklist: Checklist;
  settled: boolean;
  stale: boolean;
  panelThreads: ReturnType<typeof collectThreads>;
  inlineCountBySource: Record<ReviewSource, number>;
}) {
  const reviewPresent = bundle !== null;
  // Same non-orphan panel set ThreadList renders, computed once for all four adjudicators.
  const orphanKeys = bundle
    ? new Set(orphanedThreads(panelThreads, cv).map((t) => t.key))
    : new Set<string>();
  const hasOverall = !!bundle?.editor?.overall;

  return (
    <section>
      <div style={eyebrow}>Review panel</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 10 }}>
        {ROSTER.map(({ key, source }) => {
          const id = AGENT_IDENTITY[key];
          // Gate-first: pre-review (no bundle at all) and the create-time agents get NO slot —
          // short-circuit before reading the (possibly stale) checklist. A drifted bundle still
          // computes real statuses (ADR 0016 keeps the drifted review visible).
          let status: RosterStatus = { kind: "none" };
          if (reviewPresent && source && bundle) {
            const state = agentState(checklist, bundle.failures, SOURCE_AGENT_ID[source], settled);
            const panelCount = panelThreads.filter(
              (t) => t.source === source && !orphanKeys.has(t.key),
            ).length;
            status = agentRosterStatus(
              source,
              state,
              panelCount,
              inlineCountBySource[source] ?? 0,
              hasOverall,
            );
          }
          return (
            <div key={key} style={rosterRow(id.color, stale)}>
              <span style={rosterBadge(id.color, id.ink)} aria-hidden>
                {id.glyph}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text)" }}>
                  {id.name}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>{id.role}</div>
              </div>
              <StatusSlot status={status} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The roster's right-edge slot — visible, readable text (the SR equivalent), or nothing. */
function StatusSlot({ status }: { status: RosterStatus }) {
  if (status.kind === "none") return null;
  if (status.kind === "count") {
    return (
      <span style={{ ...mono, fontSize: 11, fontWeight: 600, color: "var(--text-2)" }}>
        {status.n}
      </span>
    );
  }
  const text =
    status.kind === "failed"
      ? AGENT_STATUS_TEXT.failed
      : status.kind === "interrupted"
        ? AGENT_STATUS_TEXT.interrupted
        : AGENT_STATUS_TEXT.note;
  return <span style={{ ...mono, fontSize: 10.5, color: "var(--text-3)" }}>{text}</span>;
}

// Stale (ADR 0016) dims via the ROW's border/tint mixes ONLY — text inks are never repainted, and
// the identity badge below is exempt entirely (its fill+ink is a contrast-tested pair).
function rosterRow(color: string, stale: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    padding: "6px 9px",
    borderRadius: 9,
    background: `color-mix(in srgb, ${color} ${stale ? 3 : 6}%, var(--panel))`,
    border: `1px solid color-mix(in srgb, ${color} ${stale ? 8 : 18}%, var(--line))`,
  };
}
function rosterBadge(color: string, ink: string): CSSProperties {
  return {
    width: 22,
    height: 22,
    flex: "none",
    borderRadius: 6,
    // The badge fill+ink stays the FULL identity pair even when the review is stale: the pairs are
    // contrast-tested as a unit (design-system.md §agent identity — ink chains are AA on the
    // UNDIMMED colour), so desaturating the fill under unchanged ink breaks AA. Roster dimming is
    // expressed by the surrounding row chrome (`rosterRow`'s border/tint) only.
    background: color,
    color: ink,
    fontFamily: "var(--mono)",
    fontSize: 9.5,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}
