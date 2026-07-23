"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
// Admin & agents (owner-only). Reskinned to the Claude design's `isAdminScreen` block
// (docs/design/Contender.dc.html ~1045): an "Admin & agents" header, a "Reviewer powers" grid, and
// an "Agent configuration" card.
//
// TWO NAMED DIVERGENCES (docs/architecture/design-system.md):
//  1. "Reviewer powers" is SKIN-ONLY. Invariant 2 forbids a blocking/strictness backend — only the
//     candidate's sign-off gate blocks export. So the grid is local UI state wired to NO endpoint,
//     carrying a clear "Preview · not enforced" label; nothing here changes agent behaviour.
//  2. The design's single provider/model/temperature/baseUrl form is replaced by the REAL admin: a
//     per-provider write-only encrypted key + sync-models + tier→model assignment. Our backend is
//     richer (per-tier models, ADR 0006) and keys are encrypted at rest server-side and never
//     returned — not "kept on this device". Only the card chrome is reskinned; the logic is unchanged.
import { ApiError, api, type Schemas } from "@/lib/api/client";
import {
  AGENT_IDENTITY,
  AgentBadge,
  Banner,
  buttonStyle,
  inputStyle,
  Segmented,
  type SegmentOption,
  Switch,
} from "@/ui";
import { useAiReadiness } from "../ReadinessProvider";
import { useSession } from "../SessionProvider";

type Provider = Schemas["Provider"];
type ProviderStatus = Schemas["AdminProviderStatus"];

const PROVIDER_INFO: Record<Provider, { title: string; role: string }> = {
  anthropic: {
    title: "Anthropic (Claude)",
    role: "Authoring agents — Parser, Tailor, AI-Language Spotter, Corrector.",
  },
  openai: {
    title: "OpenAI",
    role: "Adjudication agents — Editor, Fact-Checker, Gatekeeper.",
  },
};

// Which tiers each provider exposes, and what each tier is for. The Admin Menu maps a tier to a real
// model id; agents ask for a tier, never a pinned model string.
const PROVIDER_TIERS: Record<Provider, TierKey[]> = {
  anthropic: ["strong", "fast", "cheap"],
  openai: ["strong", "fast"],
};

type TierKey = "strong" | "fast" | "cheap";
const TIER_INFO: Record<TierKey, { label: string; help: string }> = {
  strong: { label: "Strong", help: "Highest-capability model — the heaviest reasoning." },
  fast: { label: "Fast", help: "Balanced model for the bulk of calls." },
  cheap: { label: "Cheap", help: "Cheapest model for high-volume, low-stakes calls." },
};

const mono = { fontFamily: "var(--mono)" } as const;

export default function AdminPage() {
  const router = useRouter();
  const { user } = useSession();
  const { refresh: refreshAiReadiness } = useAiReadiness();
  const [phase, setPhase] = useState<"loading" | "forbidden" | "ready">("loading");
  const [status, setStatus] = useState<Schemas["AdminStatus"] | null>(null);

  const load = useCallback(async () => {
    const data = await api<Schemas["AdminStatus"]>("/admin/providers");
    setStatus(data);
    setPhase("ready");
    // A key/tier change flips global AI readiness — refresh the shell pill + workspace/dashboard CTAs
    // without a reload (load() runs on mount and after every save/sync/tier mutation via onChanged).
    refreshAiReadiness();
  }, [refreshAiReadiness]);

  useEffect(() => {
    // The shell's SessionProvider already gated auth; every allowlisted account may load this.
    let active = true;
    load().catch((err: unknown) => {
      if (!active) return;
      // Session expired mid-session (domain-call 401) — bounce to sign-in; else hide the controls
      // (a 403 here means the account was de-allowlisted — the server gate fails closed).
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/sign-in");
        return;
      }
      setPhase("forbidden");
    });
    return () => {
      active = false;
    };
  }, [load, router]);

  if (phase !== "ready" || !status) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <span style={{ ...mono, fontSize: 12, color: "var(--text-3)" }}>
          {phase === "forbidden" ? "Owner access only." : "Loading admin settings…"}
        </span>
      </div>
    );
  }

  return (
    <div style={page}>
      <div style={container}>
        {/* Header — "Admin & agents" + the owner-only badge + the restricted-to line. */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>
              Admin &amp; agents
            </h1>
            {/* Outlined accent badge. Named AA divergence: the label is --text-2 (the mockup's accent
                ink dips to 3.85:1 on --bg in light); the accent identity lives in the border. */}
            <span style={ownerBadge}>Owner only</span>
          </div>
          {/* Every ALLOWLIST_EMAILS entry is an owner (auth/allowlist.py) — corrected from the
              mockup's fictional ADMIN_EMAIL var. --text-2 (the email is information; --text-3 dips
              to 2.85:1 on --bg in light). */}
          <div style={{ ...mono, fontSize: 11, color: "var(--text-2)", marginTop: 6 }}>
            Signed in as {user.email} · every ALLOWLIST_EMAILS entry is an owner
          </div>
        </div>

        <ReviewerPowers />
        <AgentConfiguration providers={status.providers} onChanged={load} />
      </div>
    </div>
  );
}

