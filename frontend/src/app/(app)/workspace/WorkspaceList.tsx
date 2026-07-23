"use client";

// The Workspace landing (no ?cv=): the owner's tailored CVs as application cards + a leading
// "Start application" tile that opens the New-application modal. This screen ABSORBS the old Home
// dashboard (Workspace is the owner's home now). The list fetch/refresh/delete logic is carried over
// from the previous Home page verbatim; only the presentation is reskinned to the Claude design.
//
// Named divergence (docs/architecture/design-system.md §Divergences): cards carry NO persisted
// verdict/stage/progress — `CvSummary` has none, and the list deliberately does not join the
// per-CV persisted review verdict (ADR 0013); surfacing it here is a possible future slice.
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiError, api, type Schemas } from "@/lib/api/client";
import { Banner, buttonStyle, tagStyle } from "@/ui";
import { deleteCvRequest, fromMasterRequest, listCvsRequest, newApplicationError } from "./logic";
import { NewApplicationModal } from "./NewApplicationModal";

type CvSummary = Schemas["CvSummary"];

type CvsState =
  | { status: "loading" }
  | { status: "ready"; items: CvSummary[] }
  | { status: "error" };

export function WorkspaceList({
  tailorReadiness,
  focusHeadingOnMount = false,
  onHeadingFocused,
}: {
  tailorReadiness: "unknown" | "ready" | "not-ready";
  /** One-shot: when true on mount, move focus to the heading (set by the editor's "‹ Workspace" back
   *  action so a keyboard/SR user isn't stranded on <body>). The parent clears it via onHeadingFocused. */
  focusHeadingOnMount?: boolean;
  onHeadingFocused?: () => void;
}) {
  // `unknown` (still resolving) shows the configured presentation, so a correctly-set-up owner never
  // sees an AI->no-AI flash on cold load; only a definitive `not-ready` promotes the keyless path.
  const aiPath = tailorReadiness !== "not-ready";

  const [cvs, setCvs] = useState<CvsState>({ status: "loading" });
  // Guard overlapping fetches (mount / Retry / pageshow / visibility): only the latest request, while
  // still mounted, may commit — so a slow earlier response can't overwrite a newer list.
  const reqRef = useRef(0);
  const mountedRef = useRef(true);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Arriving from the editor's "‹ Workspace" back action: take focus so a keyboard/SR user lands on the
  // list, not <body>. Guarded by the one-shot flag → a cold /workspace load (flag false) never steals
  // focus (§7). onHeadingFocused clears the flag; the false re-run is a no-op.
  useEffect(() => {
    if (!focusHeadingOnMount) return;
    headingRef.current?.focus();
    onHeadingFocused?.();
  }, [focusHeadingOnMount, onHeadingFocused]);

  const loadCvs = useCallback(() => {
    const id = ++reqRef.current;
    setCvs({ status: "loading" });
    api<CvSummary[]>(listCvsRequest().path)
      .then((items) => {
        if (mountedRef.current && reqRef.current === id) setCvs({ status: "ready", items });
      })
      .catch(() => {
        if (mountedRef.current && reqRef.current === id) setCvs({ status: "error" });
      });
  }, []);

  useEffect(() => {
    loadCvs();
    // Refresh on return so a CV created/edited in the editor shows up. `pageshow`+`persisted` catches a
    // bfcache Back restore (where effects/visibility don't re-fire); visibility covers tab refocus.
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      // We leave for the new CV via a full navigation (window.location.assign) while the modal/draft is
      // mid-create — so a bfcache Back would restore this page with a frozen "Creating…" modal (close
      // disabled) or a stuck draft button. Reset that transient create state before refreshing.
      setShowNew(false);
      setDrafting(false);
      setCreateErr(null);
      loadCvs();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") loadCvs();
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadCvs]);

  const deleteCv = useCallback(
    async (cv: CvSummary) => {
      if (!window.confirm(`Delete “${cvLabel(cv)}”? This can’t be undone.`)) return;
      setDeleteErr(null);
      try {
        const req = deleteCvRequest(cv.id);
        await api<Schemas["OkResponse"]>(req.path, req.init);
      } catch (err: unknown) {
        // A 404 (already deleted in another tab / a double-click) is benign — refetch to reflect
        // reality. Any other failure left the CV in place, so surface it and stop.
        if (!(err instanceof ApiError) || err.status !== 404) {
          setDeleteErr("Couldn’t delete that CV — please try again.");
          return;
        }
      }
      loadCvs();
      headingRef.current?.focus();
    },
    [loadCvs],
  );

  // Keyless path: a verbatim draft from the stored master (no AI / no provider key).
  const startDraft = useCallback(async () => {
    setCreateErr(null);
    setDrafting(true);
    try {
      const c = fromMasterRequest();
      const created = await api<Schemas["CreatedCV"]>(c.path, c.init);
      // Full navigation (like the card links), NOT router.push: the list shares one WorkspaceClient
      // with the editor, so a client-side ?cv= switch would leak this parent's per-CV state into the
      // new CV's editor. A fresh load mounts a clean editor.
      window.location.assign(`/workspace?cv=${encodeURIComponent(created.id)}`);
    } catch (err: unknown) {
      setDrafting(false);
      setCreateErr(newApplicationError(err));
    }
  }, []);

  return (
    <div style={{ minHeight: "100vh", padding: "2rem" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              ref={headingRef}
              tabIndex={-1}
              style={{ margin: 0, fontSize: 23, letterSpacing: "-0.02em" }}
            >
              Your applications
            </h1>
            <p
              style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}
            >
              Each application has its own job posting and tailored CV — open a card to edit and
              export.
            </p>
          </div>
          {aiPath ? (
            <button
              type="button"
              onClick={startDraft}
              disabled={drafting}
              style={buttonStyle("ghostLink", drafting)}
            >
              {drafting ? "Starting…" : "Start a no-AI draft"}
            </button>
          ) : (
            <a href="/admin" style={{ ...buttonStyle("ghostLink"), textDecoration: "none" }}>
              Set up AI → Admin
            </a>
          )}
        </header>

        {createErr ? <Banner kind="bad" text={createErr} style={{ marginTop: 14 }} /> : null}
        {deleteErr ? <Banner kind="bad" text={deleteErr} style={{ marginTop: 14 }} /> : null}

        <div style={{ marginTop: 18 }}>
          <CvGrid
            cvs={cvs}
            onRetry={loadCvs}
            onDelete={deleteCv}
            aiPath={aiPath}
            drafting={drafting}
            onStart={() => (aiPath ? setShowNew(true) : startDraft())}
          />
        </div>
      </div>

      {showNew ? <NewApplicationModal onClose={() => setShowNew(false)} /> : null}
    </div>
  );
}

function CvGrid({
  cvs,
  onRetry,
  onDelete,
  aiPath,
  drafting,
  onStart,
}: {
  cvs: CvsState;
  onRetry: () => void;
  onDelete: (cv: CvSummary) => void;
  aiPath: boolean;
  drafting: boolean;
  onStart: () => void;
}) {
  if (cvs.status === "loading") return <Muted>Loading your applications…</Muted>;
  if (cvs.status === "error")
    return (
      <div role="alert" style={errorBox}>
        Couldn’t load your applications.{" "}
        <button type="button" onClick={onRetry} style={inlineRetry}>
          Retry
        </button>
      </div>
    );

  return (
    <div
      style={{
        display: "grid",
        // Intrinsically responsive (incl. iPhone width) with no media query: auto-fill + min() caps the
        // column at the container width on narrow screens (collapses to one column).
        gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))",
        gap: 14,
      }}
    >
      <StartCard aiPath={aiPath} drafting={drafting} onClick={onStart} />
      {cvs.items.map((cv) => (
        <CvCard key={cv.id} cv={cv} onDelete={onDelete} />
      ))}
    </div>
  );
}

