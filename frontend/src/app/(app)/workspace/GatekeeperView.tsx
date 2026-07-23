"use client";

// The Gatekeeper subview (B3) — a same-session, per-CV read of the in-session `ReviewBundle.gatekeeper`
// (ADR 0011 subview; the review RUN now persists + rehydrates per ADR 0013, but this Gatekeeper read
// stays derived from the in-session bundle — no separate verdict history). Reskinned to the Claude
// design's Gatekeeper screen
// (`docs/design/Contender.dc.html`, the `gkDetail` block): the ATS gauge + decision ring, the
// recruiter "20-second read" as a serif impression, met/unmet must-haves, present/missing keywords,
// and the recruiter fixes (applicable vs advisory).
//
// Named divergences (docs/architecture/design-system.md §Divergences, ADR 0011): the verdict has ONE
// `recruiterNotes` (rendered as the serif impression) and no headline/sub/per-fix-delta — those slots
// are dropped, not blanked. Present/met derive from the stored `JobSpec` minus the verdict's negatives
// (normalized matching, in logic.ts). "Apply fix" reuses the review panel's correctability predicate:
// an applicable bullet-anchored fix opens in the Workspace where the existing accept→Corrector flow
// lives; every other row carries an explicit `GatekeeperFixState` (applied / blocked-dirty /
// advisory / stale — see logic.ts) so no row is ever dead and unexplained.
//
// A11y/fidelity (design-system.md rubric §6): tokens-only colours (the machine guard forbids literals);
// semantic colour lives on dots/borders/fills while ESSENTIAL text stays --text/--text-2 (--text-3 is
// eyebrow-only); the met/unmet status is exposed to assistive tech via visually-hidden text (not the
// aria-hidden glyph alone); one <h1> + <h2> card headings give a real outline; interactive targets are
// ≥44px.
import type { CSSProperties } from "react";
import type { Schemas } from "@/lib/api/client";
import { agentIdentity, DECISION_META, Gauge, VerdictPill } from "@/ui";
import { GatekeeperIcon } from "../icons";
import {
  type GatekeeperEmptyReason,
  type GatekeeperFix,
  type KeywordMatch,
  type MustHaveStatus,
  STALE_REVIEW_PHRASE,
} from "./logic";
import { mono, srOnly } from "./styles";

type GatekeeperVerdict = Schemas["GatekeeperVerdict"];
type JobSpec = Schemas["JobSpec"];

const GATE = agentIdentity("gate");

