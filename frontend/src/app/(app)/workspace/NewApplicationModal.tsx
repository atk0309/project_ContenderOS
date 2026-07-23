"use client";

// Start-a-new-application modal — paste a job posting → Parser (ai/parse) → confirm the detected role
// → Tailor (workspaces/{id}/cv) → open the new CV. A native <dialog> via showModal() so the BROWSER
// owns modality (inert background, focus trap, focus-restore to the trigger); dismissal routes through
// the close event to onClose. Paste-text is the only functional input in v1: the optional posting-URL
// is a STORED string (jobSpec.postingUrl), never fetched, and the Link/File tabs are deferred chrome
// (see docs/architecture/design-system.md §Divergences). The candidate-CV PDF ingest path is NOT
// reused here — that builds master proposals, not a JobSpec.
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { api, type Schemas } from "@/lib/api/client";
import { Banner, buttonStyle, IconButton, inputStyle, textareaStyle } from "@/ui";
import { newApplicationError, parseRequest, tailorRequest, withPostingUrl } from "./logic";

type JobSpec = Schemas["JobSpec"];
type CreatedCV = Schemas["CreatedCV"];

type Step = "input" | "analyzing" | "confirm" | "creating";

export function NewApplicationModal({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);

  const [step, setStep] = useState<Step>("input");
  const [rawText, setRawText] = useState("");
  const [url, setUrl] = useState("");
  const [spec, setSpec] = useState<JobSpec | null>(null);
  const [error, setError] = useState<string | null>(null);

  // While a provider call is in flight the dialog can't be dismissed (else an in-flight create lands
  // in an unmounted dialog, or strands the user mid-navigation).
  const busy = step === "analyzing" || step === "creating";

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    textRef.current?.focus();
  }, []);
  // Move focus with the step: the primary action on confirm, back to the textarea when an error
  // bounces us to input.
  useEffect(() => {
    if (step === "confirm") createRef.current?.focus();
    if (step === "input" && error) textRef.current?.focus();
  }, [step, error]);

  const analyze = async () => {
    if (rawText.trim() === "") return;
    setError(null);
    setStep("analyzing");
    try {
      const c = parseRequest(rawText);
      setSpec(await api<JobSpec>(c.path, c.init));
      setStep("confirm");
    } catch (err: unknown) {
      setError(newApplicationError(err));
      setStep("input");
    }
  };

  const create = async () => {
    if (!spec) return;
    setError(null);
    setStep("creating");
    try {
      // The owner-supplied URL is a stored string on the JobSpec — merged in only now, so it persists
      // with the CV's job spec (the Posting drawer reads it back). Never produced by the Parser.
      const c = tailorRequest(withPostingUrl(spec, url));
      const created = await api<CreatedCV>(c.path, c.init);
      // Full navigation (like the list's card links), NOT router.push: the list + editor share one
      // WorkspaceClient, so a client-side ?cv= switch would carry this list's parent per-CV state into
      // the new CV's editor. A fresh load mounts a clean editor. (Per-CV state reset in the editor
      // itself is B2a's extraction work.) Keeps the "Creating…" spinner until the reload commits.
      window.location.assign(`/workspace?cv=${encodeURIComponent(created.id)}`);
    } catch (err: unknown) {
      setError(newApplicationError(err));
      setStep("confirm");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="newapp-title"
      onClose={onClose}
      // Escape fires a cancelable `cancel` before `close` — block it while a call is in flight.
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      style={dialogStyle}
    >
      <header style={headerRow}>
        <span style={iconSquare} aria-hidden>
          <PlusIcon />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id="newapp-title" style={{ fontSize: 14, fontWeight: 600 }}>
            Start a new application
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 1 }}>
            Paste the posting and we&rsquo;ll set up a tailored CV from your master profile.
          </div>
        </div>
        <IconButton
          label="Close"
          size={44}
          disabled={busy}
          onClick={() => dialogRef.current?.close()}
          style={{ border: "none" }}
        >
          <CloseIcon />
        </IconButton>
      </header>

      {step === "input" ? (
        <div style={bodyPad}>
          <div style={tabsWrap}>
            <span style={tabActive}>Paste text</span>
            <button type="button" disabled style={tabDisabled}>
              From link <span style={soonTag}>Soon</span>
            </button>
            <button type="button" disabled style={tabDisabled}>
              Upload file <span style={soonTag}>Soon</span>
            </button>
          </div>

          <label htmlFor="newapp-text" style={fieldLabel}>
            Job posting
          </label>
          <textarea
            id="newapp-text"
            ref={textRef}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="Paste the job description — title, responsibilities and requirements…"
            style={{ ...textareaStyle, minHeight: 150, marginTop: 6 }}
          />

          <label htmlFor="newapp-url" style={{ ...fieldLabel, marginTop: 14 }}>
            Job posting URL <span style={{ color: "var(--text-3)" }}>(optional)</span>
          </label>
          <input
            id="newapp-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://jobs.example.com/role-1234"
            style={{ ...inputStyle, fontFamily: "var(--mono)", marginTop: 6 }}
          />
          <p style={helper}>
            Saved with the application so you can reopen the posting later — we don&rsquo;t fetch
            the page yet.
          </p>

          {error ? <Banner kind="bad" text={error} style={{ marginTop: 12 }} /> : null}

          <footer style={footerRow}>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              style={buttonStyle("ghostLink")}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={analyze}
              disabled={rawText.trim() === ""}
              style={buttonStyle("primary", rawText.trim() === "")}
            >
              Analyze posting →
            </button>
          </footer>
        </div>
      ) : null}

      {step === "analyzing" ? (
        <Working title="Reading the posting…" sub="Extracting the role, must-haves and keywords." />
      ) : null}

      {step === "confirm" && spec ? (
        <div style={bodyPad}>
          <div style={detectedCard}>
            <span style={eyebrow}>Detected role</span>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", marginTop: 4 }}>
              {spec.title}
            </div>
            {spec.company ? (
              <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 2 }}>
                {spec.company}
              </div>
            ) : null}
          </div>

          <span style={{ ...eyebrow, display: "block", marginBottom: 9 }}>
            Must-haves from the posting
          </span>
          {spec.mustHaves.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {spec.mustHaves.map((m) => (
                <div key={m} style={mustHaveRow}>
                  {m}
                </div>
              ))}
            </div>
          ) : (
            <p style={{ ...helper, marginTop: 0, marginBottom: 14 }}>
              No specific must-haves were detected — you can still tailor and review against the
              posting.
            </p>
          )}

          <div style={infoNote}>
            <span style={{ color: "var(--accent)", flex: "none", marginTop: 1 }} aria-hidden>
              <ShieldIcon />
            </span>
            <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
              A fresh CV is created from your master profile, then tailored to the posting by your
              configured AI provider.{" "}
              <span style={{ color: "var(--text-3)" }}>
                It stays in your workspace — nothing is shared with the employer until you export.
              </span>
            </div>
          </div>

          {error ? <Banner kind="bad" text={error} style={{ marginTop: 12 }} /> : null}

          <footer style={footerRow}>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setSpec(null);
                setStep("input");
              }}
              style={buttonStyle("ghostLink")}
            >
              ← Back
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              style={buttonStyle("ghostLink")}
            >
              Cancel
            </button>
            <button ref={createRef} type="button" onClick={create} style={buttonStyle("primary")}>
              Create application
            </button>
          </footer>
        </div>
      ) : null}

      {step === "creating" ? (
        <Working
          title="Creating your tailored CV…"
          sub="Drafting from your master profile and tailoring to the posting."
        />
      ) : null}
    </dialog>
  );
}

