"use client";

// The right column: the live CV preview, mounting the SAME `ResumeTemplate` the PDF prints (invariant
// 3) so what you see is what exports. ResumeTemplate already renders the full 660px "paper" frame
// (border + deep shadow + serif), so this component is ONLY the surface AROUND it — the Claude design's
// dotted "drafting table" — plus the post-correction flash, the preview-only page-break guide, and
// (DevPR17) the in-margin review markers + the in-place ReviewNote. All of those are measured OVERLAY
// siblings of ResumeTemplate — zero changes under src/render/, and /print (which mounts ResumeTemplate
// directly, not this component) never sees them.
import {
  type CSSProperties,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Schemas } from "@/lib/api/client";
import { toResumeDocument } from "@/render/model";
import { ResumeTemplate } from "@/render/ResumeTemplate";
import { PAGE } from "@/render/template-tokens";
import { agentIdentity } from "@/ui";
import {
  type BulletMarker,
  bulletMarkers,
  type Decisions,
  type Drafts,
  editableItems,
  overlayDrafts,
  type ReviewThread,
  threadsForAnchor,
} from "./logic";
import { ReviewNote } from "./ReviewNote";
import { mono } from "./styles";
import { SOURCE_META } from "./ThreadCard";

const A4_PAGE_PX = 1122.5;
const FIRST_BREAK_OFFSET = -22;

const surface = {
  background: "var(--panel-2)",
  backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)",
  backgroundSize: "22px 22px",
  border: "1px solid var(--line)",
  borderRadius: 14,
} as const;

const flashOverlay = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  borderRadius: 3,
  animation: "flashfix 1.3s ease",
  pointerEvents: "none",
} as const;

const pageBreakLayer: CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };
const pageBreakRule: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  height: 0,
  borderTop: "1px dashed var(--line-strong)",
};
const pageBreakLabel: CSSProperties = {
  ...mono,
  position: "absolute",
  right: 6,
  top: -8,
  fontSize: 9,
  lineHeight: "15px",
  color: "var(--text-2)",
  background: "var(--panel-2)",
  border: "1px solid var(--line-strong)",
  borderRadius: 4,
  padding: "0 5px",
};

const EMPTY_SET: ReadonlySet<string> = new Set();
type Rect = { top: number; bottom: number };