export function GatekeeperView({
  verdict,
  jobSpec,
  mustHaves,
  keywords,
  fixes,
  stale = false,
  onBack,
  onOpenFix,
}: {
  verdict: GatekeeperVerdict;
  jobSpec: JobSpec | null;
  mustHaves: MustHaveStatus[];
  keywords: KeywordMatch;
  fixes: GatekeeperFix[];
  /** The review is version-drifted (ADR 0016): the verdict stays visible under ONE stale banner —
   *  the region's single carrier (no separate chip; no `role="status"` claim, since a status region
   *  doesn't announce content already present at mount — reading order covers it). */
  stale?: boolean;
  onBack: () => void;
  /** Open the flagged bullet's note in the Workspace editor (where accept→Corrector lives). */
  onOpenFix: () => void;
}) {
  const decisionColor = (DECISION_META[verdict.decision] ?? DECISION_META.borderline).color;
  const unmetCount = mustHaves.filter((m) => !m.met).length;
  const unmetColor = unmetCount === 0 ? "var(--ok)" : "var(--warn)";
  const unmetLabel = unmetCount === 0 ? "all met" : `${unmetCount} unmet`;
  const applicableCount = fixes.filter((f) => f.state === "applicable").length;
  const appliedCount = fixes.filter((f) => f.state === "applied").length;
  // Base guidance derives STRICTLY from the row states: applicable rows get the accept nudge, and
  // the "advisory" wording fires ONLY when advisory rows (`state === "advisory"`) exist —
  // count-scoped when other rows share the card, never the blanket "These…", so a stale no-tag
  // bullet row is never mislabelled advisory (the stale banner explains those rows) and an
  // all-applied card leaves the applied note (below) to carry the state. A MIXED card (applicable
  // + advisory rows) concatenates both sentences, so the accept nudge never masks the advisory
  // guidance. `blocked-dirty` rows count as NEITHER actionable nor advisory — their own row
  // microcopy ("Save your edits first") carries the reason.
  const advisoryCount = fixes.filter((f) => f.state === "advisory").length;
  const advisorySub =
    advisoryCount > 0
      ? advisoryCount === fixes.length
        ? "These are advisory — edit them in the Workspace."
        : `${advisoryCount} advisory — edit ${advisoryCount > 1 ? "them" : "it"} in the Workspace.`
      : null;
  const actionableSub =
    applicableCount > 0 ? "Open a flagged bullet in the Workspace to accept the rewrite." : null;
  const fixesSub =
    actionableSub && advisorySub
      ? `${actionableSub} ${advisorySub}`
      : (actionableSub ??
        advisorySub ??
        (fixes.length > 0
          ? null
          : "No specific fixes flagged — lift the score by covering the unmet must-haves and missing keywords above."));
  // The "N applied" sub-copy: its "— re-run Review to re-check" tail rides ONLY while the stale
  // banner is absent — the banner is this region's single drift carrier, so no second re-run nudge
  // renders beside it.
  const appliedNote =
    appliedCount > 0
      ? `${appliedCount} applied${stale ? "" : " — re-run Review to re-check"}.`
      : null;

  return (
    <div style={page}>
      <GateHeader jobSpec={jobSpec} onBack={onBack} />

      {/* The ONE stale banner (ADR 0016) — this region's single drift carrier, built from the
          canonical phrase. Text at --text-2 (colour on the border/tint only — never warn-as-text). */}
      {stale ? <p style={staleBanner}>{STALE_REVIEW_PHRASE}.</p> : null}

      {/* Top row: gauge + decision ring | the recruiter "20-second read". */}
      <div style={topRow}>
        <div style={gaugeCard(decisionColor)}>
          {/* The decision is the screen's core datum; an sr-only heading puts it in the outline so a
              heading-nav lands on the verdict, not first on the impression card. */}
          <h2 style={srOnly}>Recruiter verdict</h2>
          <Gauge
            score={verdict.atsMatchScore}
            color={decisionColor}
            size={124}
            caption="ATS / 100"
          />
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <VerdictPill decision={verdict.decision} stale={stale} />
            <span style={roleEyebrow}>{GATE.role}</span>
          </div>
        </div>

        <div style={impressionCard}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
            <span style={badge} aria-hidden>
              {GATE.glyph}
            </span>
            <h2 style={impressionEyebrow}>The 20-second recruiter read</h2>
          </div>
          {verdict.recruiterNotes.trim() ? (
            <blockquote style={serifQuote(decisionColor)}>{verdict.recruiterNotes}</blockquote>
          ) : (
            <p style={mutedRow}>No recruiter note accompanied this verdict.</p>
          )}
        </div>
      </div>

      {/* Bottom row: must-haves + keywords | recruiter fixes. */}
      <div style={bottomRow}>
        <div
          style={{
            flex: "1.3 1 320px",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          <section style={listCard}>
            <div style={listHead}>
              <h2 style={cardTitle}>Must-haves from the posting</h2>
              <span
                style={{
                  ...mono,
                  fontSize: 11,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  color: "var(--text-2)",
                }}
              >
                <span
                  style={{ width: 7, height: 7, borderRadius: "50%", background: unmetColor }}
                  aria-hidden
                />
                {unmetLabel}
              </span>
            </div>
            <div style={listBody}>
              {mustHaves.length > 0 ? (
                mustHaves.map((m) => (
                  <div key={m.label} style={mhRow(m.met)}>
                    <span style={mhMark(m.met)} aria-hidden>
                      {m.met ? "✓" : "✕"}
                    </span>
                    {/* Status to assistive tech (the glyph is aria-hidden; colour isn't enough). */}
                    <span style={srOnly}>{m.met ? "Met — " : "Not met — "}</span>
                    <span style={mhLabel}>{m.label}</span>
                  </div>
                ))
              ) : (
                <p style={mutedRow}>No must-haves were detected in the posting.</p>
              )}
            </div>
          </section>

          <section style={kwCard}>
            <h2 style={cardTitle}>Keyword match</h2>
            <div style={{ ...kwSubhead, marginTop: 11 }}>Present</div>
            {keywords.present.length > 0 ? (
              <div style={chipWrap}>
                {keywords.present.map((k) => (
                  <span key={k} style={kwChip("var(--ok)")}>
                    {k}
                  </span>
                ))}
              </div>
            ) : (
              <p style={mutedRow}>None present yet.</p>
            )}
            <div style={{ ...kwSubhead, marginTop: 14 }}>Missing</div>
            {keywords.missing.length > 0 ? (
              <div style={chipWrap}>
                {keywords.missing.map((k) => (
                  <span key={k} style={kwChip("var(--warn)")}>
                    {k}
                  </span>
                ))}
              </div>
            ) : (
              <p style={mutedRow}>No required keywords missing.</p>
            )}
          </section>
        </div>

        <section style={fixesCard}>
          <div style={fixesHead}>
            <h2 style={cardTitle}>Recruiter fixes</h2>
            {fixesSub ? <div style={fixesSubStyle}>{fixesSub}</div> : null}
            {appliedNote ? <div style={fixesSubStyle}>{appliedNote}</div> : null}
          </div>
          {fixes.length > 0 ? (
            <div style={listBody}>
              {/* Row rendering by explicit state (ADR 0016): `applied` chip → `applicable` "Open in
                  Workspace →" → `blocked-dirty` "Save your edits first" microcopy (the rail
                  dirty-hint verb form — temporary, no button) → `advisory` tag → `stale` NOTHING
                  ("Advisory" would misread as non-bullet; `stale` is only reachable drifted, so the
                  banner is guaranteed co-present and explains the row). */}
              {fixes.map((f) => (
                <div key={f.key} style={fixRow(f.state)}>
                  <div style={fixContext}>{f.context}</div>
                  <div style={fixComment}>{f.comment}</div>
                  <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                    {f.state === "applied" ? (
                      // The mockup's done-state chip with the AA divergence: the ✓ glyph carries
                      // --ok, the label stays --text-2 (never ok-as-text). The visible pair is
                      // aria-hidden; the srOnly text is the AT carrier and collapses to just
                      // "Applied" when the stale banner shows (single carrier — no per-row re-run
                      // spam beside the banner).
                      <span style={appliedChip}>
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.4}
                          style={{ color: "var(--ok)" }}
                          aria-hidden="true"
                        >
                          <path d="M5 12l4 4 10-10" />
                        </svg>
                        <span aria-hidden>Applied</span>
                        <span style={srOnly}>
                          {stale ? "Applied" : "Applied — re-run Review to re-check"}
                        </span>
                      </span>
                    ) : f.state === "applicable" ? (
                      <button
                        type="button"
                        onClick={onOpenFix}
                        className="cos-ghostbtn"
                        style={openBtn}
                      >
                        Open in Workspace →
                      </button>
                    ) : f.state === "blocked-dirty" ? (
                      <span style={blockedHint}>Save your edits first</span>
                    ) : f.state === "advisory" ? (
                      <span style={advisoryTag}>Advisory</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** The empty / loading / stale states — no live verdict to show (designed empty pattern). */
export function GatekeeperEmpty({
  reason,
  onBack,
  onOpenWorkspace,
}: {
  reason: GatekeeperEmptyReason;
  onBack: () => void;
  onOpenWorkspace: () => void;
}) {
  const copy = {
    "no-cv": {
      heading: "No live recruiter verdict",
      body: "Open a CV in the Workspace and run Review to see how a recruiter and the ATS read it. The verdict is live only for the CV you're working on — it isn't saved.",
      cta: "Open the Workspace →",
      onCta: onOpenWorkspace,
    },
    "no-job": {
      heading: "No target job to screen against",
      body: "This draft isn't tailored to a posting, so there's no recruiter / ATS verdict to show. Tailor it to a job in the Workspace first.",
      cta: "Back to the Workspace →",
      onCta: onBack,
    },
    running: {
      heading: "Reading the posting…",
      body: "The recruiter screen is running. The verdict will appear here the moment it lands.",
      cta: "Back to the Workspace →",
      onCta: onBack,
    },
    drifted: {
      // References the REVIEW, not a verdict — this subview shows precisely when there is NO live
      // verdict (a drifted run whose Gatekeeper produced nothing still lands here; the call site
      // suppresses its stale gate-failure). Built from the canonical phrase, whose "re-run to
      // refresh" is the ONE re-run instruction (single carrier — no second nudge).
      heading: "This review is out of date",
      body: `${STALE_REVIEW_PHRASE}. There's no current recruiter read to show until then.`,
      cta: "Back to the Workspace →",
      onCta: onBack,
    },
    failed: {
      heading: "The recruiter screen couldn't run",
      body: "The Gatekeeper couldn't produce a verdict for this CV last time. Re-run Review in the Workspace to try again.",
      cta: "Back to the Workspace →",
      onCta: onBack,
    },
    "no-review": {
      heading: "Run Review for the recruiter read",
      body: "This CV hasn't been reviewed yet. Run Review in the Workspace to get the Gatekeeper's recruiter / ATS verdict.",
      cta: "Back to the Workspace →",
      onCta: onBack,
    },
  }[reason];

  return (
    <div style={page}>
      <div style={emptyWrap}>
        <span style={emptyIcon} aria-hidden>
          {reason === "running" ? <Spinner /> : <GatekeeperIcon size={26} />}
        </span>
        <h1 style={emptyHeading}>{copy.heading}</h1>
        <p style={emptyBody}>{copy.body}</p>
        <button type="button" onClick={copy.onCta} className="cos-brighten" style={emptyCta}>
          {copy.cta}
        </button>
      </div>
    </div>
  );
}

function GateHeader({ jobSpec, onBack }: { jobSpec: JobSpec | null; onBack: () => void }) {
  const subtitle = [jobSpec?.title, jobSpec?.company].filter(Boolean).join(" · ");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <button
        type="button"
        onClick={onBack}
        className="cos-ghostbtn"
        style={backBtn}
        aria-label="Back to the Workspace"
      >
        <span aria-hidden>←</span> Workspace
      </button>
      <div style={{ minWidth: 0 }}>
        <div style={topEyebrow}>Gatekeeper · {GATE.role}</div>
        <h1 style={topTitle}>{subtitle || "Recruiter read"}</h1>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
      style={{ animation: "spin 0.8s linear infinite" }}
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.5" />
    </svg>
  );
}

// --- styles (chrome tokens only) -------------------------------------------------------------------

const page: CSSProperties = {
  maxWidth: 1080,
  margin: "0 auto",
  padding: "26px 26px 60px",
  display: "flex",
  flexDirection: "column",
  gap: 22,
  minHeight: "60vh",
};
const backBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--text-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "7px 13px",
  cursor: "pointer",
  fontFamily: "var(--ui)",
};
const topEyebrow: CSSProperties = {
  ...mono,
  fontSize: 10,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--text-3)",
};
const topTitle: CSSProperties = {
  margin: "3px 0 0",
  fontSize: 14.5,
  fontWeight: 600,
  letterSpacing: "-0.005em",
  color: "var(--text)",
};

// The stale banner (ADR 0016): --text-2 ink; the warn colour lives on the border/tint only.
const staleBanner: CSSProperties = {
  margin: 0,
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid color-mix(in srgb, var(--warn) 32%, var(--line))",
  background: "color-mix(in srgb, var(--warn) 8%, var(--panel))",
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "var(--text-2)",
};

const topRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" };
function gaugeCard(color: string): CSSProperties {
  return {
    flex: "1 1 300px",
    minWidth: 0,
    border: `1px solid color-mix(in srgb, ${color} 40%, var(--line))`,
    borderRadius: 16,
    background: `color-mix(in srgb, ${color} 10%, var(--panel))`,
    padding: "24px 26px",
    display: "flex",
    gap: 24,
    alignItems: "center",
    flexWrap: "wrap",
  };
}
const roleEyebrow: CSSProperties = {
  ...mono,
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-3)",
};
const impressionCard: CSSProperties = {
  flex: "1 1 300px",
  minWidth: 0,
  border: "1px solid var(--line)",
  borderRadius: 16,
  background: "var(--panel)",
  padding: "22px 24px",
  display: "flex",
  flexDirection: "column",
};
const badge: CSSProperties = {
  width: 22,
  height: 22,
  flex: "none",
  borderRadius: 6,
  background: GATE.color,
  color: GATE.ink,
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const impressionEyebrow: CSSProperties = {
  ...mono,
  margin: 0,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  // A real <h2>, so it clears AA at --text-2 (not eyebrow --text-3) — matches the kwSubhead rationale.
  color: "var(--text-2)",
};
function serifQuote(color: string): CSSProperties {
  return {
    margin: 0,
    fontFamily: "var(--serif)",
    fontSize: 18,
    lineHeight: 1.5,
    color: "var(--text)",
    fontStyle: "italic",
    paddingLeft: 16,
    borderLeft: `2px solid ${color}`,
  };
}

const bottomRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 20,
  alignItems: "flex-start",
};
const listCard: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 14,
  background: "var(--panel)",
  overflow: "hidden",
};
const listHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "13px 16px",
  borderBottom: "1px solid var(--line)",
};
const cardTitle: CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" };
const listBody: CSSProperties = {
  padding: 9,
  display: "flex",
  flexDirection: "column",
  gap: 7,
};
function mhRow(met: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 11,
    padding: "10px 11px",
    borderRadius: 9,
    background: met
      ? "color-mix(in srgb, var(--ok) 8%, var(--panel-2))"
      : "color-mix(in srgb, var(--bad) 9%, var(--panel-2))",
    border: met
      ? "1px solid color-mix(in srgb, var(--ok) 26%, var(--line))"
      : "1px solid color-mix(in srgb, var(--bad) 38%, var(--line))",
  };
}
function mhMark(met: boolean): CSSProperties {
  return {
    width: 19,
    height: 19,
    flex: "none",
    borderRadius: "50%",
    background: met ? "var(--ok)" : "var(--bad)",
    // Theme-aware ink (dark glyph in dark theme, light in light) — AA on the ok/bad fill in both
    // themes (computed ≥4.5; light --ok is a thin 4.51, tracked in design-system.md).
    color: "var(--agent-ink)",
    fontSize: 11,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  };
}
const mhLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: "var(--text)",
  minWidth: 0,
  overflowWrap: "anywhere",
};

const kwCard: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 14,
  background: "var(--panel)",
  padding: "15px 16px 17px",
};
const kwSubhead: CSSProperties = {
  ...mono,
  fontSize: 9.5,
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  // present vs missing is a load-bearing status label, so it clears AA (--text-2, not eyebrow --text-3).
  color: "var(--text-2)",
  marginBottom: 7,
};
const chipWrap: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7 };
function kwChip(color: string): CSSProperties {
  return {
    ...mono,
    fontSize: 11,
    // Colour on the border/fill; text stays --text-2 so the chip clears WCAG-AA in both themes (rubric
    // §6 — a deliberate divergence from the mockup's colour-mixed chip text, which dips below AA).
    color: "var(--text-2)",
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 28%, var(--line))`,
    borderRadius: 6,
    padding: "3px 9px",
    overflowWrap: "anywhere",
  };
}

const fixesCard: CSSProperties = {
  flex: "1 1 300px",
  minWidth: 0,
  border: "1px solid var(--line)",
  borderRadius: 14,
  background: "var(--panel)",
  overflow: "hidden",
};
const fixesHead: CSSProperties = { padding: "13px 16px", borderBottom: "1px solid var(--line)" };
const fixesSubStyle: CSSProperties = {
  fontSize: 11.5,
  color: "var(--text-2)",
  marginTop: 3,
  lineHeight: 1.45,
};
// The applied row takes the mockup's done-state tint/edge (`--ok` mixes); an applicable row keeps
// the accent edge; everything else (blocked-dirty / advisory / stale) stays plain.
function fixRow(state: GatekeeperFix["state"]): CSSProperties {
  return {
    border:
      state === "applied"
        ? "1px solid color-mix(in srgb, var(--ok) 30%, var(--line))"
        : state === "applicable"
          ? "1px solid color-mix(in srgb, var(--accent) 30%, var(--line))"
          : "1px solid var(--line)",
    borderRadius: 10,
    background:
      state === "applied" ? "color-mix(in srgb, var(--ok) 8%, var(--panel-2))" : "var(--panel-2)",
    padding: "12px 13px",
  };
}
const appliedChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  fontSize: 11.5,
  fontWeight: 600,
  // AA divergence (rubric §6): the mockup inks the whole chip var(--ok); we keep the ✓ glyph --ok
  // and the label at --text-2 (ok-as-text dips below AA in light theme).
  color: "var(--text-2)",
};
const fixContext: CSSProperties = {
  ...mono,
  fontSize: 9.5,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--text-2)",
  marginBottom: 6,
};
const fixComment: CSSProperties = { fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 };
const openBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--accent)",
  border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--line))",
  borderRadius: 7,
  padding: "6px 13px",
  cursor: "pointer",
  fontFamily: "var(--ui)",
};
const advisoryTag: CSSProperties = {
  ...mono,
  fontSize: 10,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--text-2)",
};
// The blocked-dirty microcopy — the rail dirty-hint form (mono, --text-2; never warn-as-text), a
// muted sentence rather than a tag: the block is temporary (save/discard the draft), not a category.
const blockedHint: CSSProperties = {
  ...mono,
  fontSize: 10.5,
  color: "var(--text-2)",
};

const mutedRow: CSSProperties = {
  margin: 0,
  padding: "4px 2px",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  color: "var(--text-2)",
  lineHeight: 1.5,
};

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
const emptyCta: CSSProperties = {
  marginTop: 4,
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
