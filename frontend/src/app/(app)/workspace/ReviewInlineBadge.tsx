/**
 * Inline review notes for one editable bullet, shown in the editor under the deterministic "instant
 * checks" row — a distinct, labelled "Voice review" block so the two slop surfaces never read as one
 * (the on-keystroke `detectSlop` flags vs the post-Review Spotter/Editor/Fact-check threads). PR-4:
 * each correctable thread renders Accept / Reject; a *supported* fact-check is advisory; a stale bullet
 * is flagged in TEXT ("· edited — re-run" + the status line — never an opacity dim, which would push
 * the notes under AA). The `<details>` default-opens once when it has a correctable thread (seeded so
 * a stream tick / save never snaps it).
 */
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { Schemas } from "@/lib/api/client";
import type { Decisions, ReviewThread, ThreadDecision } from "./logic";
import { SOURCE_META, ThreadCard } from "./ThreadCard";

type TailoredCV = Schemas["TailoredCV"];

const mono = { fontFamily: "var(--mono)" } as const;
const summary: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  cursor: "pointer",
  ...mono,
  fontSize: 10.5,
  color: "var(--text-2)",
};

export function ReviewInlineBadge({
  threads,
  cv,
  stale = false,
  decisions = {},
  onDecide,
  disabled = false,
}: {
  threads: ReviewThread[];
  cv: TailoredCV;
  /** The bullet was edited since the review — keep the notes reachable but flag them stale + remove
   *  Accept (the critique is against text that changed), rather than hiding them. */
  stale?: boolean;
  decisions?: Decisions;
  onDecide?: (key: string, d: ThreadDecision) => void;
  /** Disable the toggles while an apply is in flight (the CV is mid-rewrite). */
  disabled?: boolean;
}) {
  // The bullet is editable (the editor only renders editable bullets), so a thread is correctable
  // unless the bullet is stale, already resolved (applied — ADR 0014), or a *supported* fact-check
  // (positive, not a correction).
  const acceptableOf = (t: ReviewThread): boolean =>
    !stale && !t.resolved && !(t.source === "factCheck" && t.verdict === "supported");
  // Default-open ONCE, when the badge FIRST gets a correctable thread (badges mount with `threads=[]`
  // before the SSE produces any, so seeding `useState` at mount captures false — Codex P2). A ref makes
  // it a one-shot: we never auto-close on a later tick/save (no snap under the user, R2-ui2), and a
  // manual collapse sticks.
  const [open, setOpen] = useState(false);
  const autoOpenedRef = useRef(false);
  const hasAcceptable = threads.some(acceptableOf);
  useEffect(() => {
    if (threads.length === 0) {
      autoOpenedRef.current = false; // review cleared — re-arm so the NEXT run's notes auto-open
      return;
    }
    if (hasAcceptable && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setOpen(true);
    }
  }, [hasAcceptable, threads.length]);
  if (threads.length === 0) return null;
  // Whole-bullet: resolvedAnchorIds is bulletId-keyed, so if any thread is resolved the bullet was
  // applied (ADR 0014). Resolved takes precedence over stale in the display (the paper shows ✓).
  const resolved = threads.some((t) => t.resolved);
  // De-duped agent dots so a bullet flagged by two adjudicators shows both marks at a glance.
  const sources = Array.from(new Set(threads.map((t) => t.source)));
  const acceptedCount = threads.filter(
    (t) => acceptableOf(t) && decisions[t.key] === "accepted",
  ).length;
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} style={{ marginTop: 6 }}>
      <summary style={summary}>
        {/* "Review notes" (not "Voice review") — this aggregates ALL the AI review threads on this
            bullet (line edits / fact-checks / voice screen), the per-agent dots say which. It's the
            distinct counterpart to the deterministic "Instant checks" row above (dec #8). Only the
            glyph + dots are aria-hidden, so a screen reader still hears "Review notes" (Codex). */}
        <span aria-hidden>✓</span>
        <span>Review notes</span>
        {sources.map((s) => (
          <span key={s} style={{ ...dot, background: SOURCE_META[s].color }} aria-hidden />
        ))}
        <span style={{ color: "var(--text-3)" }}>
          {threads.length} note{threads.length > 1 ? "s" : ""}
        </span>
        {/* Ok-state summary copy inherits the summary's --text-2 — ok-as-TEXT computes 4.17:1 on
            this --panel-2 bulletBox host in light (under AA); only the ✓ GLYPH carries --ok (≥3:1
            non-text — the GatekeeperView applied-chip pattern, design-system §Computed contrast). */}
        {resolved ? (
          <span>
            · applied{" "}
            <span style={{ color: "var(--ok)" }} aria-hidden>
              ✓
            </span>
          </span>
        ) : (
          <>
            {acceptedCount > 0 ? <span>· {acceptedCount} accepted</span> : null}
            {stale ? <span style={{ color: "var(--ink-warn)" }}>· edited — re-run</span> : null}
          </>
        )}
      </summary>
      {/* No wrapper dim: this div holds only essential children (the status line + the thread
          cards), and stale/applied state is text-carried ("· edited — re-run" / "· applied ✓" +
          the status <p> below) — an opacity dim multiplied every child under AA (rubric §6). */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginTop: 4,
        }}
      >
        {resolved ? (
          // Text at --text-2 (--ok as text is 4.17:1 on this --panel-2 host in light); ✓ keeps --ok.
          <p style={{ ...mono, fontSize: 10.5, color: "var(--text-2)", margin: 0 }}>
            <span style={{ color: "var(--ok)" }} aria-hidden>
              ✓
            </span>{" "}
            Applied — re-run Review to re-check.
          </p>
        ) : stale ? (
          <p style={{ ...mono, fontSize: 10.5, color: "var(--ink-warn)", margin: 0 }}>
            Written before your edit — re-run Review to refresh.
          </p>
        ) : null}
        {threads.map((t) => (
          <ThreadCard
            key={t.key}
            thread={t}
            cv={cv}
            showAnchor={false}
            acceptable={acceptableOf(t)}
            decision={decisions[t.key]}
            onDecide={onDecide}
            disabled={disabled}
          />
        ))}
      </div>
    </details>
  );
}

const dot: CSSProperties = { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 };