export function PreviewPanel({
  bundle,
  drafts,
  optimistic,
  working,
  flash,
  editableBulletIds,
  editsSuspended,
  onDraftBullet,
  onCommitBullet,
  // DevPR17 — the in-margin markers + ReviewNote (all default-absent, so /print is unaffected).
  cv,
  inlineThreads,
  decisions,
  staleIds,
  editableIds,
  reviewing,
  dirtyCount = 0,
  busy = false,
  applying = false,
  hasLiveDiff = false,
  onAcceptFix,
  onSignOff,
  onDismiss,
  onViewDiff,
}: {
  bundle: Schemas["RenderBundle"] | null;
  drafts: Drafts;
  /** DevPR29 optimistic apply paint: bulletId → suggested text, render-only (never a draft). */
  optimistic?: Record<string, string>;
  working: boolean;
  flash: number | null;
  editableBulletIds?: ReadonlySet<string>;
  editsSuspended?: boolean;
  onDraftBullet?: (bulletId: string, text: string) => void;
  onCommitBullet?: (bulletId: string, text: string) => void;
  cv?: Schemas["TailoredCV"];
  inlineThreads?: ReviewThread[];
  decisions?: Decisions;
  staleIds?: ReadonlySet<string>;
  editableIds?: ReadonlySet<string>;
  reviewing?: boolean;
  dirtyCount?: number;
  busy?: boolean;
  applying?: boolean;
  hasLiveDiff?: boolean;
  onAcceptFix?: (t: ReviewThread) => void;
  onSignOff?: (bulletId: string) => void;
  onDismiss?: (key: string) => void;
  onViewDiff?: () => void;
}) {
  const paperWrapRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<{ bulletId: string; text: string } | null>(null);
  const editable = !editsSuspended ? editableBulletIds : undefined;
  const bulletIdOf = (e: FocusEvent | FormEvent): string | null =>
    (e.target as HTMLElement | null)?.dataset?.bulletId ?? null;
  const onPaperFocus = (e: FocusEvent) => {
    const id = bulletIdOf(e);
    if (id && editable?.has(id))
      setFocused({ bulletId: id, text: (e.target as HTMLElement).textContent ?? "" });
  };
  const onPaperBlur = (e: FocusEvent) => {
    const id = bulletIdOf(e);
    if (id && editable?.has(id)) {
      onCommitBullet?.(id, (e.target as HTMLElement).textContent ?? "");
      setFocused((cur) => (cur?.bulletId === id ? null : cur));
    }
  };

  // --- DevPR17: which bullets get a marker (settled-only), and their glyph/state ---------------------
  // One shared editableItems pass gives the sign-off set + each bullet's text (a distinguishing marker
  // label). The rendered/roving ORDER is by measured rect.top (below) — the renderer may sort work items
  // by recency, so authored order isn't the visual top-to-bottom order (Codex P2).
  const editItems = useMemo(() => (cv ? editableItems(cv) : []), [cv]);
  const needsSignoffIds = useMemo(
    () =>
      new Set(
        editItems.flatMap((g) => g.bullets.filter((b) => b.needsSignoff).map((b) => b.bulletId)),
      ),
    [editItems],
  );
  const bulletText = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of editItems) for (const b of g.bullets) m.set(b.bulletId, b.text);
    return m;
  }, [editItems]);
  const markers = useMemo<BulletMarker[]>(
    () =>
      reviewing || !inlineThreads
        ? []
        : bulletMarkers(
            inlineThreads,
            decisions ?? {},
            staleIds ?? EMPTY_SET,
            editableIds ?? EMPTY_SET,
          ),
    [reviewing, inlineThreads, decisions, staleIds, editableIds],
  );
  const markersRef = useRef<BulletMarker[]>(markers);
  markersRef.current = markers;

  // y-offsets of the page boundaries; and (DevPR17) each marked bullet's top/bottom relative to `wrap`.
  const [breaks, setBreaks] = useState<number[]>([]);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  // Rendered + roving order = the measured VISUAL top-to-bottom order (the set drives measurement above).
  const orderedMarkers = useMemo(
    () =>
      [...markers].sort((a, b) => (rects[a.bulletId]?.top ?? 0) - (rects[b.bulletId]?.top ?? 0)),
    [markers, rects],
  );

  // Positions ONLY (glyph/state derive from live props in render). Stable (reads refs), so the effect +
  // ResizeObserver + the input re-measure all share it without re-creating the observer per keystroke.
  const measure = useCallback(() => {
    const wrap = paperWrapRef.current;
    if (!wrap) {
      setBreaks([]);
      setRects({});
      return;
    }
    const paper = wrap.querySelector<HTMLElement>("article");
    // Below the 660px full width the paper has reflowed and the A4/marker mapping no longer holds → hide.
    if (!paper || Math.abs(paper.offsetWidth - PAGE.maxWidthPx) > 1) {
      setBreaks([]);
      setRects({});
      return;
    }
    const nextBreaks: number[] = [];
    for (let y = A4_PAGE_PX + FIRST_BREAK_OFFSET; y < paper.offsetHeight - 4; y += A4_PAGE_PX)
      nextBreaks.push(y);
    setBreaks(nextBreaks);
    // getBoundingClientRect delta — offsetParent-agnostic (each bullet's offsetParent is its own
    // `data-line` wrapper, so bare offsetTop would be ~0 and stack every marker at the top).
    const wrapTop = wrap.getBoundingClientRect().top;
    const nextRects: Record<string, Rect> = {};
    for (const m of markersRef.current) {
      const el = wrap.querySelector<HTMLElement>(`[data-bullet-id="${CSS.escape(m.bulletId)}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        nextRects[m.bulletId] = { top: r.top - wrapTop, bottom: r.bottom - wrapTop };
      }
    }
    setRects(nextRects);
  }, []);

  // Mount / ResizeObserver — keyed to `bundle` only (no churn per keystroke/decision).
  useEffect(() => {
    const wrap = paperWrapRef.current;
    if (!bundle || !wrap) {
      setBreaks([]);
      setRects({});
      return;
    }
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [bundle, measure]);

  // Re-measure when the SET of marked bullets changes (threads land after `bundle`, or a note is
  // dismissed) — positions only, doesn't touch the observer lifecycle.
  const markerKey = markers.map((m) => m.bulletId).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: markerKey is the stable signal for measure.
  useEffect(() => {
    measure();
  }, [markerKey, measure]);

  const scheduleMeasure = useCallback(() => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure);
    else measure();
  }, [measure]);
  const onPaperInput = (e: FormEvent) => {
    const id = bulletIdOf(e);
    if (id && editable?.has(id)) onDraftBullet?.(id, (e.target as HTMLElement).textContent ?? "");
    if (markersRef.current.length > 0) scheduleMeasure(); // the edited paper reflows → re-place markers
  };

  // --- selection + roving keyboard ------------------------------------------------------------------
  const [selected, setSelected] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const markerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Clear a selection whose bullet lost its marker (dismissed / applied / re-review), and keep the
  // roving tab stop valid — if the active marker was the last one and got removed, `activeIdx` would
  // point past the shortened array and NO marker would be tabbable (Codex P2).
  useEffect(() => {
    if (selected && !markers.some((m) => m.bulletId === selected)) {
      setSelected(null);
      // The selected note + its marker unmounted (a last-note dismiss), so focus fell to <body>. After
      // commit, move it to a surviving target — the first remaining marker, else the preview pane — so
      // keyboard users aren't stranded (Codex P2). Skip if focus already landed somewhere in-preview.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          const ae = document.activeElement;
          if (ae && ae !== document.body && paperWrapRef.current?.contains(ae)) return;
          const first = markers[0]?.bulletId;
          const target =
            (first ? markerRefs.current[first] : null) ??
            paperWrapRef.current?.closest<HTMLElement>("[tabindex]");
          target?.focus();
        });
      }
    }
    setActiveIdx((i) => (i >= markers.length ? Math.max(0, markers.length - 1) : i));
  }, [markers, selected]);
  const closeNote = useCallback(
    (returnFocus: boolean) => {
      const id = selected;
      setSelected(null);
      if (returnFocus && id) markerRefs.current[id]?.focus();
    },
    [selected],
  );
  // Outside-click closes WITHOUT stealing focus back to the marker.
  useEffect(() => {
    if (!selected) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      const note = paperWrapRef.current?.querySelector(".ws-reviewnote");
      const marker = markerRefs.current[selected];
      if (note?.contains(t) || marker?.contains(t)) return;
      setSelected(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selected]);

  const onMarkerKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const dir =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (dir === 0) return;
    e.preventDefault();
    const n = Math.max(0, Math.min(orderedMarkers.length - 1, i + dir));
    const next = orderedMarkers[n];
    if (!next) return;
    setActiveIdx(n);
    markerRefs.current[next.bulletId]?.focus();
  };

  const showMarkers = markers.length > 0 && Object.keys(rects).length > 0;
  const selectedMarker = selected ? markers.find((m) => m.bulletId === selected) : null;
  const selectedRect = selected ? rects[selected] : undefined;
  const selectedThreads =
    selected && inlineThreads
      ? threadsForAnchor(inlineThreads, "bullet", selected).filter(
          (t) => decisions?.[t.key] !== "rejected",
        )
      : [];

  return (
    <section style={{ flex: "2 1 460px", minWidth: 0 }}>
      {/* Why the paper is read-only mid-run: an edit during the stream would bump the CV version and the
          review couldn't persist. Editable/non-editable bullets look identical, so say it out loud. NOT a
          live region — AgentChecklist already owns the ONE polite region during a review (Codex P3); this
          is a visible-only caption. No animation → reduced-motion safe. */}
      {reviewing && bundle ? (
        <p
          style={{
            ...mono,
            margin: "0 0 10px",
            padding: "7px 11px",
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: "var(--panel-2)",
            color: "var(--text-2)",
            fontSize: 11.5,
            textAlign: "center",
          }}
        >
          Editing paused while the review runs — it unlocks when screening finishes.
        </p>
      ) : null}
      {bundle ? (
        <div className="ws-preview-surface" style={surface}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: edit events are delegated off the
              contentEditable bullets inside (data-bullet-id); the wrapper itself isn't the control. */}
          <div
            ref={paperWrapRef}
            style={{ position: "relative", maxWidth: 660, margin: "0 auto" }}
            onFocus={onPaperFocus}
            onInput={onPaperInput}
            onBlur={onPaperBlur}
          >
            <ResumeTemplate
              doc={toResumeDocument(overlayDrafts(bundle, drafts, focused, optimistic))}
              editableBulletIds={editable}
            />
            {flash !== null ? <div key={flash} style={flashOverlay} aria-hidden /> : null}
            {breaks.length > 0 ? (
              <div aria-hidden style={pageBreakLayer}>
                {breaks.map((y, i) => {
                  // The chip yields to a marker: hide it when a marker sits within ~14px of this
                  // boundary (the marker is interactive + must stay glued; the chip is decorative).
                  const clash = showMarkers
                    ? Object.values(rects).some((r) => Math.abs(r.top - y) < 14)
                    : false;
                  return (
                    <div key={y} style={{ ...pageBreakRule, top: y }}>
                      {clash ? null : <span style={pageBreakLabel}>page {i + 2}</span>}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* DevPR17 marker layer — pointer-events:none; only the glyph buttons take clicks. */}
            {showMarkers ? (
              <div
                className="ws-marker-layer"
                role="toolbar"
                aria-label="Review markers"
                aria-orientation="vertical"
                style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
              >
                {orderedMarkers.map((m, i) => {
                  const rect = rects[m.bulletId];
                  if (!rect) return null;
                  const id = agentIdentity(m.source);
                  const label = SOURCE_META[m.source]?.label ?? "Review";
                  const isSel = selected === m.bulletId;
                  // A bullet excerpt distinguishes repeated same-reviewer markers to AT (Codex P2).
                  const excerpt = (bulletText.get(m.bulletId) ?? "").trim().slice(0, 40);
                  // Verified-only: nothing to fix on the line, only positive fact-check(s). A distinct
                  // hollow ✓ (below the resolved-green ✓), so it's never mistaken for an actionable note.
                  const verifiedOnly =
                    m.actionableCount === 0 && m.verifiedCount > 0 && !m.resolved;
                  // Compose the aria so applied/stale/excerpt survive; append the actionable/verified
                  // breakdown, suppressing "0 to fix" (an all-verified/resolved/stale bullet).
                  const ariaParts = [`${label} note`];
                  if (excerpt) ariaParts.push(`on “${excerpt}”`);
                  // Announce the fixable count whenever there is one (incl. a single note on a
                  // mixed bullet where the primary label may be a verified fact-check) — only "0 to
                  // fix" is suppressed. Codex P2.
                  if (m.actionableCount > 0) ariaParts.push(`${m.actionableCount} to fix`);
                  if (m.verifiedCount > 0) ariaParts.push(`${m.verifiedCount} verified`);
                  if (m.resolved) ariaParts.push("applied");
                  else if (m.stale) ariaParts.push("edited since review");
                  return (
                    <button
                      key={m.bulletId}
                      ref={(el) => {
                        markerRefs.current[m.bulletId] = el;
                      }}
                      type="button"
                      className={`ws-marker${isSel ? " is-selected" : ""}${m.resolved ? " is-resolved" : m.stale ? " is-stale" : ""}`}
                      aria-label={ariaParts.join(", ")}
                      aria-pressed={isSel}
                      tabIndex={i === activeIdx ? 0 : -1}
                      onClick={() => {
                        setActiveIdx(i);
                        setSelected((cur) => (cur === m.bulletId ? null : m.bulletId));
                      }}
                      onKeyDown={(e) => onMarkerKeyDown(e, i)}
                      style={{
                        position: "absolute",
                        top: rect.top - 4,
                        right: 4,
                        width: 44,
                        height: 44,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        pointerEvents: "auto",
                      }}
                    >
                      <span
                        className="ws-marker-glyph"
                        aria-hidden
                        style={{
                          position: "relative",
                          width: 24,
                          height: 24,
                          borderRadius: 7,
                          // Resolved (applied) → solid green ✓ (precedence); verified-only → hollow ✓
                          // (outline, muted — never confused with the green applied ✓); else agent glyph.
                          background: m.resolved
                            ? "var(--ok)"
                            : verifiedOnly
                              ? "transparent"
                              : id.color,
                          color: m.resolved
                            ? "var(--text)"
                            : verifiedOnly
                              ? "var(--text-2)"
                              : id.ink,
                          border: verifiedOnly ? "1px solid var(--line-strong)" : "none",
                          ...mono,
                          fontSize: m.resolved || verifiedOnly ? 12 : 10,
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {m.resolved || verifiedOnly ? "✓" : id.glyph}
                        {m.actionableCount > 1 ? (
                          <span
                            style={{
                              position: "absolute",
                              top: -6,
                              right: -6,
                              minWidth: 14,
                              height: 14,
                              borderRadius: 7,
                              padding: "0 3px",
                              background: "var(--panel)",
                              color: "var(--text)",
                              border: "1px solid var(--line-strong)",
                              fontSize: 8.5,
                              lineHeight: "12px",
                              textAlign: "center",
                            }}
                          >
                            {m.actionableCount}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {selected && selectedMarker && selectedRect && cv && selectedThreads.length > 0 ? (
              <ReviewNote
                bulletId={selected}
                bulletExcerpt={(
                  paperWrapRef.current?.querySelector(`[data-bullet-id="${CSS.escape(selected)}"]`)
                    ?.textContent ?? ""
                ).slice(0, 48)}
                threads={selectedThreads}
                cv={cv}
                needsSignoff={needsSignoffIds.has(selected)}
                editableIds={editableIds ?? EMPTY_SET}
                staleIds={staleIds ?? EMPTY_SET}
                applying={applying}
                dirtyCount={dirtyCount}
                busy={busy}
                hasLiveDiff={hasLiveDiff}
                top={selectedRect.bottom}
                onAcceptFix={(t) => onAcceptFix?.(t)}
                onSignOff={(id) => onSignOff?.(id)}
                onDismiss={(key) => onDismiss?.(key)}
                onViewDiff={() => onViewDiff?.()}
                onClose={closeNote}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div
          style={{
            ...mono,
            fontSize: 12,
            color: "var(--text-3)",
            border: "1px dashed var(--line-strong)",
            borderRadius: 14,
            padding: "48px 24px",
            textAlign: "center",
          }}
        >
          {working ? "Tailoring your CV…" : "Your tailored CV preview will appear here."}
        </div>
      )}
    </section>
  );
}
