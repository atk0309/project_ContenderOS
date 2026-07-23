/**
 * Computed-contrast suite — parses `src/app/globals.css` and asserts the WCAG ratios the design
 * system claims (docs/architecture/design-system.md §Computed contrast), so a token edit that
 * breaks AA fails the gate instead of shipping. Scope:
 *
 *  - essential text ≥4.5:1 (`--text`/`--text-2` on `--bg`/`--panel`/`--panel-2`; `--ink-warn` on
 *    all three surfaces; `--on-accent`; the light `--ok` knife-edge) plus the `--ok` ✓ GLYPH ≥3:1
 *    on `--panel-2` (ok-as-TEXT is banned there — 4.17 light; the labels sit at `--text-2`),
 *  - the agent-badge glyph ink on all SEVEN identities (six `--rv-*` + `agent`-on-`--accent`),
 *  - the full Switch non-text matrix ≥3:1 (every checked-track colour in use × knob(+ring) ×
 *    the `--panel` host, plus the OFF track pairs — WCAG 1.4.11).
 *
 * The parser is deliberately small: top-level `:root` / `[data-theme]` blocks merged in file
 * order (matching the cascade — equal specificity, later wins), ONE level of `var()`
 * indirection, and `#rrggbb` + `oklch(L C H)` values via the OKLab matrices. It does NOT
 * composite alpha — which is why `--switch-knob-ring` must stay an opaque value, never a shadow.
 * Calibration asserts against known sRGB references (white/black 21:1, #767676-on-white 4.54),
 * never this pipeline's own output.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Rgb = readonly [number, number, number];
type Tokens = Record<string, string>;

// ---------- globals.css → per-theme token maps ----------

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Top-level `selector { body }` blocks; nested braces (keyframes/media) swallowed into the body. */
function topLevelBlocks(src: string): { selector: string; body: string }[] {
  const blocks: { selector: string; body: string }[] = [];
  let i = 0;
  for (;;) {
    const open = src.indexOf("{", i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") depth -= 1;
      j += 1;
    }
    blocks.push({ selector: src.slice(i, open).trim(), body: src.slice(open + 1, j - 1) });
    i = j;
  }
  return blocks;
}

function themeTokens(): { dark: Tokens; light: Tokens } {
  const dark: Tokens = {};
  const light: Tokens = {};
  for (const { selector, body } of topLevelBlocks(css)) {
    if (selector.startsWith("@")) continue; // media/keyframes — no token definitions
    const isBase = selector.includes(":root");
    const isDark = selector.includes('[data-theme="dark"]');
    const isLight = selector.includes('[data-theme="light"]');
    if (!isBase && !isDark && !isLight) continue;
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const name = m[1];
      const value = m[2];
      if (!name || !value) continue;
      if (isBase || isDark) dark[name] = value.trim();
      if (isBase || isLight) light[name] = value.trim();
    }
  }
  return { dark, light };
}

const THEMES = themeTokens();

/** One level of `var()` indirection (e.g. dark `--ink-warn: var(--warn)`), then parse. */
function resolve(tokens: Tokens, name: string, theme: string): Rgb {
  const raw = tokens[name];
  if (!raw) throw new Error(`token ${name} is not defined in the ${theme} theme`);
  const target = /^var\((--[\w-]+)\)$/.exec(raw)?.[1];
  const value = target ? tokens[target] : raw;
  if (!value) throw new Error(`token ${name} (${theme}) references undefined ${target}`);
  return parseColor(value, `${name} (${theme})`);
}

// ---------- colour math (sRGB + OKLab), 8-bit like the browser paints ----------