// --- Reviewer powers (skin-only preview, invariant 2) --------------------------------------------

type Strictness = "lenient" | "balanced" | "strict";
interface ReviewerPower {
  active: boolean;
  strictness: Strictness;
  blocking: boolean;
}

// The six agents the design surfaces, in canonical identity order (src/ui/colors.ts). `as const` so
// ReviewerKey is exactly these six (a subset of AgentKey) — the powers record then has no phantom keys.
const REVIEWER_KEYS = ["parser", "tailor", "editor", "fact", "spotter", "gate"] as const;
type ReviewerKey = (typeof REVIEWER_KEYS)[number];

const STRICTNESS_OPTIONS: SegmentOption<Strictness>[] = [
  { value: "lenient", label: "Lenient" },
  { value: "balanced", label: "Balanced" },
  { value: "strict", label: "Strict" },
];

const defaultPowers = (): Record<ReviewerKey, ReviewerPower> =>
  Object.fromEntries(
    REVIEWER_KEYS.map((k) => [
      k,
      { active: true, strictness: "balanced" as Strictness, blocking: k === "gate" },
    ]),
  ) as Record<ReviewerKey, ReviewerPower>;

function ReviewerPowers() {
  // Local, ephemeral UI state — this grid is a PREVIEW (invariant 2): it is wired to no endpoint and
  // changes no agent behaviour. The labels make that explicit so it can't mislead.
  const [powers, setPowers] = useState<Record<ReviewerKey, ReviewerPower>>(defaultPowers);

  const set = (key: ReviewerKey, patch: Partial<ReviewerPower>) =>
    setPowers((p) => ({ ...p, [key]: { ...p[key], ...patch } }));

  const { activeCount, blockCount } = useMemo(() => {
    let activeCount = 0;
    let blockCount = 0;
    for (const k of REVIEWER_KEYS) {
      const p = powers[k];
      if (p.active) activeCount += 1;
      if (p.active && p.blocking) blockCount += 1;
    }
    return { activeCount, blockCount };
  }, [powers]);

  return (
    <section style={card}>
      <div style={cardHead}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Reviewer powers</h2>
            <span style={previewPill}>Preview · not enforced</span>
          </div>
          <p
            style={{
              margin: "3px 0 0",
              fontSize: 12,
              color: "var(--text-2)",
              lineHeight: 1.5,
            }}
          >
            Turn reviewers on or off, set how hard each pushes, and choose what may block an export.{" "}
            <strong style={{ color: "var(--text)", fontWeight: 600 }}>
              Not saved or enforced yet
            </strong>{" "}
            — these controls reset on reload, don&rsquo;t change which agents run, and only your
            sign-off blocks export.
          </p>
        </div>
        <span
          aria-live="polite"
          style={{
            ...mono,
            flex: "none",
            fontSize: 11,
            // A live state value (rubric §6) → --text-2 for AA, not the muted --text-3.
            color: "var(--text-2)",
            whiteSpace: "nowrap",
            marginTop: 2,
          }}
        >
          {activeCount}/6 active · {blockCount} blocking
        </span>
      </div>
      {/* A labelled fieldset so AT users hear the "preview, not enforced" caveat on entry — the toggles
          flip aria-checked but change nothing (invariant 2). */}
      <fieldset className="cos-rvgrid" aria-label="Reviewer powers — preview, not enforced">
        {REVIEWER_KEYS.map((key) => (
          <ReviewerCard key={key} agent={key} power={powers[key]} onChange={(p) => set(key, p)} />
        ))}
      </fieldset>
    </section>
  );
}

