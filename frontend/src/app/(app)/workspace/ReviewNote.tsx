"use client";

/**
 * The in-place ReviewNote (DevPR17) — a floating card anchored below a reviewed bullet on the CV paper,
 * opened by selecting the bullet's in-margin marker. Ported from `docs/design/ReviewNote.dc.html` (paper
 * literals → chrome tokens; the precedent for chrome-on-cream is PreviewPanel's `pageBreakLabel`). It
 * REUSES `ThreadCard` for each note's content (header / comment / SUGGESTED) and supplies its own action
 * row so the actions can APPLY (not just stage) and carry the top-bar dirty/busy gate.
 *
 * Actions reuse the shipped wiring (no backend change): Accept & fix → single-thread `applyFeedback`
 * (server-guarded Corrector, invariant 1); Sign off to export → `signOff`, only when the bullet
 * `needsSignoff` (invariant 2); View diff → `?view=diff`; Dismiss → `decide(..,"rejected")`. "Remove
 * line" is deferred (no delete API). Chrome tokens only.
 */
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef } from "react";
import type { Schemas } from "@/lib/api/client";
import { buttonStyle } from "@/ui";
import { isAcceptableThread, isSupportedFactCheck, type ReviewThread } from "./logic";
import { ThreadCard } from "./ThreadCard";

type TailoredCV = Schemas["TailoredCV"];

const mono = { fontFamily: "var(--mono)" } as const;
const hint: CSSProperties = { ...mono, fontSize: 10.5, color: "var(--text-2)", margin: "8px 0 0" };
// A supported fact-check is a positive (verified), not a correction — a read-only chip, never an
// "Accept & fix" action, and never counted in the "(N)" the shared button addresses.
const verifiedChip: CSSProperties = {
  ...mono,
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 10.5,
  color: "var(--text-2)",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  padding: "4px 8px",
};

