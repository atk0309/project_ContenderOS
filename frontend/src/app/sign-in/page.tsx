"use client";

// Sign-in, reskinned to the Claude design: radial-gradient + masked-grid backdrop, a centered modal,
// the Microsoft SSO button, and (where the mockup shows demo-role buttons, which we don't have) our
// real second path — the passwordless magic link. Both hit the FastAPI backend (same-origin, proxied
// via lib/proxy.ts), which issues the http-only session cookie. Outside the (app) shell (invariant 3).
import { type CSSProperties, type FormEvent, useState } from "react";
import { BRAND_NAME } from "@/lib/brand";
import { Banner, buttonStyle, inputStyle } from "@/ui";
import { MicrosoftLogo } from "./MicrosoftLogo";

// Same-origin: /auth/* is proxied to the private backend; the M365 link is a top-level navigation.
const API = "";

const ERRORS: Record<string, string> = {
  link: "That sign-in link is invalid or expired — request a fresh one.",
  not_allowed: "That account isn't on the allowlist for this private app.",
  sso: "Microsoft 365 sign-in didn't complete — please try again, or use a sign-in link below.",
};

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const queryError =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("error") : null;
  const banner = err ?? (queryError ? (ERRORS[queryError] ?? "Sign-in failed.") : null);

  async function requestLink(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${API}/auth/magic/request`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setSent(true);
    } catch {
      setErr("Couldn't send the link — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={backdrop}>
      <div aria-hidden style={grid} />
      <section style={modal}>
        <div style={logoRow}>
          <span style={mark} aria-hidden>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
              focusable="false"
            >
              <path d="M4 5h11M4 10h16M4 15h8M4 20h13" />
            </svg>
          </span>
          <div>
            <div style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>{BRAND_NAME}</div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10.5,
                color: "var(--text-3)",
                letterSpacing: "0.04em",
              }}
            >
              PRIVATE · 2 SEATS
            </div>
          </div>
        </div>

        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
          Sign in
        </h1>
        <p style={{ margin: "4px 0 22px", color: "var(--text-2)", fontSize: 13 }}>
          Continue with single sign-on.
        </p>

        {banner ? (
          <div style={{ marginBottom: 16 }}>
            <Banner kind="bad" text={banner} />
          </div>
        ) : null}

        <a href={`${API}/auth/entra/login`} className="cos-lift" style={msButton}>
          <MicrosoftLogo /> Sign in with Microsoft
        </a>

        <div style={dividerRow}>
          <span style={hr} />
          <span style={dividerLabel}>Or a sign-in link</span>
          <span style={hr} />
        </div>

        {sent ? (
          <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.55, margin: 0 }}>
            Check your inbox — we emailed a sign-in link to <strong>{email}</strong>. It expires in
            15 minutes.
          </p>
        ) : (
          <form onSubmit={requestLink} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Email address"
              style={inputStyle}
            />
            <button
              type="submit"
              disabled={busy}
              style={{ ...buttonStyle("primary", busy), width: "100%", padding: "11px 14px" }}
            >
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}

        <div style={footer}>
          <MicrosoftLogo size={15} /> Secured by Microsoft 365 · single sign-on
        </div>
      </section>
    </main>
  );
}

const backdrop: CSSProperties = {
  // Scrollable + dvh so a short viewport never clips the modal; the modal centres via margin:auto
  // (align-items:center would clip the top when the modal is taller than the viewport).
  minHeight: "100dvh",
  display: "flex",
  padding: 24,
  position: "relative",
  overflowY: "auto",
  background:
    "radial-gradient(120% 90% at 50% -10%, color-mix(in srgb, var(--accent) 9%, var(--bg)), var(--bg) 60%)",
};
const grid: CSSProperties = {
  // Fixed so the decorative grid stays viewport-anchored while the modal scrolls.
  position: "fixed",
  inset: 0,
  backgroundImage:
    "linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)",
  backgroundSize: "48px 48px",
  opacity: 0.35,
  maskImage: "radial-gradient(circle at 50% 38%, rgba(0,0,0,1), transparent 72%)",
  WebkitMaskImage: "radial-gradient(circle at 50% 38%, rgba(0,0,0,1), transparent 72%)",
  pointerEvents: "none",
};
const modal: CSSProperties = {
  position: "relative",
  margin: "auto",
  width: "100%",
  maxWidth: 392,
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: "34px 32px 28px",
  boxShadow: "0 30px 80px -30px rgba(0,0,0,0.6)",
  animation: "fadeUp 0.4s ease",
};
const logoRow: CSSProperties = { display: "flex", alignItems: "center", gap: 11, marginBottom: 26 };
const mark: CSSProperties = {
  width: 30,
  height: 30,
  border: "1.5px solid var(--accent)",
  borderRadius: 7,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--accent)",
};
const msButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 11,
  width: "100%",
  padding: "13px 14px",
  background: "var(--panel-2)",
  // base border comes from .cos-lift (so its :hover border-color applies).
  borderRadius: 10,
  fontWeight: 600,
  fontSize: 14,
  color: "var(--text)",
  textDecoration: "none",
};
const dividerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  margin: "18px 0 13px",
};
const hr: CSSProperties = { flex: 1, height: 1, background: "var(--line)" };
const dividerLabel: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  letterSpacing: "0.08em",
  color: "var(--text-3)",
  textTransform: "uppercase",
};
const footer: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  marginTop: 24,
  paddingTop: 18,
  borderTop: "1px solid var(--line)",
  color: "var(--text-2)",
  fontSize: 11.5,
};