function StartCard({
  aiPath,
  drafting,
  onClick,
}: {
  aiPath: boolean;
  drafting: boolean;
  onClick: () => void;
}) {
  const title = aiPath ? "Start application" : "Start a no-AI draft";
  const sub = aiPath
    ? "Paste a job posting to spin up a tailored CV."
    : "Build a verbatim CV from your master — no AI needed.";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={drafting}
      className="cos-startcard"
      style={startCard}
    >
      <span style={startIcon} aria-hidden>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 600 }}>{drafting ? "Starting…" : title}</span>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--text-3)",
          maxWidth: 220,
          lineHeight: 1.5,
        }}
      >
        {sub}
      </span>
    </button>
  );
}

function CvCard({ cv, onDelete }: { cv: CvSummary; onDelete: (cv: CvSummary) => void }) {
  const label = cvLabel(cv);
  return (
    // A stretched-link card: the whole tile opens the CV, while the delete button sits above the link
    // (zIndex) so it stays independently clickable (a <button> can't nest in an <a>).
    <div className="cos-cardlift" style={cardOuter}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={cardTitle}>{label}</div>
        {cv.needsSignoff ? <span style={signoffTag}>needs sign-off</span> : null}
      </div>
      <p style={cardSummary}>{cv.summary}</p>
      <div style={cardFoot}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-3)" }}>
          Updated {fmtDate(cv.updatedAt)}
        </span>
        <button
          type="button"
          onClick={() => onDelete(cv)}
          aria-label={`Delete ${label}, created ${fmtDateTime(cv.createdAt)}`}
          style={deleteBtn}
        >
          Delete
        </button>
      </div>
      <a
        href={`/workspace?cv=${encodeURIComponent(cv.id)}`}
        aria-label={`Open ${label}, updated ${fmtDateTime(cv.updatedAt)}`}
        style={stretchedLink}
      >
        <span style={srOnly}>Open {label}</span>
      </a>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-3)" }}>
      {children}
    </span>
  );
}

/** Display label: the job a CV targets, else a dated draft. */
function cvLabel(cv: CvSummary): string {
  if (cv.jobTitle) return cv.company ? `${cv.company} — ${cv.jobTitle}` : cv.jobTitle;
  return `Draft · ${fmtDate(cv.createdAt)}`;
}

// Client-only formatting (the list renders after a client fetch — no SSR/hydration mismatch). UI chrome
// only, never the render path (invariant 3).
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

const cardOuter: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  minHeight: 150,
  background: "var(--panel)",
  borderRadius: 14,
  padding: "15px 16px",
};
const cardTitle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: "-0.01em",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const cardSummary: CSSProperties = {
  margin: "8px 0 0",
  fontSize: 12.5,
  color: "var(--text-2)",
  lineHeight: 1.5,
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
const cardFoot: CSSProperties = {
  marginTop: "auto",
  paddingTop: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
const stretchedLink: CSSProperties = { position: "absolute", inset: 0, borderRadius: 14 };
// Visually-hidden but in the accessibility tree — the stretched link's text content for screen readers
// (the visible card text sits under the transparent overlay link).
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};
const deleteBtn: CSSProperties = {
  position: "relative",
  zIndex: 1,
  fontFamily: "var(--mono)",
  fontSize: 11,
  // --text-2 (not the muted --text-3) keeps this destructive control WCAG-AA; larger padding gives a
  // comfortable touch target (the rubric forbids --text-3 on interactive/essential text).
  color: "var(--text-2)",
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: 7,
  // ≥44px touch target (AGENTS §7) via minHeight; flex centres the label in the taller box.
  minHeight: 44,
  display: "inline-flex",
  alignItems: "center",
  padding: "0 14px",
  cursor: "pointer",
};
const signoffTag = tagStyle("var(--warn)");

const startCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  minHeight: 150,
  borderRadius: 14,
  background: "transparent",
  color: "var(--text-2)",
  textAlign: "center",
  padding: 20,
  cursor: "pointer",
};
const startIcon: CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 12,
  border: "1px solid var(--line)",
  background: "var(--panel)",
  color: "var(--accent)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const errorBox: CSSProperties = {
  fontSize: 12.5,
  color: "var(--text)",
  border: "1px solid color-mix(in srgb, var(--bad) 40%, transparent)",
  background: "color-mix(in srgb, var(--bad) 12%, transparent)",
  borderRadius: 9,
  padding: "8px 10px",
};
const inlineRetry: CSSProperties = {
  font: "inherit",
  color: "var(--bad)",
  background: "transparent",
  border: "none",
  textDecoration: "underline",
  cursor: "pointer",
  padding: 0,
};