export function ReviewNote({
  bulletId,
  bulletExcerpt,
  threads,
  cv,
  needsSignoff,
  editableIds,
  staleIds,
  applying,
  dirtyCount,
  busy,
  hasLiveDiff,
  top,
  onAcceptFix,
  onSignOff,
  onDismiss,
  onViewDiff,
  onClose,
}: {
  bulletId: string;
  bulletExcerpt: string;
  /** The bullet's non-dismissed threads (usually one). */
  threads: ReviewThread[];
  cv: TailoredCV;
  needsSignoff: boolean;
  editableIds: ReadonlySet<string>;
  staleIds: ReadonlySet<string>;
  applying: boolean;
  dirtyCount: number;
  busy: boolean;
  hasLiveDiff: boolean;
  /** y (px, relative to the overlay) to anchor the card just below the bullet. */
  top: number;
  onAcceptFix: (t: ReviewThread) => void;
  onSignOff: (bulletId: string) => void;
  onDismiss: (key: string) => void;
  onViewDiff: () => void;
  /** `returnFocus` = restore focus to the marker (Escape/Dismiss), not on outside-click. */
  onClose: (returnFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inlineAcceptRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  // Focus into the card on open so a keyboard user lands on the note, not stranded on the marker.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const actionableCount = threads.filter((t) =>
    isAcceptableThread(t, staleIds, editableIds),
  ).length;
  const anyActionable = actionableCount > 0;
  const firstActionable = threads.find((t) => isAcceptableThread(t, staleIds, editableIds));
  // When dismissing a sibling collapses the shared "Accept & fix all (N)" back to the single inline
  // button, move focus onto that surviving control (it mounts on the next render — do it post-commit).
  const prevActionable = useRef(actionableCount);
  useEffect(() => {
    if (prevActionable.current > 1 && actionableCount === 1) inlineAcceptRef.current?.focus();
    prevActionable.current = actionableCount;
  }, [actionableCount]);
  const applyGated = dirtyCount > 0 || busy || applying;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose(true);
    }
  };

  return (
    <div
      ref={ref}
      className="ws-reviewnote"
      role="dialog"
      aria-modal="false"
      aria-label={`Review note on “${bulletExcerpt}”`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: "absolute",
        top: top + 8,
        right: 8,
        width: 320,
        maxWidth: "calc(100% - 16px)",
        zIndex: 3,
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 10,
        borderRadius: 12,
        background: "var(--panel)",
        border: "1px solid var(--line-strong)",
        boxShadow: "0 18px 44px -18px rgba(0, 0, 0, 0.55)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="cos-ghostbtn"
          aria-label="Close review note"
          onClick={() => onClose(true)}
          style={{
            width: 28,
            height: 28,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 7,
            border: "1px solid var(--line)",
            background: "transparent",
            color: "var(--text-2)",
            cursor: "pointer",
          }}
        >
          <span aria-hidden>✕</span>
        </button>
      </div>

      {threads.map((t) => {
        const actionable = isAcceptableThread(t, staleIds, editableIds);
        // ADR 0014: an APPLIED bullet's notes are resolved — read-only. Suppress Accept & fix (already
        // gated out of `actionable`) AND Dismiss, and show a static "Applied ✓" state that clears on the
        // next review run. Whole-bullet: the rewrite superseded the text these notes critiqued.
        const resolved = !!t.resolved;
        const verified = isSupportedFactCheck(t);
        // Dismissing unmounts this button; keep focus managed (else it drops to <body>, Codex P2). If
        // OTHER notes remain the card survives → hold focus on it; if this is the LAST note the card AND
        // the marker both unmount, so PreviewPanel's marker-loss effect moves focus after commit.
        const dismissButton = (
          <button
            type="button"
            className="cos-ghostbtn"
            onClick={() => {
              const last = threads.length <= 1;
              onDismiss(t.key);
              if (!last) ref.current?.focus();
            }}
            disabled={applying}
            style={{ ...buttonStyle("ghost", applying), minHeight: 44 }}
          >
            Dismiss
          </button>
        );
        return (
          <div key={t.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <ThreadCard thread={t} cv={cv} showAnchor={false} acceptable={actionable} hideActions />
            {resolved ? (
              <p
                style={{
                  ...hint,
                  margin: 0,
                  color: "var(--ok)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span aria-hidden>✓</span> Applied — re-run Review to re-check.
              </p>
            ) : verified ? (
              // A verified positive — read-only chip + Dismiss (no fix; not counted in "(N)").
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={verifiedChip}>
                  <span aria-hidden>✓</span> Verified
                </span>
                {dismissButton}
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                {/* One rewrite per line: with >1 actionable note the shared "Accept & fix all (N)"
                    below owns the action (so N identical buttons don't each apply everything). */}
                {actionable && actionableCount === 1 ? (
                  <button
                    ref={inlineAcceptRef}
                    type="button"
                    className="cos-brighten"
                    onClick={() => onAcceptFix(t)}
                    disabled={applyGated}
                    style={{ ...buttonStyle("primary", applyGated), flex: 1, minHeight: 44 }}
                  >
                    {applying ? "Fixing…" : "Accept & fix"}
                  </button>
                ) : null}
                {dismissButton}
              </div>
            )}
          </div>
        );
      })}

      {actionableCount > 1 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            type="button"
            className="cos-brighten"
            onClick={() => firstActionable && onAcceptFix(firstActionable)}
            disabled={applyGated}
            aria-describedby={hintId}
            aria-label={`Accept and fix, addresses all ${actionableCount} notes on this line`}
            style={{ ...buttonStyle("primary", applyGated), minHeight: 44 }}
          >
            {applying ? "Fixing…" : `Accept & fix all (${actionableCount})`}
          </button>
          <p id={hintId} style={{ ...hint, margin: 0 }}>
            Rewrites this line to address all {actionableCount} notes — dismiss any you don’t want
            first.
          </p>
        </div>
      ) : null}

      {needsSignoff || hasLiveDiff ? (
        <div
          style={{ display: "flex", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 10 }}
        >
          {needsSignoff ? (
            <button
              type="button"
              className="cos-brighten"
              onClick={() => onSignOff(bulletId)}
              disabled={dirtyCount > 0 || busy}
              style={{ ...buttonStyle("primary", dirtyCount > 0 || busy), flex: 1, minHeight: 44 }}
              title="Approve this net-new bullet so the CV can export"
            >
              Sign off to export
            </button>
          ) : null}
          {hasLiveDiff ? (
            <button
              type="button"
              className="cos-ghostbtn"
              onClick={onViewDiff}
              style={{ ...buttonStyle("ghost"), minHeight: 44 }}
            >
              View diff →
            </button>
          ) : null}
        </div>
      ) : null}

      {applying ? (
        <p style={{ ...hint, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="ws-spin" aria-hidden />
          Rewriting the line…
        </p>
      ) : dirtyCount > 0 && anyActionable ? (
        <p style={hint}>Save your edits first, then accept the fix.</p>
      ) : null}
    </div>
  );
}