function Working({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ padding: "54px 20px", display: "grid", justifyItems: "center", gap: 14 }}>
      <span style={spinner} aria-hidden />
      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--text-3)", textAlign: "center" }}>{sub}</div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden="true"
    >
      <path d="M12 3l8 4v5c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V7z" />
    </svg>
  );
}

const dialogStyle: CSSProperties = {
  padding: 0,
  width: "calc(100% - 2rem)",
  maxWidth: 600,
  maxHeight: "86vh",
  overflow: "auto",
  margin: "7vh auto",
  background: "var(--panel)",
  border: "1px solid var(--line-strong)",
  borderRadius: 16,
  boxShadow: "0 40px 100px -30px rgba(0, 0, 0, 0.7)",
  color: "var(--text)",
  fontFamily: "var(--ui)",
  animation: "fadeUp 0.25s ease",
};
const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "15px 18px",
  borderBottom: "1px solid var(--line)",
};
const iconSquare: CSSProperties = {
  flex: "none",
  width: 26,
  height: 26,
  borderRadius: 7,
  background: "color-mix(in srgb, var(--accent) 16%, transparent)",
  color: "var(--accent)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const bodyPad: CSSProperties = { padding: "16px 18px" };
const eyebrow: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-3)",
};
// A control's SOLE field label is essential text, not muted eyebrow metadata → --text-2 for AA
// (design-system.md §Typography; --text-3 is only ~3.4:1 on --panel in light). The section captions
// below (Detected role / Must-haves) keep `eyebrow` — they caption a group, not a single control.
const fieldLabel: CSSProperties = { ...eyebrow, color: "var(--text-2)" };
const tabsWrap: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: 4,
  background: "var(--panel-2)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  marginBottom: 16,
};
const tabBase: CSSProperties = {
  flex: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "8px 6px",
  fontSize: 12.5,
  fontWeight: 600,
  borderRadius: 7,
};
const tabActive: CSSProperties = {
  ...tabBase,
  color: "var(--text)",
  background: "var(--panel)",
  border: "1px solid var(--line)",
};
const tabDisabled: CSSProperties = {
  ...tabBase,
  color: "var(--text-3)",
  background: "transparent",
  border: "1px solid transparent",
  cursor: "not-allowed",
};
const soonTag: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 8.5,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-3)",
  border: "1px solid var(--line)",
  borderRadius: 4,
  padding: "1px 4px",
};
const helper: CSSProperties = {
  margin: "8px 0 0",
  fontSize: 11.5,
  color: "var(--text-3)",
  lineHeight: 1.5,
};
const footerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 16,
  justifyContent: "flex-end",
};
const detectedCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "14px 15px",
  border: "1px solid var(--line)",
  borderRadius: 11,
  background: "var(--panel-2)",
  marginBottom: 14,
};
const mustHaveRow: CSSProperties = {
  fontSize: 12.5,
  color: "var(--text)",
  lineHeight: 1.45,
  padding: "9px 11px",
  borderRadius: 9,
  border: "1px solid var(--line)",
  background: "var(--panel)",
};
const infoNote: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  padding: "11px 13px",
  borderRadius: 10,
  border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--line))",
  background: "color-mix(in srgb, var(--accent) 7%, var(--panel))",
};
const spinner: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: "50%",
  border: "3px solid var(--line)",
  borderTopColor: "var(--accent)",
  animation: "spin 0.7s linear infinite",
};
