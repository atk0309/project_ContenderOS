"use client";

// The fidelity reference page (dev-only) — every src/ui primitive + the token palette, in BOTH themes
// at the current width. This is the foundation sign-off gate: a screen PR is judged against the
// vendored design (docs/design/) using design-system.md's rubric, and the primitives are locked here
// first. Lives OUTSIDE the (app) group so it needs no auth/shell; 404s in production.
import { notFound } from "next/navigation";
import { type CSSProperties, useState } from "react";
import type { Checklist } from "@/lib/sse";
import {
  AGENT_IDENTITY,
  AgentBadge,
  AgentChecklist,
  Banner,
  Button,
  Card,
  Field,
  Gauge,
  IconButton,
  PageHeader,
  Segmented,
  type Stage,
  StageDots,
  Switch,
  TextArea,
  tagStyle,
  VerdictPill,
} from "@/ui";

const CHROME_TOKENS = [
  "--bg",
  "--panel",
  "--panel-2",
  "--raised",
  "--line",
  "--line-strong",
  "--text",
  "--text-2",
  "--text-3",
  "--accent",
  "--accent-2",
  "--ok",
  "--warn",
  "--bad",
  "--ink-warn",
  "--switch-track-off",
  "--switch-knob-ring",
];
const STAGES: Stage[] = [
  { key: "applied", short: "Applied", state: "done", tone: "accent" },
  { key: "screen", short: "Screen", state: "done", tone: "accent" },
  { key: "interview", short: "Interview", state: "current", tone: "accent" },
  { key: "final", short: "Final", state: "pending", tone: "accent" },
  { key: "offer", short: "Offer", state: "pending", tone: "ok" },
];
const DEMO_CHECKLIST: Checklist = {
  order: ["parser", "tailor", "editor"],
  status: { parser: "done", tailor: "running", editor: "running" },
};

export default function DesignReference() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div style={{ display: "flex", flexWrap: "wrap" }}>
      <ThemePanel theme="dark" />
      <ThemePanel theme="light" />
    </div>
  );
}

function ThemePanel({ theme }: { theme: "dark" | "light" }) {
  return (
    <div
      data-theme={theme}
      style={{
        flex: "1 1 420px",
        minWidth: 0,
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--ui)",
        padding: 24,
        minHeight: "100vh",
      }}
    >
      <PageHeader eyebrow="Design system" title={`${theme} theme`} />
      <div style={{ display: "flex", flexDirection: "column", gap: 22, marginTop: 18 }}>
        <Section title="Colour tokens">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {CHROME_TOKENS.map((t) => (
              <Swatch key={t} token={t} />
            ))}
          </div>
        </Section>

        <Section title="Typography">
          <div style={{ fontFamily: "var(--ui)", fontSize: 20, fontWeight: 700 }}>
            Archivo — UI 20/700
          </div>
          <div style={{ fontFamily: "var(--ui)", fontSize: 13 }}>Archivo — body 13</div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            IBM Plex Mono — label 11
          </div>
          <div
            style={{
              fontFamily: "var(--serif)",
              fontSize: 16,
              color: "var(--ink)",
              background: "var(--paper)",
              padding: "8px 12px",
              borderRadius: 8,
            }}
          >
            Source Serif 4 — the CV paper
          </div>
        </Section>

        <Section title="Buttons">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="ghostLink">Ghost link</Button>
            <Button variant="danger">Danger</Button>
            <Button disabled>Disabled</Button>
            <IconButton label="Example icon button">
              <span aria-hidden style={{ fontFamily: "var(--mono)" }}>
                +
              </span>
            </IconButton>
          </div>
        </Section>

        <Section title="Tags & agent badges">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={tagStyle("var(--ok)")}>ok</span>
            <span style={tagStyle("var(--warn)")}>warn</span>
            <span style={tagStyle("var(--bad)")}>bad</span>
            {Object.keys(AGENT_IDENTITY).map((k) => (
              <AgentBadge key={k} agent={k} />
            ))}
          </div>
        </Section>

        <Section title="Verdict">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
            <Gauge score={82} color="var(--ok)" />
            <Gauge score={58} color="var(--warn)" size={96} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <VerdictPill decision="pass" score={82} />
              <VerdictPill decision="borderline" score={58} />
              <VerdictPill decision="reject" score={31} />
            </div>
          </div>
        </Section>

        <Section title="Controls">
          <Interactive />
        </Section>

        <Section title="Stage pipeline">
          <StageDots stages={STAGES} company="Acme" onPick={() => {}} />
        </Section>

        <Section title="Surfaces">
          <Banner kind="ok" text="A success banner." />
          <Banner kind="bad" text="An error banner." />
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Card</div>
            <Field label="Field label" placeholder="Input…" />
            <TextArea label="Textarea label" placeholder="Multi-line input…" rows={3} />
          </Card>
        </Section>

        <Section title="Live run checklist">
          <Card>
            <AgentChecklist
              checklist={DEMO_CHECKLIST}
              statusLine="Tailor is rewriting to match…"
              label={(id) => id.charAt(0).toUpperCase() + id.slice(1)}
              footnote="Static per-agent glyphs — no spinner (reduced-motion safe)."
            />
          </Card>
        </Section>
      </div>
    </div>
  );
}

function Interactive() {
  const [on, setOn] = useState(true);
  const [strictness, setStrictness] = useState<"lenient" | "balanced" | "strict">("balanced");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Switch checked={on} onChange={setOn} label="Example toggle" />
        <span style={{ fontSize: 12, color: "var(--text-2)" }}>{on ? "On" : "Off"}</span>
      </span>
      <div style={{ width: 240 }}>
        <Segmented
          ariaLabel="Strictness"
          value={strictness}
          onChange={setStrictness}
          options={[
            { value: "lenient", label: "Lenient" },
            { value: "balanced", label: "Balanced" },
            { value: "strict", label: "Strict" },
          ]}
        />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2
        style={{
          margin: 0,
          fontSize: 12,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-3)",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Swatch({ token }: { token: string }) {
  const sw: CSSProperties = {
    width: 64,
    height: 40,
    borderRadius: 8,
    background: `var(${token})`,
    border: "1px solid var(--line)",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={sw} />
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--text-3)" }}>
        {token}
      </span>
    </div>
  );
}
