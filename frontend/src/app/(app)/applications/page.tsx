"use client";

// Applications tracker — the owner's list of jobs they've applied to, each holding the exact (locked,
// immutable) CV that was sent. Reskinned to the Claude design (docs/design/Contender.dc.html, the
// `isTracker` block): collapsible rows, the stage pipeline as clickable dots, and a per-row expanded
// record (posting / CV-used / recruiter / stage history + move-to buttons). The (app) shell's
// SessionProvider owns the auth gate; every allowlisted account is an owner (invariant 8).
//
// Data: the list endpoint returns lightweight `ApplicationSummary` rows (id/title/company/stage/
// appliedAt/cvId); the full `Application` (events timeline, stages, jobUrl) is lazy-fetched on expand.
// Move-stage and the recruiter contact are real backend mutations (PATCH …/stage, PATCH …/recruiter)
// that each return the updated Application. Recruiter is owner-editable + persisted (an explicit,
// validated Save; only a genuine same-row overlap with a stage move is last-write-wins, invariant 7).

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Schemas } from "@/lib/api/client";
import { buttonStyle, fieldLabel, inputStyle, StageDots, tagStyle } from "@/ui";
import { isSafeHttpUrl } from "../workspace/logic";
import {
  applicationLabel,
  FOCUS_HEADING_KEY,
  isLikelyEmail,
  isTerminalStage,
  listApplicationsRequest,
  type MoveOption,
  moveOptions,
  pipelineDots,
  readApplicationRequest,
  stageSummary,
  stageTitle,
  stageTone,
  trackerCounts,
  updateRecruiterRequest,
  updateStageRequest,
} from "./logic";

type ApplicationSummary = Schemas["ApplicationSummary"];
type Application = Schemas["Application"];

// Persist the recruiter contact — resolves with the server record (or throws so the card maps a 422).
type SaveRecruiter = (
  appId: string,
  body: { recruiterName: string | null; recruiterEmail: string | null },
) => Promise<Application>;

type ListState =
  | { status: "loading" }
  | { status: "ready"; items: ApplicationSummary[] }
  | { status: "error" };

// Per-row detail (the full Application), lazily fetched when a row first expands.
type RowDetail =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; app: Application };

const TONE_VAR: Record<MoveOption["tone"], string> = {
  accent: "var(--accent)",
  ok: "var(--ok)",
  bad: "var(--bad)",
  muted: "var(--text-3)",
};

