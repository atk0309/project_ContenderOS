/**
 * Per-agent review threads, grouped into collapsible disclosures (PR-2b-ii). Read-only. Each adjudicator
 * gets a native <details> (uncontrolled — collapsed by default, so a streaming re-render never snaps an
 * opened one shut). Honest per-agent state from the live checklist gated on stream-settled: screening… /
 * couldn't run (the real surface that replaces PR-2a's "N reviewers couldn't run" stub) / no findings /
 * the thread cards. Panel-routed threads only — bullet threads on editable bullets render inline.
 */
import type { CSSProperties } from "react";
import type { Schemas } from "@/lib/api/client";
import type { Checklist } from "@/lib/sse";
import {
  AGENT_STATUS_TEXT,
  agentState,
  failureLabel,
  orphanedThreads,
  type ReviewSource,
  type ReviewThread,
  SOURCE_AGENT_ID,
} from "./logic";
import { SOURCE_META, ThreadCard } from "./ThreadCard";

type TailoredCV = Schemas["TailoredCV"];
type ReviewBundle = Schemas["ReviewBundle"];

const SOURCES: ReviewSource[] = ["editor", "factCheck", "spotter", "gatekeeper"];
const mono = { fontFamily: "var(--mono)" } as const;
const muted: CSSProperties = { ...mono, fontSize: 10.5, color: "var(--text-3)", margin: "6px 0 0" };
const summary: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minHeight: 44,
  cursor: "pointer",
  fontSize: 12.5,
  color: "var(--text)",
};

export function ThreadList({
  bundle,
  cv,
  panelThreads,
  inlineCountBySource,
  checklist,
  settled,
  stale = false,
}: {
  bundle: ReviewBundle;
  cv: TailoredCV;
  panelThreads: ReviewThread[];
  inlineCountBySource: Record<ReviewSource, number>;
  checklist: Checklist;
  settled: boolean;
  /** The review is version-drifted (ADR 0016): DESATURATION ONLY (the source dots colour-mix toward
   *  `--line`) — no text line here, and the orphaned-notes footnote drops its "re-run" tail; the
   *  rail's single carrier (card chip / drift caption) owns the canonical phrase + re-run
   *  instruction, and the status words keep their shipped inks. */
  stale?: boolean;
}) {
  const orphanKeys = new Set(orphanedThreads(panelThreads, cv).map((t) => t.key));
  const live = panelThreads.filter((t) => !orphanKeys.has(t.key));
  const orphans = panelThreads.filter((t) => orphanKeys.has(t.key));

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      {SOURCES.map((source) => {
        const state = agentState(checklist, bundle.failures, SOURCE_AGENT_ID[source], settled);
        if (state === "absent") return null; // job-dependent agent that didn't apply (verdict copy covers it)
        const threads = live.filter((t) => t.source === source);
        const inlineN = inlineCountBySource[source] ?? 0;
        // Skip a bare empty Recruiter row — its verdict card sits right above, so "no findings" there is noise.
        if (source === "gatekeeper" && state === "done" && threads.length === 0 && inlineN === 0)
          return null;
        const overall = source === "editor" ? bundle.editor?.overall : undefined;
        const detail = bundle.failures.find((f) => f.agentId === SOURCE_AGENT_ID[source])?.detail;
        // ThreadList is settled-only, so a non-terminal status means the stream ended mid-flight
        // for this agent (stopped / dropped) — it may still have a partial report we should show.
        const interrupted = state === "running" || state === "pending";

        return (
          <details key={source} style={{ borderTop: "1px solid var(--line)", paddingTop: 2 }}>
            <summary style={summary}>
              <span
                style={{
                  ...tagDot,
                  background: stale
                    ? `color-mix(in srgb, ${SOURCE_META[source].color} 45%, var(--line))`
                    : SOURCE_META[source].color,
                }}
                aria-hidden
              />
              <span>{SOURCE_META[source].label}</span>
              <span style={{ ...mono, fontSize: 11, color: "var(--text-3)" }}>
                {state === "failed"
                  ? AGENT_STATUS_TEXT.failed
                  : state === "running" || state === "pending"
                    ? AGENT_STATUS_TEXT.interrupted // settled-only: a non-terminal agent was interrupted
                    : threads.length > 0
                      ? `${threads.length}`
                      : inlineN > 0
                        ? `${inlineN} inline` // all findings routed inline — not "no findings" (Codex)
                        : overall
                          ? AGENT_STATUS_TEXT.note // editor's `overall` is real feedback even w/o cards
                          : "no findings"}
              </span>
            </summary>

            <div style={{ padding: "4px 0 10px" }}>
              {state === "failed" ? (
                <p style={{ ...mono, fontSize: 11, color: "var(--ink-warn)", margin: 0 }}>
                  Couldn’t run — {failureLabel(detail ?? "failed")}. Re-run to try again.
                </p>
              ) : (
                <>
                  {/* An interrupted agent (settled but never got its terminal done) may STILL have
                      landed a partial report — warn, but render what arrived rather than hiding it. */}
                  {interrupted ? (
                    <p
                      style={{ ...mono, fontSize: 11, color: "var(--ink-warn)", margin: "0 0 6px" }}
                    >
                      Didn’t finish — re-run to try again.
                    </p>
                  ) : null}
                  {overall ? (
                    <p
                      style={{
                        margin: "0 0 8px",
                        fontSize: 12.5,
                        color: "var(--text-2)",
                        lineHeight: 1.5,
                      }}
                    >
                      {overall}
                    </p>
                  ) : null}
                  {threads.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {threads.map((t) => (
                        <ThreadCard key={t.key} thread={t} cv={cv} showAnchor />
                      ))}
                    </div>
                  ) : null}
                  {inlineN > 0 ? (
                    <p style={muted}>
                      {inlineN} {threads.length > 0 ? "more " : ""}shown inline on the editable
                      bullet{inlineN > 1 ? "s" : ""} in the editor.
                    </p>
                  ) : null}
                  {threads.length === 0 && inlineN === 0 && !overall && !interrupted ? (
                    <p style={muted}>No findings.</p>
                  ) : null}
                </>
              )}
            </div>
          </details>
        );
      })}

      {/* The "re-run Review" tail rides ONLY while the review is fresh — when stale, the rail's
          single canonical carrier (card chip / drift caption) owns the re-run instruction. */}
      {orphans.length > 0 ? (
        <p style={muted}>
          {orphans.length} note{orphans.length > 1 ? "s" : ""} no longer match this CV (anchored to
          removed content){stale ? "." : " — re-run Review to refresh."}
        </p>
      ) : null}
    </div>
  );
}

const tagDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };
