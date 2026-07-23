"use client";

// The Posting drawer — a slide-in panel showing the job posting this CV was tailored to, read straight
// from RenderBundle.jobSpec (BE-1). A native <dialog> via showModal() styled as a right drawer, so the
// BROWSER owns modality (inert background, focus trap, focus-restore, Escape) — the same accessible
// pattern as the in-app confirm/modal, not a hand-rolled overlay.
//
// Named divergences (docs/architecture/design-system.md §Divergences): TEXT SOURCE ONLY — the PDF
// iframe / file-download is dropped (no stored posting file). Must-haves + keywords render as PLAIN
// lists; the present/missing-vs-CV colouring needs the live Gatekeeper verdict and lands with B3.
import { type CSSProperties, useEffect, useRef } from "react";
import type { Schemas } from "@/lib/api/client";
import { IconButton } from "@/ui";
import { isSafeHttpUrl } from "./logic";

type JobSpec = Schemas["JobSpec"];

export function PostingSidebar({ jobSpec, onClose }: { jobSpec: JobSpec; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    // showModal records the trigger so the browser restores focus to it on close (and auto-focuses the
    // first focusable — the Close button); `!dlg.open` guards StrictMode's dev double-invoke.
    if (dlg && !dlg.open) dlg.showModal();
  }, []);

  return (
    <dialog ref={dialogRef} aria-labelledby="posting-title" onClose={onClose} style={drawer}>
      {/* Inner wrapper owns the flex column so the <dialog> keeps the UA `:not([open]){display:none}`
          — setting display:flex on the dialog itself would show it (non-modal) before showModal(). */}
      <div style={drawerInner}>
        <header style={headerRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={eyebrow}>Job posting</span>
            <div
              id="posting-title"
              style={{
                fontSize: 15,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                marginTop: 4,
                lineHeight: 1.3,
              }}
            >
              {jobSpec.title}
            </div>
            {jobSpec.company ? (
              <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 2 }}>
                {jobSpec.company}
              </div>
            ) : null}
          </div>
          <IconButton
            label="Close"
            size={44}
            onClick={() => dialogRef.current?.close()}
            style={{ border: "none" }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </IconButton>
        </header>

        <div style={body}>
          {jobSpec.postingUrl && isSafeHttpUrl(jobSpec.postingUrl) ? (
            <a
              href={jobSpec.postingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="cos-lift"
              style={linkRow}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--mono)",
                  fontSize: 11.5,
                  color: "var(--accent)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {jobSpec.postingUrl}
              </span>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--text-3)",
                  flex: "none",
                }}
              >
                Open ↗
              </span>
            </a>
          ) : null}

          <section>
            <span style={{ ...eyebrow, display: "block", marginBottom: 9 }}>Source text</span>
            {jobSpec.rawText.trim() ? (
              <div style={sourceText}>{jobSpec.rawText}</div>
            ) : (
              <p style={muted}>No posting text was stored for this CV.</p>
            )}
          </section>

          <Section
            title="Must-haves from the posting"
            items={jobSpec.mustHaves}
            empty="None were detected in the posting."
          />
          {jobSpec.niceToHaves.length > 0 ? (
            <Section title="Nice-to-haves" items={jobSpec.niceToHaves} empty="" />
          ) : null}

          {jobSpec.atsKeywords.length > 0 ? (
            <section>
              <span style={{ ...eyebrow, display: "block", marginBottom: 9 }}>
                Keywords the ATS scans for
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {jobSpec.atsKeywords.map((k) => (
                  <span key={k} style={kwChip}>
                    {k}
                  </span>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}

function Section({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section>
      <span style={{ ...eyebrow, display: "block", marginBottom: 9 }}>{title}</span>
      {items.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {items.map((it) => (
            <div key={it} style={reqRow}>
              {it}
            </div>
          ))}
        </div>
      ) : empty ? (
        <p style={muted}>{empty}</p>
      ) : null}
    </section>
  );
}

const drawer: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  // A modal <dialog>'s UA style sets left:0 too, which would win over right:0 and pin the drawer to
  // the LEFT — force left:auto so it anchors to the right edge (matching the slide-in direction).
  left: "auto",
  height: "100vh",
  maxHeight: "100vh",
  margin: 0,
  padding: 0,
  width: "min(420px, 92%)",
  maxWidth: 420,
  background: "var(--panel)",
  border: "none",
  borderLeft: "1px solid var(--line-strong)",
  boxShadow: "-24px 0 60px -30px rgba(0, 0, 0, 0.7)",
  color: "var(--text)",
  fontFamily: "var(--ui)",
  animation: "slideInRight 0.2s ease",
};
const drawerInner: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
};
const headerRow: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "16px 18px",
  borderBottom: "1px solid var(--line)",
};
const eyebrow: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-3)",
};
const body: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 18,
};
const linkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "11px 13px",
  borderRadius: 10,
  background: "var(--panel-2)",
  textDecoration: "none",
};
const sourceText: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 10,
  background: "var(--panel-2)",
  maxHeight: 320,
  overflow: "auto",
  padding: "12px 13px",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  lineHeight: 1.6,
  color: "var(--text-2)",
  whiteSpace: "pre-wrap",
};
const reqRow: CSSProperties = {
  fontSize: 12.5,
  color: "var(--text)",
  lineHeight: 1.45,
  padding: "10px 12px",
  border: "1px solid var(--line)",
  borderRadius: 10,
  background: "var(--panel-2)",
};
const kwChip: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--text-2)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  padding: "3px 8px",
};
const muted: CSSProperties = {
  margin: 0,
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--text-3)",
  lineHeight: 1.5,
};
