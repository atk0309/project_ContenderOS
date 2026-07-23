"use client";

// The Diff subview (ADR 0015) — a per-CV view of every bullet whose SAVED text now differs from the
// review-start baseline (`review.reviewedText`), derived in page.tsx and passed in. Cumulative since the
// review ran (applied corrections + manual edits) and durable by derivation: it recomputes from persisted
// state on every visit, so it survives navigation/reload — no captured copy, no stale state. NEUTRAL: a
// changed bullet carries no per-line agent attribution (a corrected-then-hand-edited bullet must never be
// stamped as an agent "correction"). Reskinned to the Claude design's Diff block (`docs/design/
// Contender.dc.html`, the `isDiff` block): a dotted "drafting table" surface, per-bullet cards with a
// serif BEFORE/AFTER and word-level marks, and a designed empty state.
//
// Named divergences (docs/architecture/design-system.md §Divergences): this is APP CHROME, not the render
// path — so it uses chrome tokens + serif, NOT the paper hex the mockup's diff bands use (invariant 3:
// only `src/render/` carries paper hex). Word marks are semantic <del>/<ins> with the colour on a tint +
// strikethrough; the text stays --text/--text-2 so removed/added words clear WCAG-AA (rubric §6).
import type { CSSProperties } from "react";
import { DiffIcon } from "../icons";
import { type DiffBullet, type DiffToken, wordDiff } from "./logic";
import { mono } from "./styles";

export function DiffView({
  bullets,
  onExit,
}: {
  bullets: DiffBullet[];
  /** Return to the loaded document (cv-preserving) — both the empty CTA and the populated footer. */
  onExit: () => void;
}) {
  if (bullets.length === 0) {
    return (
      <div style={page}>
        <div style={emptyWrap}>
          <span style={emptyIcon} aria-hidden>
            <DiffIcon size={26} />
          </span>
          <h1 style={emptyHeading}>No changes to compare yet</h1>
          <p style={emptyBody}>
            Corrections you apply and edits you make after a review show here, change-marked. They
            survive navigation and reload.
          </p>
          <button type="button" onClick={onExit} className="cos-brighten" style={primaryCta}>
            ← Back to the document
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={page}>
      <div style={inner}>
        <div style={headerRow}>
          <h1 style={title}>Before &amp; after</h1>
          <span style={countEyebrow}>
            {bullets.length} changed bullet{bullets.length > 1 ? "s" : ""}
          </span>
        </div>

        {bullets.map((b) => (
          <DiffCard key={b.bulletId} bullet={b} />
        ))}

        <div style={footer}>
          <button type="button" onClick={onExit} className="cos-brighten" style={primaryCta}>
            ← Back to the document
          </button>
          <span style={footerNote}>Changes since your last review.</span>
        </div>
      </div>
    </div>
  );
}

function DiffCard({ bullet }: { bullet: DiffBullet }) {
  const { before, after } = wordDiff(bullet.beforeText, bullet.afterText);
  const headingId = `diff-h-${bullet.bulletId}`;
  return (
    <section style={card} aria-labelledby={headingId}>
      <div style={cardHead}>
        <div style={{ minWidth: 0 }}>
          {/* Neutral heading — the bullet's context (role · company / section), never an agent name. */}
          <h2 id={headingId} style={cardTitle}>
            {bullet.context}
          </h2>
        </div>
      </div>

      <div style={diffBox}>
        <div style={band("var(--bad)")}>
          <span style={dot("var(--bad)")} aria-hidden />
          <span style={bandLabel}>Before</span>
        </div>
        <p style={serifText}>{renderTokens(before, "del")}</p>
        <div style={{ ...band("var(--ok)"), borderTop: "1px solid var(--line)" }}>
          <span style={dot("var(--ok)")} aria-hidden />
          <span style={bandLabel}>After</span>
        </div>
        <p style={serifText}>{renderTokens(after, "ins")}</p>
      </div>
    </section>
  );
}

/** Render a diff token stream. Changed words are SEMANTIC <del>/<ins> (announced by assistive tech, the
 *  correct HTML for a diff) — but a changed whitespace-only token renders unmarked, so a boundary
 *  insert/delete doesn't leave a stray struck space / tinted gap. */
function renderTokens(tokens: DiffToken[], changedTag: "del" | "ins") {
  return tokens.map((w) => {
    if (w.type === "same" || w.t.trim() === "") {
      return (
        <span key={w.key} style={w.type === "same" ? sameToken : undefined}>
          {w.t}
        </span>
      );
    }
    const Tag = changedTag;
    return (
      <Tag key={w.key} style={tokenStyle(w.type)}>
        {w.t}
      </Tag>
    );
  });
}

// --- styles (chrome tokens only) -------------------------------------------------------------------

const page: CSSProperties = {
  minHeight: "70vh",
  padding: "30px 26px 60px",
  // The same dotted "drafting table" surface as the preview pane (B2b).
  background: "var(--panel-2)",
  backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)",
  backgroundSize: "22px 22px",
};
const inner: CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 18,
};
const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 12,
  flexWrap: "wrap",
};
const title: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text)" };
const countEyebrow: CSSProperties = {
  ...mono,
  fontSize: 11,
  letterSpacing: "0.04em",
  color: "var(--text-2)",
};