function parseColor(value: string, label: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (hex) {
    return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(value.trim());
  if (ok) return oklchToSrgb(Number(ok[1]), Number(ok[2]), Number(ok[3]));
  throw new Error(
    `${label}: unsupported colour value "${value}" (expected #rrggbb or oklch(L C H))`,
  );
}

/** oklch → sRGB via the OKLab matrices (Ottosson), gamma-encoded and rounded to 8-bit. */
function oklchToSrgb(L: number, C: number, Hdeg: number): Rgb {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  }) as unknown as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1–21. */
function contrast(c1: Rgb, c2: Rgb): number {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Loud, token-named assertion — the failure message carries the pair and the computed ratio. */
function expectRatio(label: string, ratio: number, floor: number): void {
  expect(
    ratio,
    `${label} computed ${ratio.toFixed(2)}:1 — must be ≥ ${floor}:1 (see design-system.md §Computed contrast)`,
  ).toBeGreaterThanOrEqual(floor);
}

// ---------- calibration: known sRGB references, never this pipeline's own output ----------

describe("calibration against known sRGB references", () => {
  const WHITE: Rgb = [255, 255, 255];
  it("white on black is exactly 21:1", () => {
    expect(contrast(WHITE, [0, 0, 0])).toBeCloseTo(21.0, 5);
  });
  it("#767676 on white is 4.54:1 (the canonical just-passes-AA gray)", () => {
    const r = contrast(parseColor("#767676", "ref"), WHITE);
    expect(r).toBeCloseTo(4.54, 2);
    expect(r).toBeGreaterThanOrEqual(4.5);
  });
  it("#777777 on white is 4.48:1 (the canonical just-FAILS-AA gray)", () => {
    const r = contrast(parseColor("#777777", "ref"), WHITE);
    expect(r).toBeCloseTo(4.48, 2);
    expect(r).toBeLessThan(4.5);
  });
  it("oklch endpoints hit sRGB black and white", () => {
    expect(oklchToSrgb(0, 0, 0)).toEqual([0, 0, 0]);
    expect(oklchToSrgb(1, 0, 0)).toEqual([255, 255, 255]);
  });
});

// ---------- the token assertions, per theme ----------

const AGENT_KEYS = ["parser", "tailor", "editor", "fact", "spotter", "gate"] as const;

for (const [theme, tokens] of Object.entries(THEMES)) {
  const t = (name: string): Rgb => resolve(tokens, name, theme);

  describe(`${theme}: essential text meets AA (≥4.5:1)`, () => {
    it("--text and --text-2 on --bg, --panel and --panel-2", () => {
      // --panel-2 hosts essential text too: the bulletBox editor rows / Gatekeeper fixRows carry
      // their ok-state labels at --text-2 (ok-as-text fails AA there in light — see the glyph
      // assertion below), so --text-2 must clear every one of the three chrome surfaces.
      for (const fg of ["--text", "--text-2"]) {
        for (const bg of ["--bg", "--panel", "--panel-2"]) {
          expectRatio(`${theme} ${fg} on ${bg}`, contrast(t(fg), t(bg)), 4.5);
        }
      }
    });
    it("--ink-warn on --bg, --panel and --panel-2 (the warn-text ink — raw light --warn fails)", () => {
      for (const bg of ["--bg", "--panel", "--panel-2"]) {
        expectRatio(`${theme} --ink-warn on ${bg}`, contrast(t("--ink-warn"), t(bg)), 4.5);
      }
    });
    it("--on-accent on --accent (primary buttons)", () => {
      expectRatio(
        `${theme} --on-accent on --accent`,
        contrast(t("--on-accent"), t("--accent")),
        4.5,
      );
    });
    it("--ok on --panel (light is a 4.51 knife-edge — nudging light --ok darker breaks AA)", () => {
      // Light --ok computes 4.51:1 on --panel: deliberately tracked here and in design-system.md,
      // so any retune of --ok or --panel that drops it under 4.5 fails loudly by name.
      expectRatio(`${theme} --ok on --panel`, contrast(t("--ok"), t("--panel")), 4.5);
    });
    it("--ok as the ✓ GLYPH on --panel-2 (≥3:1 non-text — ok-as-TEXT fails AA there in light)", () => {
      // On --panel-2 hosts (the editor bulletBox, the Gatekeeper fixRow) light --ok computes
      // 4.17:1 — under the 4.5 text floor — so applied/accepted state is text-carried at --text-2
      // with only the ✓ glyph in --ok (ReviewInlineBadge / GatekeeperView's appliedChip). The
      // glyph is a graphical object: WCAG 1.4.11's 3:1 floor applies.
      expectRatio(`${theme} --ok glyph on --panel-2`, contrast(t("--ok"), t("--panel-2")), 3);
    });
  });

  describe(`${theme}: agent-badge glyph ink on all seven identities (≥4.5:1)`, () => {
    it("six --rv-* badges use their --ink-<agent> override or the --agent-ink default", () => {
      for (const key of AGENT_KEYS) {
        // Mirrors colors.ts: `var(--ink-<agent>, var(--agent-ink))`.
        const ink = tokens[`--ink-${key}`] ? t(`--ink-${key}`) : t("--agent-ink");
        expectRatio(`${theme} badge ink on --rv-${key}`, contrast(ink, t(`--rv-${key}`)), 4.5);
      }
    });
    it("the neutral `agent` badge (glyph ink on --accent)", () => {
      const ink = tokens["--ink-agent"] ? t("--ink-agent") : t("--agent-ink");
      expectRatio(`${theme} badge ink on --accent (agent)`, contrast(ink, t("--accent")), 4.5);
    });
  });

  describe(`${theme}: Switch non-text matrix (≥3:1, WCAG 1.4.11; host --panel)`, () => {
    // Every checked-track colour actually passed to <Switch color=…>: the default --accent
    // (/design), --warn (the Admin "can block export" toggle) and the six identity colours
    // (the Admin grid's per-agent active toggles) — plus the OFF track.
    const trackTokens = [
      "--accent",
      "--warn",
      ...AGENT_KEYS.map((k) => `--rv-${k}`),
      "--switch-track-off",
    ];
    it("every track clears the --panel host", () => {
      for (const track of trackTokens) {
        expectRatio(`${theme} ${track} track vs --panel`, contrast(t(track), t("--panel")), 3);
      }
    });
    it("the knob (body or its opaque ring) clears every track", () => {
      const knob = t("--switch-knob");
      const ring = t("--switch-knob-ring");
      for (const track of trackTokens) {
        // The knob is discernible if EITHER its body or its opaque outline ring clears 3:1
        // against the track (dark: the ring carries — the white body fails every dark checked
        // track at 1.63–2.72; light: the body carries at ≥3.71).
        const best = Math.max(contrast(knob, t(track)), contrast(ring, t(track)));
        expectRatio(`${theme} knob+ring vs ${track} track`, best, 3);
      }
    });
  });
}
