"use client";

// Application detail — the immutable record of one job you applied to. Left: job info, the locked
// badge, the status pipeline (advance the stage + append a timeline note), the timeline, re-export of
// the exact CV sent, and delete. Right: a READ-ONLY preview that mounts the SAME `ResumeTemplate` the
// PDF prints (invariant 3), from the frozen `{master, cv}` snapshot the server still serves by cvId.
// Owner-only data; a server 403 (mid-session revocation) lands on the `forbidden` phase.
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Schemas } from "@/lib/api/client";
import { toResumeDocument } from "@/render/model";
import { ResumeTemplate } from "@/render/ResumeTemplate";
import { Banner, buttonStyle, cardStyle, fieldLabel, inputStyle, tagStyle } from "@/ui";
import { exportUrl, isSafeHttpUrl, readRequest } from "../../workspace/logic";
import {
  applicationLabel,
  deleteApplicationRequest,
  FOCUS_HEADING_KEY,
  readApplicationRequest,
  updateStageRequest,
} from "../logic";

type Application = Schemas["Application"];
type RenderBundle = Schemas["RenderBundle"];

type Phase =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; app: Application; bundle: RenderBundle };

const mono = { fontFamily: "var(--mono)" } as const;

export default function ApplicationDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // Stage control (PR3). `pendingStage` is "" until the owner picks a different stage; the select
  // falls back to the application's current stage so it tracks server truth after each update.
  const [pendingStage, setPendingStage] = useState("");
  const [stageNote, setStageNote] = useState("");
  const [updatingStage, setUpdatingStage] = useState(false);
  const [stageErr, setStageErr] = useState<string | null>(null);
  // Synchronous single-flight guards (the `deleting`/`updatingStage` state lags a render). The delete
  // trigger ref restores focus when a failed delete unmounts the modal (no browser focus-restore then).
  const deleteInFlightRef = useRef(false);
  const stageInFlightRef = useRef(false);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(
    async (shouldApply: () => boolean = () => true): Promise<void> => {
      try {
        const app = await api<Application>(readApplicationRequest(id).path);
        // The applied CV is still stored (lock-in-place); read_cv serves its frozen snapshot.
        const bundle = await api<RenderBundle>(readRequest(app.tailoredCvRef).path);
        if (!shouldApply()) return;
        setPhase({ status: "ready", app, bundle });
      } catch (err: unknown) {
        if (!shouldApply()) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setPhase({ status: "not-found" });
          return;
        }
        if (err instanceof ApiError && err.status === 403) {
          setPhase({ status: "forbidden" });
          return;
        }
        setPhase({ status: "error", message: errText(err) });
      }
    },
    [id, router],
  );

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  const onDelete = useCallback(async () => {
    if (deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeleting(true);
    setDeleteErr(null);
    try {
      const req = deleteApplicationRequest(id);
      await api<Schemas["OkResponse"]>(req.path, req.init);
      // Hand focus to the list heading on arrival (the row we were on is gone with this route).
      if (typeof window !== "undefined") sessionStorage.setItem(FOCUS_HEADING_KEY, "1");
      router.push("/applications");
    } catch (err: unknown) {
      // A 404 (already deleted elsewhere) is benign — the list will reflect reality.
      if (err instanceof ApiError && err.status === 404) {
        router.push("/applications");
        return;
      }
      // Unmounting the open modal here skips the browser's focus-restore — return focus to the
      // trigger so a keyboard/SR user isn't stranded; the error renders in an alert region below it.
      setShowDelete(false);
      setDeleteErr("Couldn’t delete this application — please try again.");
      deleteBtnRef.current?.focus();
    } finally {
      deleteInFlightRef.current = false;
      setDeleting(false);
    }
  }, [id, router]);

  // Advance the status pipeline + append a timeline note. Renders the returned Application as server
  // truth (the timeline grows from it), so the select tracks the new stage on the next render.
  const onUpdateStage = useCallback(
    async (currentStage: string) => {
      const stage = pendingStage || currentStage;
      if (stage === currentStage || stageInFlightRef.current) return;
      stageInFlightRef.current = true;
      setUpdatingStage(true);
      setStageErr(null);
      try {
        const note = stageNote.trim() === "" ? undefined : stageNote.trim();
        const req = updateStageRequest(id, { stage, note });
        const updated = await api<Application>(req.path, req.init);
        setPhase((p) => (p.status === "ready" ? { ...p, app: updated } : p));
        setPendingStage("");
        setStageNote("");
      } catch {
        // Don't leak the raw response body — a friendly, generic message.
        setStageErr("Couldn’t update the status — please try again.");
      } finally {
        stageInFlightRef.current = false;
        setUpdatingStage(false);
      }
    },
    [id, pendingStage, stageNote],
  );

  if (phase.status === "loading") return <Centered>Loading this application…</Centered>;
  if (phase.status === "forbidden")
    // Server-403-driven: the account was de-allowlisted mid-session (the pinned revocation copy).
    return <Centered>Your access was removed — sign in with an allowlisted account.</Centered>;
  if (phase.status === "not-found")
    return (
      <Notice title="Application not found">
        This application doesn’t exist or was removed.{" "}
        <Link href="/applications" className="cos-backlink" style={backLink}>
          Back to Applications →
        </Link>
      </Notice>
    );
  if (phase.status === "error")
    return (
      <Notice title="Couldn’t load this application">
        {phase.message}{" "}
        <button type="button" onClick={() => load()} style={inlineRetry}>
          Try again
        </button>
      </Notice>
    );

  const { app, bundle } = phase;
  const label = applicationLabel(app);

  return (
    <div style={{ minHeight: "100vh", padding: "2rem" }}>
      <header style={{ maxWidth: 1180, margin: "0 auto 18px" }}>
        {/* A real ≥44px tap target (was an 11px inline --text-3 anchor — a mis-tap magnet that reads as
            muted metadata, not a control; the reported "back does nothing"). `<Link>` = client-side nav
            like the rest of the shell; the negative inline-margin keeps the label aligned with the h1. */}
        <Link href="/applications" className="cos-backlink" style={backControl}>
          ← Applications
        </Link>
        <h1 style={{ margin: "8px 0 6px", fontSize: 22, letterSpacing: "-0.02em" }}>{label}</h1>
        <span style={lockedBadge} title="This CV is locked to this application and can't be edited">
          <span aria-hidden>🔒</span> Locked &amp; immutable
        </span>
      </header>

      <div className="ws-cols" style={{ maxWidth: 1180, margin: "0 auto" }}>
        {/* Left: job info + timeline + actions. `.ws-app-aside` pins this column sticky beside a tall
            CV once the two columns sit side by side (≥1120); the sticky rule lives in globals.css since
            an inline style can't express the media query. */}
        <section
          className="ws-app-aside"
          style={{
            flex: "1 1 340px",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <article style={cardStyle}>
            <h2 style={{ margin: "0 0 10px", fontSize: 14 }}>Application</h2>
            <dl
              style={{
                margin: 0,
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "6px 12px",
                fontSize: 13,
              }}
            >
              <Dt>Status</Dt>
              <dd style={dd}>
                <span style={stagePill}>{app.stage}</span>
              </dd>
              <Dt>Applied</Dt>
              <dd style={dd}>{fmtDateTime(app.appliedAt)}</dd>
              {app.company ? (
                <>
                  <Dt>Company</Dt>
                  <dd style={dd}>{app.company}</dd>
                </>
              ) : null}
              {/* `job_url` is a stored owner-supplied string the backend doesn't scheme-check — guard
                  the href to http(s) (mirrors the tracker + posting drawer) so a javascript:/data:
                  value can't render as a live link. */}
              {app.jobUrl && isSafeHttpUrl(app.jobUrl) ? (
                <>
                  <Dt>Posting</Dt>
                  <dd style={dd}>
                    <a
                      href={app.jobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={linkStyle}
                    >
                      View job posting →
                    </a>
                  </dd>
                </>
              ) : null}
            </dl>
          </article>

          <article style={cardStyle}>
            <h2 style={{ margin: "0 0 10px", fontSize: 14 }}>Advance status</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void onUpdateStage(app.stage);
              }}
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <label>
                <span style={fieldLabel}>Stage</span>
                <select
                  value={pendingStage || app.stage}
                  onChange={(e) => setPendingStage(e.target.value)}
                  disabled={updatingStage}
                  style={formInput}
                >
                  {app.stages.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span style={fieldLabel}>Note (optional)</span>
                <input
                  value={stageNote}
                  onChange={(e) => setStageNote(e.target.value)}
                  disabled={updatingStage}
                  placeholder="e.g. recruiter call booked"
                  style={formInput}
                />
              </label>
              {stageErr ? <Banner kind="bad" text={stageErr} /> : null}
              <div>
                <button
                  type="submit"
                  disabled={updatingStage || (pendingStage || app.stage) === app.stage}
                  style={buttonStyle(
                    "primary",
                    updatingStage || (pendingStage || app.stage) === app.stage,
                  )}
                >
                  {updatingStage ? "Updating…" : "Update status"}
                </button>
              </div>
            </form>
          </article>

          <article style={cardStyle}>
            <h2 style={{ margin: "0 0 4px", fontSize: 14 }}>Export the CV you sent</h2>
            <p
              style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-3)", lineHeight: 1.5 }}
            >
              Re-download the exact, frozen CV — byte-for-byte what the preview shows.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(["pdf", "docx", "text"] as const).map((kind) => (
                <a
                  key={kind}
                  href={exportUrl(app.tailoredCvRef, kind)}
                  target="_blank"
                  rel="noopener"
                  style={{ ...ghostBtn, textDecoration: "none" }}
                >
                  {kind === "text" ? "ATS text" : kind.toUpperCase()}
                </a>
              ))}
            </div>
          </article>

          <article style={cardStyle}>
            <h2 style={{ margin: "0 0 10px", fontSize: 14 }}>Timeline</h2>
            <ol
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {app.events.map((ev) => (
                <li
                  // `at` is a distinct server timestamp per event (one per stage update), so it's a
                  // stable key without falling back to the array index.
                  key={`${ev.at}-${ev.stage}`}
                  style={{ display: "flex", flexDirection: "column", gap: 2 }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{ev.stage}</span>
                  <time
                    dateTime={ev.at}
                    style={{ ...mono, fontSize: 10.5, color: "var(--text-3)" }}
                  >
                    {fmtDateTime(ev.at)}
                  </time>
                  {ev.note ? (
                    <span style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
                      {ev.note}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </article>

          <article style={cardStyle}>
            {deleteErr ? (
              <div style={{ marginBottom: 10 }}>
                <Banner kind="bad" text={deleteErr} />
              </div>
            ) : null}
            <button
              ref={deleteBtnRef}
              type="button"
              onClick={() => setShowDelete(true)}
              style={dangerBtn}
            >
              Delete application
            </button>
            <p style={{ ...mono, fontSize: 10.5, color: "var(--text-3)", marginTop: 6 }}>
              Removes this application and the locked CV it holds — can’t be undone.
            </p>
          </article>
        </section>

        {/* Right: read-only preview (the same template the PDF prints). No inner scroller — the page
            body is the single scroller, so a 2-page CV flows at full length beside the sticky actions. */}
        <section style={{ flex: "2 1 460px", minWidth: 0 }}>
          <div
            style={{
              background: "var(--paper)",
              borderRadius: 14,
              border: "1px solid var(--line)",
              padding: 16,
            }}
          >
            <ResumeTemplate doc={toResumeDocument(bundle)} />
          </div>
        </section>
      </div>

      {showDelete ? (
        <ConfirmDialog
          title="Delete this application?"
          body="This removes the application and the locked CV it holds. It can’t be recovered."
          confirmLabel={deleting ? "Deleting…" : "Delete"}
          busy={deleting}
          onConfirm={onDelete}
          onDismiss={() => setShowDelete(false)}
        />
      ) : null}
    </div>
  );
}

// Minimal in-app confirm — a native <dialog> via showModal() so the browser owns modality + focus
// restore. Mirrors the ingest ConfirmDialog; kept local (it's a different surface).
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onDismiss,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    cancelRef.current?.focus();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby="app-del-title"
      aria-describedby="app-del-body"
      onClose={onDismiss}
      // Block Escape-cancel while the delete is in flight, so a visible "cancel" after confirming
      // can't leave the destructive `onDelete` running to completion (Codex P2).
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      style={{
        ...cardStyle,
        maxWidth: 420,
        width: "calc(100% - 2rem)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
      }}
    >
      <h2 id="app-del-title" style={{ margin: "0 0 6px", fontSize: 15 }}>
        {title}
      </h2>
      <p
        id="app-del-body"
        style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}
      >
        {body}
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button
          ref={cancelRef}
          type="button"
          onClick={() => dialogRef.current?.close()}
          disabled={busy}
          style={buttonStyle("ghost", busy)}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          style={buttonStyle("danger", busy)}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt style={{ color: "var(--text-2)", ...mono, fontSize: 11 }}>{children}</dt>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <span
        style={{
          ...mono,
          fontSize: 12,
          color: "var(--text-3)",
          textAlign: "center",
          maxWidth: 360,
        }}
      >
        {children}
      </span>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <section style={{ ...cardStyle, maxWidth: 440, textAlign: "center" }}>
        <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>{title}</h1>
        <p style={{ margin: 0, color: "var(--text-2)", fontSize: 13, lineHeight: 1.6 }}>
          {children}
        </p>
      </section>
    </div>
  );
}

function errText(_err: unknown): string {
  // Friendly, generic — never surface the raw response body (401/404/403 are handled before this).
  return "We couldn’t load this application. Please try again.";
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const dd = { margin: 0, color: "var(--text)" } as const;
// 16px so iOS Safari doesn't zoom on focus (shared inputStyle is 13px) — the stage form is mobile-facing.
const formInput = { ...inputStyle, fontSize: 16 } as const;
const stagePill = tagStyle("var(--accent)");
const linkStyle = { color: "var(--accent)", textDecoration: "none" } as const;
const ghostBtn = buttonStyle("ghost");
const dangerBtn = buttonStyle("danger");
const lockedBadge = {
  ...tagStyle("var(--text-3)"),
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
} as const;
const backLink = { color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap" } as const;
// The header back control: a comfortable ≥44px hit area (AGENTS §7) that reads as a link (--accent,
// design-system's link tone). `marginLeft` offsets the padding so the label still aligns with the h1
// below. Hover underline is `.cos-backlink`; the global `:focus-visible` ring covers keyboard.
const backControl = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  marginLeft: -10,
  padding: "0 10px",
  fontFamily: "var(--mono)",
  fontSize: 12.5,
  // Essential nav text on the bare --bg header: --accent is only 3.84:1 in light theme (fails AA);
  // --text-2 matches the workspace/Gatekeeper back-control precedent and clears AA in both themes.
  color: "var(--text-2)",
  textDecoration: "none",
  borderRadius: 8,
  whiteSpace: "nowrap",
} as const;
const inlineRetry = {
  font: "inherit",
  color: "var(--accent)",
  background: "transparent",
  border: "none",
  textDecoration: "underline",
  cursor: "pointer",
  padding: 0,
} as const;