const card: CSSProperties = { display: "flex", flexDirection: "column", gap: 12 };
const cardHead: CSSProperties = { display: "flex", alignItems: "center", gap: 11 };
const cardTitle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text)",
  overflowWrap: "anywhere",
};

const diffBox: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 12,
  overflow: "hidden",
  background: "var(--panel)",
  // Allowlisted neutral shadow (the note/diff elevation rung).
  boxShadow: "0 18px 50px -28px rgba(0, 0, 0, 0.5)",
};
function band(color: string): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    background: `color-mix(in srgb, ${color} 12%, var(--panel))`,
  };
}
function dot(color: string): CSSProperties {
  return { width: 7, height: 7, borderRadius: "50%", background: color, flex: "none" };
}
const bandLabel: CSSProperties = {
  // The BEFORE/AFTER label is a status label — kept at --text-2 (AA) with the colour on the dot/tint.
  ...mono,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-2)",
};
const serifText: CSSProperties = {
  margin: 0,
  padding: "18px 20px",
  fontFamily: "var(--serif)",
  fontSize: 15.5,
  lineHeight: 1.62,
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
const sameToken: CSSProperties = { color: "var(--text)" };
function tokenStyle(type: DiffToken["type"]): CSSProperties {
  if (type === "del") {
    return {
      // Removed text stays readable (--text-2, AA) with a strikethrough + a --bad tint carrying colour.
      color: "var(--text-2)",
      textDecoration: "line-through",
      background: "color-mix(in srgb, var(--bad) 14%, transparent)",
      borderRadius: 3,
      padding: "0 1px",
    };
  }
  if (type === "add") {
    return {
      color: "var(--text)",
      // <ins>'s default underline is dropped — the --ok tint + bold carries "added" (matches the mockup).
      textDecoration: "none",
      background: "color-mix(in srgb, var(--ok) 16%, transparent)",
      borderRadius: 3,
      padding: "0 2px",
      fontWeight: 600,
    };
  }
  return sameToken;
}

const footer: CSSProperties = {
  marginTop: 4,
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};
const footerNote: CSSProperties = { fontSize: 12, color: "var(--text-2)" };

const emptyWrap: CSSProperties = {
  margin: "40px auto 0",
  maxWidth: 380,
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 14,
};
const emptyIcon: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 14,
  border: "1px solid var(--line)",
  background: "var(--panel)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-3)",
};
const emptyHeading: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  color: "var(--text)",
};
const emptyBody: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--text-2)",
  lineHeight: 1.55,
};
const primaryCta: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 44,
  padding: "9px 15px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--on-accent)",
  background: "var(--accent)",
  border: "none",
  cursor: "pointer",
  fontFamily: "var(--ui)",
};