function ReviewerCard({
  agent,
  power,
  onChange,
}: {
  agent: ReviewerKey;
  power: ReviewerPower;
  onChange: (patch: Partial<ReviewerPower>) => void;
}) {
  const id = AGENT_IDENTITY[agent];
  const { active, strictness, blocking } = power;
  return (
    <div style={{ ...reviewerCard, borderLeft: `3px solid ${id.color}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        {/* Glyph badge (AA-inked via the primitive); dimmed when the reviewer is off. */}
        <span style={{ flex: "none", display: "inline-flex", opacity: active ? 1 : 0.45 }}>
          <AgentBadge agent={agent} size={30} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{id.name}</div>
          {/* The role descriptor is secondary text, not eyebrow metadata → --text-2 for AA (the
              mockup's --text-3 = 3.42:1; matches C1's "secondary role text kept AA" divergence). */}
          <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>{id.role}</div>
        </div>
        <span
          style={{
            ...mono,
            fontSize: 10,
            // Essential state value (rubric §6) → --text-2 in both states for AA; the Switch position
            // carries the on/off emphasis, so "Off" need not drop to the muted --text-3.
            color: "var(--text-2)",
            whiteSpace: "nowrap",
          }}
        >
          {active ? "On" : "Off"}
        </span>
        <Switch
          checked={active}
          onChange={(v) => onChange({ active: v })}
          label={`${id.name} active`}
          color={id.color}
        />
      </div>

      {/* Strictness + blocking gate on `active` (disabled controls carry the off-state; we don't dim
          the labels, which would risk AA — rubric §6). */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ ...controlLabel, width: 62, flex: "none" }}>Strictness</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Segmented
            options={STRICTNESS_OPTIONS}
            value={strictness}
            onChange={(v) => onChange({ strictness: v })}
            ariaLabel={`${id.name} strictness`}
            disabled={!active}
          />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Switch
          checked={blocking}
          onChange={(v) => onChange({ blocking: v })}
          label={`${id.name} can block export`}
          color="var(--warn)"
          disabled={!active}
        />
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: blocking && active ? "var(--text)" : "var(--text-2)",
          }}
        >
          {blocking ? "Can block export" : "Advisory only"}
        </span>
      </div>
    </div>
  );
}

// --- Agent configuration (the real per-provider/per-tier admin, reskinned) -----------------------

function AgentConfiguration({
  providers,
  onChanged,
}: {
  providers: ProviderStatus[];
  onChanged: () => Promise<void>;
}) {
  return (
    <section style={card}>
      <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--line)" }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Agent configuration</h2>
        <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
          Provider credentials and the per-tier models every agent runs on. Keys are encrypted at
          rest server-side and never shown again — only a masked hint. Saving a key validates it and
          pulls the live model list; assign a chat model that supports structured outputs to each
          tier.
        </p>
      </div>
      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        {providers.map((p) => (
          <ProviderPanel key={p.provider} status={p} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

function ProviderPanel({
  status,
  onChanged,
}: {
  status: ProviderStatus;
  onChanged: () => Promise<void>;
}) {
  const provider = status.provider;
  const info = PROVIDER_INFO[provider];
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState<null | "key" | "sync" | "tiers">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  // Local tier selections, seeded from the saved status.
  const [tiers, setTiers] = useState<Record<TierKey, string>>({
    strong: status.tierStrong ?? "",
    fast: status.tierFast ?? "",
    cheap: status.tierCheap ?? "",
  });

  // The panel stays mounted across a parent status refresh (it's keyed by provider), so re-seed the
  // selects when the server's saved tiers change — after a save, a sync that pruned a now-invalid
  // tier, a key rotation, or another admin session.
  useEffect(() => {
    setTiers({
      strong: status.tierStrong ?? "",
      fast: status.tierFast ?? "",
      cheap: status.tierCheap ?? "",
    });
  }, [status.tierStrong, status.tierFast, status.tierCheap]);

  async function run(kind: "key" | "sync" | "tiers", fn: () => Promise<void>) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
      await onChanged();
    } catch (err: unknown) {
      const text = err instanceof ApiError ? err.message : "Something went wrong.";
      setMsg({ kind: "bad", text });
    } finally {
      setBusy(null);
    }
  }

  const saveKey = () =>
    run("key", async () => {
      await api(`/admin/providers/${provider}/key`, {
        method: "PUT",
        body: JSON.stringify({ apiKey: keyInput }),
      });
      setKeyInput(""); // never keep the key in component state past the save
      setMsg({ kind: "ok", text: "Key saved and validated." });
    });

  const syncModels = () =>
    run("sync", async () => {
      await api(`/admin/providers/${provider}/sync-models`, { method: "POST" });
      setMsg({ kind: "ok", text: "Model list refreshed." });
    });

  const saveTiers = () =>
    run("tiers", async () => {
      await api(`/admin/providers/${provider}/models`, {
        method: "PUT",
        body: JSON.stringify({
          strong: tiers.strong || null,
          fast: tiers.fast || null,
          cheap: tiers.cheap || null,
        }),
      });
      setMsg({ kind: "ok", text: "Tier assignments saved." });
    });

  const synced = status.syncedAt != null;
  const noModels = status.availableModels.length === 0;

  return (
    <article style={providerPanel}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 10,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>{info.title}</h3>
        {/* Key status — the tone lives on the dot; the label stays --text-2 for AA. */}
        <span style={statusBadge}>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              flex: "none",
              borderRadius: "50%",
              background: status.isSet ? "var(--ok)" : "var(--text-3)",
            }}
          />
          {status.isSet ? `Key set ·••••${status.last4 ?? ""}` : "No key"}
        </span>
      </div>
      <p style={{ margin: "4px 0 12px", color: "var(--text-2)", fontSize: 12 }}>{info.role}</p>

      {msg ? <Banner kind={msg.kind} text={msg.text} style={{ marginBottom: 12 }} /> : null}

      <label htmlFor={`${provider}-key`} style={{ ...fieldEyebrow, marginBottom: 6 }}>
        API key {status.isSet ? "· enter a new value to rotate" : ""}
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id={`${provider}-key`}
          type="password"
          value={keyInput}
          autoComplete="off"
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
          aria-label={`${info.title} API key`}
          style={panelInput}
        />
        <button
          type="button"
          onClick={saveKey}
          disabled={busy !== null || keyInput.trim() === ""}
          className="cos-brighten"
          style={buttonStyle("primary", busy !== null || keyInput.trim() === "")}
        >
          {busy === "key" ? "Saving…" : "Save key"}
        </button>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          margin: "16px 0 8px",
        }}
      >
        <span style={fieldEyebrow}>
          Models {synced ? `· ${status.availableModels.length} available` : "· not synced"}
        </span>
        <button
          type="button"
          onClick={syncModels}
          disabled={busy !== null || !status.isSet}
          style={buttonStyle("ghost", busy !== null || !status.isSet)}
        >
          {busy === "sync" ? "Syncing…" : "Sync models"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {PROVIDER_TIERS[provider].map((tier) => (
          <div key={tier} style={tierRow}>
            <div>
              <div style={{ fontSize: 12.5, color: "var(--text)" }}>{TIER_INFO[tier].label}</div>
              <div style={{ ...mono, fontSize: 10, color: "var(--text-3)" }}>{tier}</div>
            </div>
            <select
              value={tiers[tier]}
              aria-label={`${info.title} ${TIER_INFO[tier].label} model`}
              title={TIER_INFO[tier].help}
              disabled={noModels}
              onChange={(e) => setTiers((t) => ({ ...t, [tier]: e.target.value }))}
              style={panelInput}
            >
              <option value="">— none —</option>
              {status.availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={saveTiers}
          disabled={busy !== null || noModels}
          className="cos-brighten"
          style={buttonStyle("primary", busy !== null || noModels)}
        >
          {busy === "tiers" ? "Saving…" : "Save tier assignments"}
        </button>
      </div>
    </article>
  );
}

// --- styles --------------------------------------------------------------------------------------

// Bottom padding so the last Save button isn't flush to the viewport on desktop (where .app-main has
// no bottom-nav clearance); mirrors the reference's 24/24/76 framing.
const page = { minHeight: "100vh", padding: "24px 24px 48px" } as const;

const container = {
  maxWidth: 880,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 22,
} as const;

// Outlined accent badge (the design's "Owner only" pill). --text-2 ink (AA on --bg in both themes,
// unlike the mockup's accent ink at 3.85:1 in light); accent identity carried by the border.
const ownerBadge = {
  ...mono,
  fontSize: 9.5,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  color: "var(--text-2)",
  border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--line))",
  borderRadius: 6,
  padding: "3px 8px",
} as const;

// "Preview · not enforced" pill — a warn-toned caution that the grid is not wired up (invariant 2).
const previewPill = {
  ...mono,
  fontSize: 9.5,
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  color: "var(--text-2)",
  border: "1px solid color-mix(in srgb, var(--warn) 45%, var(--line))",
  background: "color-mix(in srgb, var(--warn) 12%, transparent)",
  borderRadius: 6,
  padding: "3px 8px",
} as const;

const card = {
  border: "1px solid var(--line)",
  borderRadius: 14,
  background: "var(--panel)",
  overflow: "hidden",
} as const;

const cardHead = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "15px 18px",
  borderBottom: "1px solid var(--line)",
} as const;

// One reviewer cell. The grid (.cos-rvgrid) paints 1px line-coloured gaps between cells; the cell bg
// is --panel so the gaps read as hairline dividers. The agent rail is set inline per identity colour.
const reviewerCard = {
  background: "var(--panel)",
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 13,
} as const;

// The Strictness segmented's sole label → essential text (rubric §6), so --text-2 not eyebrow --text-3.
const controlLabel = {
  ...mono,
  fontSize: 10,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-2)",
} as const;

const providerPanel = {
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--panel-2)",
  padding: "15px 16px",
} as const;

const statusBadge = {
  ...mono,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 10.5,
  color: "var(--text-2)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "3px 8px",
  whiteSpace: "nowrap",
} as const;

// "API key" / "Models" — the sole label for the key input + model group → essential text (rubric §6),
// so --text-2 (AA on --panel-2), keeping the mono-uppercase eyebrow look without the sub-AA --text-3.
const fieldEyebrow = {
  display: "block",
  ...mono,
  fontSize: 10,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--text-2)",
} as const;

// Inputs/selects on the --panel-2 sub-panel drop to --bg so they read as inset (the design's pattern).
const panelInput = { ...inputStyle, flex: 1, minWidth: 0, background: "var(--bg)" } as const;

const tierRow = {
  display: "grid",
  gridTemplateColumns: "110px 1fr",
  gap: 10,
  alignItems: "center",
} as const;
