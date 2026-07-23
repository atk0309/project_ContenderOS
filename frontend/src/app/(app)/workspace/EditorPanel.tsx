"use client";

// The left-column editor: the per-bullet edit card (origin/sign-off/unsaved badges, the deterministic
// on-keystroke slop flags, the post-Review inline notes). Sign-off & export moved to the workspace top
// bar (DevPR12). B2b reskin to
// the Claude design's "structured editor": a mono eyebrow, then one panel card per work item with a
// --panel-2 header (role / company · dates) wrapping its bullets; each bullet box carries a left-accent
// "flag" (warn = needs sign-off, bad = a major slop flag). DevPR14: editing moved to the CV paper (the
// single editable surface); this pane is now a READ-ONLY mirror (live draft + instant checks + threaded
// notes). The full click-to-focus navigator lands in DevPR16. Tokens-only colours.
import type { Schemas } from "@/lib/api/client";
import { detectSlop, type SlopFlag } from "@/slop/heuristics";
import { tagStyle as tag } from "@/ui";
import {
  type Decisions,
  type Drafts,
  editableItems,
  type ReviewThread,
  type ThreadDecision,
  threadsForAnchor,
} from "./logic";
import { ReviewInlineBadge } from "./ReviewInlineBadge";
import { bulletBox, mono, srOnly } from "./styles";

type Origin = Schemas["Origin"];

// One work item = a panel card with a --panel-2 header band (the design's structured-editor item).
const itemCard = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 11,
  overflow: "hidden",
} as const;
const itemHeader = {
  padding: "11px 13px",
  borderBottom: "1px solid var(--line)",
  background: "var(--panel-2)",
} as const;
const eyebrow = {
  ...mono,
  fontSize: 10,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--text-3)",
} as const;

// The navigator bullet: a full-width <button> that mirrors the bullet text (the accessible name) with a
// trailing → affordance. Transparent over the bulletBox; the hover tint lives in `.ws-bullet-nav:hover`
// (globals.css) since inline styles can't express :hover. ≥44px (AGENTS §7).
const navBullet = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  width: "100%",
  minHeight: 44,
  padding: "9px 11px",
  borderRadius: 9,
  border: "1px solid var(--line-strong)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "var(--ui)",
  lineHeight: 1.5,
  textAlign: "left",
  cursor: "pointer",
  boxSizing: "border-box",
} as const;

const ORIGIN_STYLE: Record<Origin, { label: string; color: string }> = {
  verbatim: { label: "verbatim", color: "var(--text-3)" },
  reworded: { label: "reworded", color: "var(--accent)" },
  "net-new": { label: "net-new", color: "var(--warn)" },
};

function OriginBadge({ origin }: { origin: Origin }) {
  const o = ORIGIN_STYLE[origin];
  return <span style={tag(o.color)}>{o.label}</span>;
}

function SlopFlags({ flags }: { flags: SlopFlag[] }) {
  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
      {/* "Instant checks" = the deterministic on-keystroke heuristics, distinct from the post-Review
          "Review notes" (ReviewInlineBadge) so the two slop surfaces never read as one (dec #8). */}
      <div style={{ ...mono, fontSize: 10, color: "var(--text-3)" }}>⚑ Instant checks</div>
      {flags.map((f) => (
        <div
          key={`${f.type}-${f.evidence}`}
          style={{ ...mono, fontSize: 10.5, color: severityColor(f.severity) }}
        >
          ⚑ {f.type}: {f.evidence}
        </div>
      ))}
    </div>
  );
}

function severityColor(s: SlopFlag["severity"]): string {
  // Flag rows are essential TEXT → AA inks on the --panel-2 bulletBox host: minor uses --ink-warn
  // (raw --warn fails 3.1–3.7 in light) and info uses --text-2 (--text-3 is only ~3.15:1 there).
  return s === "major" ? "var(--bad)" : s === "minor" ? "var(--ink-warn)" : "var(--text-2)";
}