export default function ApplicationsPage() {
  const router = useRouter();

  const [state, setState] = useState<ListState>({ status: "loading" });
  const [details, setDetails] = useState<Record<string, RowDetail | undefined>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // A polite status line announces in-progress / success move outcomes (a move re-paints dots
  // silently otherwise); a failed move also shows a visible alert (sighted users need feedback too).
  const [live, setLive] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);

  // Guard overlapping list fetches (mount / pageshow / visibility): only the latest, and only while
  // mounted, may commit. Per-id refs single-flight the lazy detail load + the move mutation.
  const reqRef = useRef(0);
  const mountedRef = useRef(true);
  const detailInFlight = useRef<Set<string>>(new Set());
  const moveInFlight = useRef<Set<string>>(new Set());
  // Per-row detail-request generation: a detail GET only commits if it's still the latest for that
  // row, and a move() bumps it so a slower in-flight GET can't overwrite the move's fresh record.
  const detailGenRef = useRef<Record<string, number>>({});
  // Latest known summary stage per row (from the list / a move). A detail GET also checks this before
  // committing, so an external stage change (e.g. another tab) can't land a stale record under a
  // newer summary; on a mismatch the row re-fetches.
  const summaryStageRef = useRef<Record<string, string>>({});
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    const id = ++reqRef.current;
    // Don't blank an already-loaded list to a spinner on background refreshes (pageshow/visibility) —
    // it would flicker the rows + lose the open row, and (since a move() bumps reqRef to invalidate an
    // in-flight GET) could strand the page in "loading" if a move lands mid-refresh. Show the spinner
    // only on the first load / after an error; otherwise refresh the rows in place.
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    api<ApplicationSummary[]>(listApplicationsRequest().path)
      .then((items) => {
        if (!mountedRef.current || reqRef.current !== id) return;
        setState({ status: "ready", items });
        // Keep cached detail for rows still present (no spinner flash on benign tab-return refreshes),
        // but DROP one whose stage no longer matches the refreshed summary (stale → re-fetch on the
        // open row), and prune entries for vanished applications. Collapse a row that vanished.
        const present = new Set(items.map((i) => i.id));
        const stageById = new Map(items.map((i) => [i.id, i.stage]));
        summaryStageRef.current = Object.fromEntries(stageById);
        setDetails((d) => {
          const next: Record<string, RowDetail | undefined> = {};
          for (const key of Object.keys(d)) {
            if (!present.has(key)) continue;
            const cached = d[key];
            if (cached?.status === "ready" && cached.app.stage !== stageById.get(key)) continue;
            next[key] = cached;
          }
          return next;
        });
        setExpandedId((prev) => (prev && present.has(prev) ? prev : null));
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || reqRef.current !== id) return;
        // A mid-session expiry bounces to sign-in rather than a dead-end Retry that just re-401s.
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        setState({ status: "error" });
      });
  }, [router]);

  useEffect(() => {
    load();
    if (typeof window !== "undefined" && sessionStorage.getItem(FOCUS_HEADING_KEY)) {
      sessionStorage.removeItem(FOCUS_HEADING_KEY);
      headingRef.current?.focus();
    }
    // Refresh on return so a just-applied CV (or a stage change) shows up; bfcache restores skip the
    // effect, so `pageshow`/`persisted` is the reliable signal (mirrors Home).
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) load();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const loadDetail = useCallback(
    async (appId: string) => {
      if (detailInFlight.current.has(appId)) return;
      detailInFlight.current.add(appId);
      const gen = (detailGenRef.current[appId] ?? 0) + 1;
      detailGenRef.current[appId] = gen;
      // Only commit if this is still the latest detail request for the row (a move() that landed while
      // this GET was in flight bumps the generation, so the move's fresh record wins, not this stale one).
      const isCurrent = () => mountedRef.current && detailGenRef.current[appId] === gen;
      // Snapshot the summary stage at request start. We reject the result only if the summary *changed*
      // during the GET (a newer list landed) — NOT if it merely differs (the fetched record may be the
      // fresher truth, e.g. an external move not yet list-refreshed; rejecting on a bare difference would
      // loop "Loading…" forever).
      const startStage = summaryStageRef.current[appId];
      setDetails((d) => ({ ...d, [appId]: { status: "loading" } }));
      try {
        const app = await api<Application>(readApplicationRequest(appId).path);
        if (!isCurrent()) return;
        if (summaryStageRef.current[appId] !== startStage) {
          // A newer summary arrived mid-GET → this record may be stale; drop so the open row re-fetches
          // against the new summary (the re-fetch snapshots that new value, so it converges — no loop).
          setDetails((d) => ({ ...d, [appId]: undefined }));
          return;
        }
        // The fetched Application is the freshest truth for this row. If its stage differs from the
        // (stable) summary, the summary was stale-older (e.g. an external move) — adopt the record's
        // stage into the ref + the visible collapsed row so the dots can't drift from the timeline.
        if (app.stage !== startStage) {
          summaryStageRef.current[appId] = app.stage;
          setState((s) =>
            s.status === "ready"
              ? {
                  ...s,
                  items: s.items.map((it) => (it.id === appId ? { ...it, stage: app.stage } : it)),
                }
              : s,
          );
        }
        setDetails((d) => ({ ...d, [appId]: { status: "ready", app } }));
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        // Deleted between list + expand: refreshing the list prunes the row (a Retry would just
        // re-404). Otherwise surface the retryable error in the panel.
        if (err instanceof ApiError && err.status === 404) {
          load();
          return;
        }
        if (isCurrent()) setDetails((d) => ({ ...d, [appId]: { status: "error" } }));
      } finally {
        detailInFlight.current.delete(appId);
      }
    },
    [router, load],
  );

  const toggle = useCallback((appId: string) => {
    setExpandedId((prev) => (prev === appId ? null : appId));
  }, []);

  // Advance the pipeline (from a collapsed dot OR an expanded button). Updates the summary's stage
  // (so the dots re-paint) and the cached detail (so the timeline grows) from server truth.
  const move = useCallback(
    async (appId: string, current: string, label: string, stage: string) => {
      if (stage === current || moveInFlight.current.has(appId)) return;
      moveInFlight.current.add(appId);
      setMoveError(null);
      setLive(`Moving ${label} to ${stageTitle(stage)}…`);
      try {
        const req = updateStageRequest(appId, { stage });
        const updated = await api<Application>(req.path, req.init);
        if (!mountedRef.current) return;
        // Invalidate any list GET *and* any in-flight detail GET for this row that was running when
        // this move committed: their snapshots predate the mutation, so letting them commit would
        // revert the row / its record. Bumping the generations makes those stale responses fail their
        // latest-wins checks (a fresh load()/loadDetail() started AFTER this gets a higher id).
        reqRef.current += 1;
        detailGenRef.current[appId] = (detailGenRef.current[appId] ?? 0) + 1;
        summaryStageRef.current[appId] = updated.stage;
        setState((s) =>
          s.status === "ready"
            ? {
                ...s,
                items: s.items.map((it) =>
                  it.id === appId ? { ...it, stage: updated.stage } : it,
                ),
              }
            : s,
        );
        setDetails((d) => ({ ...d, [appId]: { status: "ready", app: updated } }));
        setLive(`${label} moved to ${stageTitle(updated.stage)}.`);
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        // Surface the failure both visibly (a sighted user gets no other cue) and to AT (role=alert).
        if (mountedRef.current) setMoveError(`Couldn’t move ${label} — please try again.`);
      } finally {
        moveInFlight.current.delete(appId);
      }
    },
    [router],
  );

  const onOpenCv = useCallback(
    (appId: string) => {
      router.push(`/applications/${encodeURIComponent(appId)}`);
    },
    [router],
  );

  // Persist the recruiter contact (owner-only PATCH …/recruiter). Single-flight is owned by the card's
  // disabled Save button; here we invalidate any in-flight detail GET whose snapshot predates the save
  // (mirrors `move()`), commit the server record, and announce via the polite live region. A recruiter
  // save never changes `stage`, so the summary is untouched; a rare same-row overlap with a move is
  // last-write-wins (invariant 7). Throws so the card can map a 422 to its inline email error.
  const saveRecruiter = useCallback(
    async (
      appId: string,
      body: { recruiterName: string | null; recruiterEmail: string | null },
    ): Promise<Application> => {
      const req = updateRecruiterRequest(appId, body);
      // Distinct in-progress → success text (like move()) so a repeat save on the same page still
      // changes the polite region and re-announces — a constant string wouldn't (Codex P3).
      setLive("Saving recruiter…");
      try {
        const updated = await api<Application>(req.path, req.init);
        if (mountedRef.current) {
          // A recruiter save never changes `stage` — but under the documented last-write-wins overlap
          // (a concurrent move won last) the response can carry a newer `stage`. Reconcile the summary
          // from it exactly like move() so the collapsed dots can't drift from the expanded timeline
          // (recruiter fields stay off the summary). Bumping reqRef/detailGenRef invalidates a stale
          // in-flight list/detail GET so it can't revert the just-saved record.
          reqRef.current += 1;
          detailGenRef.current[appId] = (detailGenRef.current[appId] ?? 0) + 1;
          summaryStageRef.current[appId] = updated.stage;
          setState((s) =>
            s.status === "ready"
              ? {
                  ...s,
                  items: s.items.map((it) =>
                    it.id === appId ? { ...it, stage: updated.stage } : it,
                  ),
                }
              : s,
          );
          setDetails((d) => ({ ...d, [appId]: { status: "ready", app: updated } }));
          setLive("Recruiter saved.");
        }
        return updated;
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          throw err;
        }
        // Clear the "Saving…" announce (the card surfaces the failure via its own role=alert).
        if (mountedRef.current) setLive("");
        throw err;
      }
    },
    [router],
  );

  const counts = state.status === "ready" ? trackerCounts(state.items) : { active: 0, total: 0 };

  return (
    <div style={page}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 ref={headingRef} tabIndex={-1} style={title}>
          Applications
        </h1>
        {state.status === "ready" ? (
          <span style={mono(12, "var(--text-3)")}>
            {counts.active} active · {counts.total} total
          </span>
        ) : null}
      </div>
      {/* Instructional copy is essential (rubric §6) → --text-2, not the mockup's muted --text-3. */}
      <div style={{ ...mono(10.5, "var(--text-2)"), margin: "6px 0 16px" }}>
        Tap a stage dot to move an application · open a row for its full record
      </div>

      {/* Polite live region for in-progress / success move announces (the dots change silently for AT
          otherwise). Failures render in the visible alert below. */}
      <div role="status" aria-live="polite" style={srOnly}>
        {live}
      </div>
      {moveError ? (
        <div role="alert" style={{ ...errorBox, marginBottom: 12 }}>
          {moveError}
        </div>
      ) : null}

      {state.status === "loading" ? <Muted>Loading your applications…</Muted> : null}
      {state.status === "error" ? (
        <div role="alert" style={errorBox}>
          Couldn&rsquo;t load your applications.{" "}
          <button type="button" onClick={load} style={inlineRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {state.status === "ready" && state.items.length === 0 ? (
        <Muted>No applications yet — apply to a job from the Workspace.</Muted>
      ) : null}

      {state.status === "ready" && state.items.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {state.items.map((app) => (
            <TrackerRow
              key={app.id}
              app={app}
              expanded={expandedId === app.id}
              detail={details[app.id]}
              onToggle={toggle}
              onMove={move}
              onLoadDetail={loadDetail}
              onOpenCv={onOpenCv}
              onSaveRecruiter={saveRecruiter}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TrackerRow({
  app,
  expanded,
  detail,
  onToggle,
  onMove,
  onLoadDetail,
  onOpenCv,
  onSaveRecruiter,
}: {
  app: ApplicationSummary;
  expanded: boolean;
  detail: RowDetail | undefined;
  onToggle: (id: string) => void;
  onMove: (id: string, current: string, label: string, stage: string) => void;
  onLoadDetail: (id: string) => void;
  onOpenCv: (id: string) => void;
  onSaveRecruiter: SaveRecruiter;
}) {
  const label = applicationLabel(app);
  const terminal = isTerminalStage(app.stage);
  const panelId = `app-panel-${app.id}`;

  // Lazy-load the full record the first time the row expands (self-heals if a list refresh cleared
  // the cache while still open).
  useEffect(() => {
    if (expanded && detail === undefined) onLoadDetail(app.id);
  }, [expanded, detail, onLoadDetail, app.id]);

  return (
    <div style={rowCard}>
      <div style={rowHead}>
        {/* The sole disclosure control (keyboard + SR). Phrasing-content children only (spans), since
            a <button> can't contain block <div>s. The hover tint is scoped to this button — only it
            (not the whole row) toggles — so the affordance is honest. */}
        <button
          type="button"
          aria-expanded={expanded}
          // Only reference the panel while it exists (it's rendered only when expanded) — a dangling
          // IDREF is invalid ARIA.
          aria-controls={expanded ? panelId : undefined}
          aria-label={`${label}, stage ${stageTitle(app.stage)}`}
          onClick={() => onToggle(app.id)}
          className="cos-trackrow-toggle"
          style={expandBtn}
        >
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 8px" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
              {/* Truthy (not ??): a blank company string falls through to the job title (matches
                  `applicationLabel` + the secondary line below), so the row is never unlabeled. */}
              {app.company || app.jobTitle}
            </span>
            {terminal ? (
              <span style={terminalBadge(app.stage)}>{stageTitle(app.stage)}</span>
            ) : null}
          </span>
          {app.company ? (
            <span
              style={{ display: "block", fontSize: 12.5, color: "var(--text-2)", marginTop: 2 }}
            >
              {app.jobTitle}
            </span>
          ) : null}
          <span style={{ ...mono(10, "var(--text-3)"), display: "block", marginTop: 5 }}>
            Applied {fmtDate(app.appliedAt)}
          </span>
        </button>

        <div style={{ flex: "none", width: 372, maxWidth: "100%" }}>
          <StageDots
            stages={pipelineDots(app.stage)}
            company={label}
            onPick={(stage) => onMove(app.id, app.stage, label, stage)}
          />
        </div>

        {/* Decorative state indicator only (rotates on expand). The expand button is the real control;
            hidden at phone width so it doesn't orphan onto its own wrapped line. */}
        <span aria-hidden className="cos-rowchevron" style={chevronBox}>
          <ChevronIcon rotated={expanded} />
        </span>
      </div>

      {expanded ? (
        <section id={panelId} aria-label={`${label} record`} style={panel}>
          {!detail || detail.status === "loading" ? (
            <Muted>Loading the full record…</Muted>
          ) : detail.status === "error" ? (
            <div role="alert" style={errorBox}>
              Couldn&rsquo;t load this record.{" "}
              <button type="button" onClick={() => onLoadDetail(app.id)} style={inlineRetry}>
                Retry
              </button>
            </div>
          ) : (
            <RecordPanel
              app={detail.app}
              label={label}
              onMove={onMove}
              onOpenCv={onOpenCv}
              onSaveRecruiter={onSaveRecruiter}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}

function RecordPanel({
  app,
  label,
  onMove,
  onOpenCv,
  onSaveRecruiter,
}: {
  app: Application;
  label: string;
  onMove: (id: string, current: string, label: string, stage: string) => void;
  onOpenCv: (id: string) => void;
  onSaveRecruiter: SaveRecruiter;
}) {
  const { progress, terminal } = moveOptions(app.stages, app.stage);
  return (
    <>
      {/* `align-items:flex-start` so the taller Recruiter form doesn't stretch its Posting/CV-sent
          siblings to match (default `stretch` would leave voids in the shorter two). */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 12 }}>
        <div style={subCard}>
          <Eyebrow>Posting</Eyebrow>
          {/* `job_url` is a stored owner-supplied string (backend doesn't constrain the scheme), so
              guard the href to http(s) — a javascript:/data: value renders as "no link" (mirrors the
              posting drawer's isSafeHttpUrl guard). */}
          {app.jobUrl && isSafeHttpUrl(app.jobUrl) ? (
            <a href={app.jobUrl} target="_blank" rel="noopener noreferrer" style={postingLink}>
              <ExternalIcon /> View job posting
            </a>
          ) : (
            <span style={{ fontSize: 13, color: "var(--text-2)" }}>No posting link saved</span>
          )}
          <div style={{ ...mono(10.5, "var(--text-3)"), marginTop: 9 }}>
            Applied {fmtDateTime(app.appliedAt)}
          </div>
        </div>

        <div style={subCard}>
          <Eyebrow>CV sent</Eyebrow>
          <span style={cvChip}>
            <DocIcon /> Locked CV
          </span>
          <div>
            <button type="button" onClick={() => onOpenCv(app.id)} style={openCvBtn}>
              Open the CV used →
            </button>
          </div>
        </div>

        <RecruiterCard app={app} onSave={onSaveRecruiter} />
      </div>

      <div style={subCard}>
        <Eyebrow>Stage · {stageSummary(app.stage, app.stages)}</Eyebrow>
        <ol style={timeline}>
          {app.events.map((ev) => (
            <li
              key={`${ev.at}-${ev.stage}`}
              style={{ display: "flex", flexDirection: "column", gap: 2 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span aria-hidden style={historyDot(ev.stage)} />
                <span style={{ fontSize: 12.5, color: "var(--text)", flex: 1 }}>
                  {stageTitle(ev.stage)}
                </span>
                <time dateTime={ev.at} style={mono(10.5, "var(--text-3)")}>
                  {fmtDate(ev.at)}
                </time>
              </div>
              {ev.note ? (
                <span
                  style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5, marginLeft: 18 }}
                >
                  {ev.note}
                </span>
              ) : null}
            </li>
          ))}
        </ol>

        <div
          style={{
            ...mono(9, "var(--text-3)"),
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            margin: "13px 0 7px",
          }}
        >
          Move to
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "stretch" }}>
          {progress.map((o) => (
            <MoveButton
              key={o.stage}
              opt={o}
              onClick={() => onMove(app.id, app.stage, label, o.stage)}
            />
          ))}
          <span aria-hidden style={{ width: 1, background: "var(--line)", margin: "0 2px" }} />
          {terminal.map((o) => (
            <MoveButton
              key={o.stage}
              opt={o}
              onClick={() => onMove(app.id, app.stage, label, o.stage)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function MoveButton({ opt, onClick }: { opt: MoveOption; onClick: () => void }) {
  const c = TONE_VAR[opt.tone];
  // The active (current) stage reads as selected via a tinted fill + firmer border + bold --text label
  // — AA in both themes (a solid-fill chip with --on-accent text would drop the ok/muted tones below
  // 4.5:1; a named rubric-§6 divergence from the mockup's solid fill).
  const style: React.CSSProperties = opt.active
    ? {
        ...moveBtnBase,
        color: "var(--text)",
        fontWeight: 600,
        background: `color-mix(in srgb, ${c} 18%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 55%, var(--line))`,
      }
    : {
        // No inline border — `.cos-movebtn` owns the default --line border so its :hover firms it.
        ...moveBtnBase,
        color: "var(--text-2)",
        background: "transparent",
      };
  return (
    <button
      type="button"
      onClick={onClick}
      className="cos-movebtn"
      aria-current={opt.active ? "step" : undefined}
      style={style}
    >
      {opt.label}
    </button>
  );
}

// Editable recruiter contact — structured inputs + an explicit validated Save (master-editor §C2
// convention, not the mockup's contenteditable-onBlur). Local state seeds from the server record and
// re-syncs to it whenever a fresh record arrives AND the form isn't mid-edit (so an in-progress edit is
// never clobbered, but a stale seed can't overwrite another tab); it also re-syncs to the trimmed saved
// values on success (so a trailing space can't leave the form stuck "dirty"). Email is validated
// before save (blocked + inline error); the mailto renders only for a valid, persisted, non-dirty
// address. The "saved" announcement rides the page-level polite region (saveRecruiter → setLive).
function RecruiterCard({ app, onSave }: { app: Application; onSave: SaveRecruiter }) {
  const [name, setName] = useState(app.recruiterName ?? "");
  const [email, setEmail] = useState(app.recruiterEmail ?? "");
  const [saved, setSaved] = useState({
    name: app.recruiterName ?? "",
    email: app.recruiterEmail ?? "",
  });
  const [emailError, setEmailError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const errId = `recruiter-email-err-${app.id}`;

  const dirty = name.trim() !== saved.name || email.trim() !== saved.email;
  const disabled = saving || !dirty;

  // Reconcile from a freshly-arrived server record (e.g. another tab saved the recruiter, then a stage
  // move here returned that updated Application) — but ONLY while this form isn't mid-edit, so a local
  // edit is never clobbered. Without this, the seed-once state would keep stale values and its next
  // save would overwrite the other tab's contact (Codex P2).
  useEffect(() => {
    if (dirty) return;
    const serverName = app.recruiterName ?? "";
    const serverEmail = app.recruiterEmail ?? "";
    if (serverName !== saved.name || serverEmail !== saved.email) {
      setName(serverName);
      setEmail(serverEmail);
      setSaved({ name: serverName, email: serverEmail });
    }
  }, [app.recruiterName, app.recruiterEmail, saved.name, saved.email, dirty]);

  const handleSubmit = async () => {
    if (disabled) return;
    const trimmedEmail = email.trim();
    if (trimmedEmail !== "" && !isLikelyEmail(trimmedEmail)) {
      setEmailError("Enter a valid email, or clear it to save just the name.");
      emailRef.current?.focus();
      return;
    }
    setEmailError(null);
    setCardError(null);
    setSaving(true);
    setJustSaved(false);
    try {
      const updated = await onSave(app.id, {
        recruiterName: name.trim() || null,
        recruiterEmail: trimmedEmail || null,
      });
      // Re-sync to server truth (trimmed) → not dirty; the mailto reads from `saved`, never the input.
      const nextName = updated.recruiterName ?? "";
      const nextEmail = updated.recruiterEmail ?? "";
      setName(nextName);
      setEmail(nextEmail);
      setSaved({ name: nextName, email: nextEmail });
      setJustSaved(true);
    } catch (err: unknown) {
      // 422 shouldn't reach here (isLikelyEmail ⊆ the backend rule) — but if it drifts, map it to the
      // email field, not a generic error. 401 already redirected in saveRecruiter.
      if (err instanceof ApiError && err.status === 422) {
        setEmailError("That email looks invalid — check it, or clear it to save just the name.");
        emailRef.current?.focus();
      } else if (!(err instanceof ApiError && err.status === 401)) {
        setCardError("Couldn’t save the recruiter — please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const showMailto = isLikelyEmail(saved.email) && !dirty;

  return (
    <form
      style={subCard}
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
      noValidate
      aria-label="Recruiter contact"
    >
      <Eyebrow>Recruiter</Eyebrow>
      {/* Inputs are frozen while saving so the on-success re-sync can't silently clobber an edit made
          mid-PATCH on a slow connection (Save already took focus, so nothing's lost by freezing). */}
      <label style={{ display: "block" }}>
        <span style={fieldLabel}>Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setJustSaved(false);
          }}
          disabled={saving}
          placeholder="Add a name"
          style={recruiterInput}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        <span style={fieldLabel}>Email</span>
        <input
          ref={emailRef}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setEmailError(null);
            setJustSaved(false);
          }}
          disabled={saving}
          type="text"
          inputMode="email"
          autoComplete="email"
          placeholder="contact@example.com"
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? errId : undefined}
          style={recruiterInput}
        />
      </label>
      {emailError ? (
        <div id={errId} role="alert" style={recruiterErr}>
          {emailError}
        </div>
      ) : null}
      {cardError ? (
        <div role="alert" style={recruiterErr}>
          {cardError}
        </div>
      ) : null}
      <div style={recruiterActions}>
        <button
          type="submit"
          disabled={disabled}
          style={{ ...buttonStyle("primary", disabled), minHeight: 44 }}
        >
          {saving ? "Saving…" : justSaved && !dirty ? "Saved ✓" : "Save"}
        </button>
        {dirty ? <span style={mono(10.5, "var(--ink-warn)")}>Unsaved changes</span> : null}
        {showMailto ? (
          <a href={`mailto:${saved.email}`} style={mailtoLink} aria-label={`Email ${saved.email}`}>
            <MailIcon /> Email
          </a>
        ) : null}
      </div>
    </form>
  );
}

// --- Small presentational bits ------------------------------------------------------------------

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        ...mono(9, "var(--text-3)"),
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

// Essential status / empty-state copy ("Loading…", "No applications yet") — --text-2, not the muted
// --text-3 (which fails AA per rubric §6); --text-3 stays for genuine metadata (the count + dates).
function Muted({ children }: { children: React.ReactNode }) {
  return <span style={mono(11.5, "var(--text-2)")}>{children}</span>;
}

function ChevronIcon({ rotated }: { rotated: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      style={{ transition: "transform 0.2s ease", transform: rotated ? "rotate(180deg)" : "none" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      style={{ flex: "none" }}
    >
      <path d="M14 3h7v7M21 3l-9 9" />
      <path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      aria-hidden="true"
      focusable="false"
      style={{ flex: "none" }}
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M4 7l8 6 8-6" />
    </svg>
  );
}

// Client-only formatting (list renders after a client fetch → no SSR/hydration mismatch). UI chrome
// only — never the render path (invariant 3).
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function mono(size: number, color: string): React.CSSProperties {
  return { fontFamily: "var(--mono)", fontSize: size, color };
}

// --- Styles -------------------------------------------------------------------------------------

const page = { maxWidth: 940, margin: "0 auto", padding: "24px 22px 60px" } as const;
const title = { margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" } as const;

const rowCard = {
  border: "1px solid var(--line)",
  borderRadius: 13,
  background: "var(--panel)",
  overflow: "hidden",
} as const;

const rowHead = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "14px 18px",
  // Reduced inset so the padded expand button below lands the text at the mockup's ~14/16 inset while
  // giving its hover tint a roomy, intentional region.
  padding: "10px 12px",
} as const;

const expandBtn = {
  // `background` lives in `.cos-trackrow-toggle` so its :hover tint can win (inline would beat it).
  flex: "1 1 180px",
  minWidth: 180,
  textAlign: "left",
  border: "none",
  borderRadius: 8,
  padding: "4px 4px",
  margin: 0,
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
} as const;

// No inline `display` — the `.cos-rowchevron` class owns it so the phone-width `display:none` media
// query can win (an inline display would beat the stylesheet).
const chevronBox = {
  flex: "none",
  width: 28,
  height: 28,
  color: "var(--text-3)",
} as const;

const panel = {
  borderTop: "1px solid var(--line)",
  background: "var(--panel-2)",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  animation: "fadeUp 0.2s ease",
} as const;

const subCard = {
  flex: "1 1 230px",
  minWidth: 0,
  border: "1px solid var(--line)",
  borderRadius: 10,
  background: "var(--panel)",
  padding: "13px 14px",
} as const;

// Recruiter form: 16px so iOS Safari doesn't zoom on focus + a ≥44px hit area (AGENTS §7). The global
// :focus-visible ring covers keyboard focus.
const recruiterInput = { ...inputStyle, fontSize: 16, minHeight: 44, width: "100%" } as const;
const recruiterErr = { fontSize: 12, color: "var(--bad)", lineHeight: 1.4, marginTop: 8 } as const;
const recruiterActions = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginTop: 12,
  flexWrap: "wrap",
} as const;
const mailtoLink = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  padding: "0 6px",
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--accent)",
  textDecoration: "none",
} as const;

const postingLink = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  fontSize: 13,
  color: "var(--accent)",
  textDecoration: "none",
  wordBreak: "break-all",
} as const;

const cvChip = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--text)",
  background: "var(--panel-2)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  padding: "3px 9px",
} as const;

const openCvBtn = {
  marginTop: 10,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  fontWeight: 600,
  color: "var(--accent)",
  background: "transparent",
  border: "1px solid color-mix(in srgb, var(--accent) 38%, var(--line))",
  borderRadius: 7,
  padding: "6px 11px",
  cursor: "pointer",
} as const;

const timeline = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 7,
} as const;

const moveBtnBase = {
  fontFamily: "var(--ui)",
  fontSize: 11.5,
  borderRadius: 7,
  padding: "5px 10px",
  cursor: "pointer",
} as const;

const srOnly = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

const errorBox = {
  fontSize: 12.5,
  color: "var(--bad)",
  border: "1px solid color-mix(in srgb, var(--bad) 40%, transparent)",
  background: "color-mix(in srgb, var(--bad) 12%, transparent)",
  borderRadius: 9,
  padding: "8px 10px",
} as const;

const inlineRetry = {
  font: "inherit",
  color: "var(--bad)",
  background: "transparent",
  border: "none",
  textDecoration: "underline",
  cursor: "pointer",
  padding: 0,
} as const;

function terminalBadge(stage: string): React.CSSProperties {
  const c = stageTone(stage) === "bad" ? "var(--bad)" : "var(--text-3)";
  return {
    ...tagStyle(c),
    fontSize: 9,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
}

function historyDot(stage: string): React.CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flex: "none",
    background: TONE_VAR[stageTone(stage)],
  };
}