// The bullet's left-accent flag (the design's per-row `flagColor`): warn while it still needs sign-off,
// bad when a major slop heuristic fires, otherwise the hairline — colour stays on the border only.
function flagColor(needsSignoff: boolean, flags: SlopFlag[]): string {
  if (flags.some((f) => f.severity === "major")) return "var(--bad)";
  if (needsSignoff) return "var(--warn)";
  return "var(--line)";
}

function workDates(work: Schemas["WorkEntry"] | undefined): string | null {
  if (!work) return null;
  const end = work.endDate ?? "Present";
  return work.startDate ? `${work.startDate} – ${end}` : end;
}

export function EditorPanel({
  cv,
  drafts,
  applyingFeedback,
  workById,
  inlineThreads,
  staleIds,
  decisions,
  onDecide,
  acceptedCount,
  onSelectBullet,
}: {
  cv: Schemas["TailoredCV"];
  drafts: Drafts;
  applyingFeedback: boolean;
  workById: Map<string, Schemas["WorkEntry"]>;
  inlineThreads: ReviewThread[];
  staleIds: ReadonlySet<string>;
  decisions: Decisions;
  /** Parent-owned decisions handler (S4): toggles + persists the whole snapshot. Replaces the old
   *  `setDecisions` so the editor and the in-paper note write through ONE race-proof path. */
  onDecide: (key: string, d: ThreadDecision) => void;
  /** Count of accepted, applyable inline corrections — drives the "press Apply" cross-pane CTA so a
   *  user who just accepted notes here knows to run the Corrector (the Apply button lives in the
   *  ReviewPanel above / the Reviewers tab, not in this editor). */
  acceptedCount: number;
  /** Navigate the navigator: jump to + focus the matching bullet on the CV paper (the single editable
   *  surface, DevPR14). Scroll always lands; focus is guarded write-busy-side in page.tsx. */
  onSelectBullet: (bulletId: string) => void;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* A real <h2> (visually the mono eyebrow) so the bullet-editing region keeps a heading in the
            outline/landmark tree; flexWrap so the eyebrow + hint don't collide at <320px. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <h2 style={{ ...eyebrow, margin: 0 }}>Structured editor</h2>
        <span style={{ ...mono, fontSize: 10, color: "var(--text-3)" }}>
          edit on the CV preview →
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 12,
          color: "var(--text-2)",
          lineHeight: 1.5,
        }}
      >
        Click a line below to jump to it on the CV preview, where bullets edit in place — changes
        save when you click away. Editing a net-new (or signed-off) bullet re-requires sign-off.
        (The summary, skills, and education aren&rsquo;t editable yet.)
      </p>
      {/* Cross-pane Apply CTA (DevPR4): accepting an inline note only STAGES it — the change lands
            when the Corrector runs via "Apply corrections". That button lives in the AI-review card,
            not here, so a user who accepts notes in this editor gets no visible CV change and assumes
            it's broken. One static line (never per-bullet — a CTA inside the note <summary> would
            repeat and toggle the disclosure) at --text-2 (essential guidance, AA). Layout-agnostic:
            no "Reviewers tab" wording — at desktop/collapsed there is no tab. */}
      {acceptedCount > 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 500,
            color: "var(--text-2)",
            lineHeight: 1.5,
          }}
        >
          ✓ {acceptedCount} correction{acceptedCount > 1 ? "s" : ""} staged — press{" "}
          <strong style={{ color: "var(--text)", fontWeight: 600 }}>Apply corrections</strong> to
          update the CV.
        </p>
      ) : null}
      {/* DevPR16: a read-only Summary card (the design's structured-editor summary). Summary editing is
          deferred (no edit API), so it carries NO hover/nav cue — it must read as inert, distinct from
          the navigable bullet rows below (the intro names it as not-yet-editable). */}
      {cv.summary.trim() ? (
        <div style={itemCard}>
          <div style={itemHeader}>
            <div style={eyebrow}>Summary</div>
          </div>
          <div
            style={{
              padding: "12px 13px",
              fontSize: 13.5,
              lineHeight: 1.6,
              color: "var(--text)",
              whiteSpace: "pre-wrap",
            }}
          >
            {cv.summary}
          </div>
        </div>
      ) : null}
      {/* Reverse-chronological, matching the rendered CV beside it (D1b). `editableItems` sorts each
            section by recency: work items resolve in workById; a projects item (no master entry)
            resolves to null and keeps authored order — the same per-section ordering the renderer applies. */}
      {editableItems(cv, (sourceId) => {
        const w = workById.get(sourceId);
        return w ? { startDate: w.startDate, endDate: w.endDate } : null;
      }).map((group) => {
        const work = workById.get(group.sourceId);
        const dates = workDates(work);
        return (
          <div key={group.itemId} style={itemCard}>
            <div style={itemHeader}>
              {work ? (
                <>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)" }}>
                    {work.position}
                  </div>
                  {/* company·dates is wayfinding (essential-ish), so --text-2 not --text-3 (AA) —
                        a deliberate AA divergence from the mockup's --text-3 org line. */}
                  <div style={{ ...mono, fontSize: 11, color: "var(--text-2)", marginTop: 2 }}>
                    {dates ? `${work.company} · ${dates}` : work.company}
                  </div>
                </>
              ) : (
                // No master work entry resolves (e.g. a projects group — the master has no project
                // names today). Don't elevate a raw machine id to the bold title slot; keep it a
                // muted mono line so the card never reads as "<random-id>".
                <div style={{ ...mono, fontSize: 11, color: "var(--text-2)" }}>{group.itemId}</div>
              )}
            </div>
            <div
              style={{
                padding: "10px 10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {group.bullets.map((b) => {
                const draft = drafts[b.bulletId] ?? b.text;
                const changed = draft !== b.text;
                const flags = detectSlop([{ anchorId: b.bulletId, text: draft }]);
                return (
                  <div
                    key={b.bulletId}
                    style={{
                      ...bulletBox,
                      borderLeft: `3px solid ${flagColor(b.needsSignoff, flags)}`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        marginBottom: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <OriginBadge origin={b.origin} />
                      {b.needsSignoff ? (
                        <span style={tag("var(--warn)")}>needs sign-off</span>
                      ) : null}
                      {changed ? <span style={tag("var(--text-3)")}>unsaved</span> : null}
                    </div>
                    {/* DevPR16: the read-only mirror is now a NAVIGATOR — a real <button> that jumps to
                        + focuses the matching bullet on the CV paper (the single editable surface,
                        DevPR14). The bullet text is the accessible name; an srOnly suffix states the
                        purpose; the trailing → is the resting affordance (touch-discoverable, distinct
                        from the inert Summary). Not contenteditable (no dual tab stop). */}
                    <button
                      type="button"
                      className="ws-bullet-nav"
                      onClick={() => onSelectBullet(b.bulletId)}
                      style={navBullet}
                    >
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap" }}>{draft}</span>
                      <span style={srOnly}> — jump to this line on the CV</span>
                      <span
                        aria-hidden
                        style={{ flex: "none", color: "var(--text-2)", fontSize: 13 }}
                      >
                        →
                      </span>
                    </button>
                    {/* Two distinct slop surfaces: the deterministic on-keystroke flags
                          ("instant checks") above, the post-Review threads ("voice review")
                          below — never interleaved (dec #8). */}
                    {flags.length > 0 ? <SlopFlags flags={flags} /> : null}
                    {/* Inline notes (same-cv, survive a save) with Accept/Reject; a bullet
                          whose saved text drifted from the review (or is dirty) goes `stale`
                          → flagged in TEXT ("· edited — re-run" + the --ink-warn status line —
                          never an opacity dim) + un-acceptable (per-bullet lifecycle, dec #1/#2). */}
                    <ReviewInlineBadge
                      threads={threadsForAnchor(inlineThreads, "bullet", b.bulletId)}
                      cv={cv}
                      stale={staleIds.has(b.bulletId)}
                      decisions={decisions}
                      onDecide={onDecide}
                      disabled={applyingFeedback}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
