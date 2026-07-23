#!/usr/bin/env node
/**
 * Executable guards for the load-bearing invariants (`docs/invariants.md`).
 *
 * The doc-impact lint keeps *docs* fresh; this keeps the *invariants themselves* true. Sibling of
 * check-agent-guidance.mjs: Node stdlib only, so it runs before any deps install and gates in CI.
 * Static scans only — cheap, deterministic, no false-positive-prone parsing. Each finding names the
 * invariant it protects. Exit 0 on success, 1 on any violation.
 *
 * Guards (invariants 1 and 7 are DELIBERATELY not machine-guarded — "no model emits a finished
 * document" and "threads anchor to stable ids" have no cheap static signature; grep proxies for
 * them would be pure noise):
 *   - Invariant 2 (provenance + sign-off gate): the route declaring the `/export` path calls
 *     `needs_signoff()` within its own handler, and a route-level export-409 test exists.
 *   - Invariant 3 (render is deterministic): no clock/RNG/locale source in the render path —
 *     `frontend/src/render/`, the `/print` SSR page, and the render API routes — `Date.now()`,
 *     `Math.random()`, bare `new Date()`, `toLocale*`, `Intl.`, `crypto.randomUUID`,
 *     `performance.now`. (Parsing a supplied date string, `new Date(iso)`, is deterministic and
 *     allowed.) And the CV "paper" tokens (`render/template-tokens.ts`) take no chrome `var(--…)`
 *     (DOCX/text can't read CSS vars), except `var(--font-*)`.
 *   - Invariant 4 (API keys are server-side only): no provider-key identifier or key-shaped
 *     literal under `frontend/src/` or in `frontend/next.config.ts` (the one file that can
 *     forward server env into the client bundle).
 *   - Invariant 5 (structured outputs): no raw completion call-sites under `backend/app/`; the
 *     `.parse(` helpers remain present in both provider wrappers.
 *   - Invariant 6 (provider split): every `provider=Provider.<x>` literal in
 *     `backend/app/ai/agents/*.py` matches the canonical agent→provider map.
 *   - Invariant 8 (tenant isolation): every route whose path template contains `{workspace_id}`
 *     references a `require_workspace_*` dependency; `backend/tests/test_tenancy.py` exists
 *     non-empty.
 *   - Design fidelity (ADR 0011 / `design-system.md`): app chrome consumes design TOKENS, not
 *     colour literals — no `#hex` / `rgb()` / `hsl()` / `oklch()` in
 *     `frontend/src/{app,ui,lib,slop}` (allowlist: neutral black shadows `rgba(0,0,0,…)`;
 *     the exact `/print` route is render-path, excluded).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Exported pieces (unit-tested by scripts/check-invariants.test.mjs)
// ---------------------------------------------------------------------------------------------

// Invariant 4 — key-shaped literals. Modern provider keys (`sk-ant-…`, `sk-proj-…`, `sk-live-…`)
// carry `-`/`_` in their tails, so the class includes them — a REAL Anthropic key
// (`sk-ant-api03-…`, hyphen after 5 alnums) would slip a `[A-Za-z0-9]{8,}`-only tail. The legacy
// bare `sk-<20+ alnum>` shape (old-format OpenAI keys) is guarded separately and is mandatory.
// The admin UI's `sk-ant-…` placeholder (an ellipsis, no tail) matches neither.
export const KEY_LITERAL_PATTERNS = [
  /sk-(ant|proj|live)-[A-Za-z0-9_-]{8,}/,
  /sk-[A-Za-z0-9]{20,}/,
];

// Invariant 6 — the canonical agent-module → provider map (authoring → anthropic, adjudication →
// openai; docs/ai-panel.md). Modules with NO provider literal (ingest, review, registry, types)
// wire dynamically and are deliberately absent; a module that declares a literal but is missing
// from this map is a violation — extend the map consciously, alongside docs/ai-panel.md.
export const AGENT_PROVIDER_MAP = {
  corrector: 'anthropic',
  editor: 'openai',
  extractor: 'anthropic',
  fact_checker: 'openai',
  gatekeeper: 'openai',
  judge: 'openai',
  parser: 'anthropic',
  reconciler: 'anthropic',
  spotter: 'anthropic',
  tailor: 'anthropic',
};

/** Invariant 6 — check one agent module's text against the map. Returns violation strings. */
export function providerViolations(moduleName, text) {
  const found = [...text.matchAll(/provider\s*=\s*Provider\.(anthropic|openai)/g)].map((m) => m[1]);
  const expected = AGENT_PROVIDER_MAP[moduleName];
  if (!expected) {
    return found.length
      ? [`module '${moduleName}' declares provider literal(s) but is not in AGENT_PROVIDER_MAP — add it deliberately (docs/ai-panel.md)`]
      : [];
  }
  if (found.length === 0) {
    return [`module '${moduleName}' is mapped to '${expected}' but declares no provider literal — wiring drifted?`];
  }
  return found
    .filter((p) => p !== expected)
    .map((p) => `module '${moduleName}' declares Provider.${p}, expected Provider.${expected}`);
}

/**
 * Route parser shared by the invariant-8 and invariant-2 guards — paren-balanced (NOT a line
 * window: real decorators span 10+ lines and nest brackets in `responses={…}`). For each
 * `@router.<method>(` anchor: `decorator` = the decorator stack, `span` = decorator + the
 * following `def`'s signature, `body` = the handler body (until the next top-level statement).
 * All three are COMMENT-STRIPPED (string-aware), so a `# TODO Depends(require_workspace_owner)`
 * comment can never satisfy a guard. Returns [{line, decorator, span, body}] (line is 1-based).
 */
export function parseRoutes(text) {
  const lines = text.split('\n');
  const routes = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*@router\.(get|post|put|delete|patch|head|options)\s*\(/.test(lines[i])) {
      i++;
      continue;
    }
    const startLine = i;
    const spanLines = [];
    const decoratorLines = [];
    // 1. consume this decorator (and any stacked ones), bracket-balanced
    while (i < lines.length && /^\s*@/.test(lines[i])) {
      const consumed = consumeBalanced(lines, i);
      for (let k = i; k <= consumed; k++) {
        spanLines.push(stripComment(lines[k]));
        decoratorLines.push(stripComment(lines[k]));
      }
      i = consumed + 1;
      while (i < lines.length && /^\s*(#.*)?$/.test(lines[i])) i++; // blanks/comments between
    }
    // 2. consume the def signature (async def …(…) -> X:)
    if (i < lines.length && /^\s*(async\s+)?def\s+\w+\s*\(/.test(lines[i])) {
      const consumed = consumeBalanced(lines, i);
      for (let k = i; k <= consumed; k++) spanLines.push(stripComment(lines[k]));
      i = consumed + 1;
    }
    // 3. the handler body: everything until the next top-level (column-0) statement
    const bodyLines = [];
    while (i < lines.length && !/^\S/.test(lines[i])) {
      bodyLines.push(stripComment(lines[i]));
      i++;
    }
    routes.push({
      line: startLine + 1,
      decorator: decoratorLines.join('\n'),
      span: spanLines.join('\n'),
      body: bodyLines.join('\n'),
    });
  }
  return routes;
}

const STRING_LITERAL = /(["'])((?:\\.|(?!\1).)*?)\1/g;
const TRIPLE_STRING = /("""|''')[\s\S]*?\1/g;
const stringLiteralsIn = (s) => [...s.matchAll(STRING_LITERAL)].map((m) => m[2]);
/** Blank out string-literal CONTENTS (triple-quoted blocks first — docstrings span lines — then
 * single-line pairs) so a predicate regex only ever matches CODE: a decorator
 * `summary="require_workspace_owner"`, a message string, or a docstring mentioning
 * `needs_signoff()` must never satisfy a guard. (Path detection uses the unmasked literals.) */
export const maskStrings = (s) => s.replace(TRIPLE_STRING, '$1$1').replace(STRING_LITERAL, '$1$1');
/** Comment- and string-content-free view of a whole Python file, for presence-of-CODE checks. */
export const codeOnly = (text) => maskStrings(text.split('\n').map(stripComment).join('\n'));

/** Invariant 8 — only STRING LITERALS inside the DECORATOR count as path templates
 * (`{workspace_id}` also appears in module docstrings, which sit outside every span); a
 * workspace-scoped route must reference `require_workspace_` in its span's CODE (decorator
 * `dependencies=[…]` or a signature default — never inside a string). Returns [{line}]. */
export function workspaceRouteViolations(text) {
  return parseRoutes(text)
    .filter(
      (r) =>
        stringLiteralsIn(r.decorator).some((s) => s.includes('{workspace_id}')) &&
        !/require_workspace_/.test(maskStrings(r.span)),
    )
    .map((r) => ({ line: r.line }));
}

/** Invariant 2 — the route whose PATH LITERAL contains `/export` must call `needs_signoff()`
 * in its own decorator/signature/body CODE — an unrelated call elsewhere in the file (e.g. a
 * dashboard projection) or a string mentioning it must not satisfy the gate. Returns [{line}]. */
export function exportGateViolations(text) {
  return parseRoutes(text)
    .filter(
      (r) =>
        stringLiteralsIn(r.decorator).some((s) => s.includes('/export')) &&
        !/needs_signoff\(\)/.test(maskStrings(`${r.span}\n${r.body}`)),
    )
    .map((r) => ({ line: r.line }));
}

/** Cut a `#` comment (string-aware) off one line. Strings never span lines in these files. */
function stripComment(line) {
  let inStr = null;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (inStr) {
      if (ch === '\\') k++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '#') return line.slice(0, k);
  }
  return line;
}

/** From `start`, consume lines until the bracket depth opened on the start line returns to zero
 * (string-aware; `#` comments outside strings are inert). Returns the last consumed index. */
function consumeBalanced(lines, start) {
  let depth = 0;
  let opened = false;
  let inStr = null;
  for (let j = start; j < lines.length; j++) {
    const line = lines[j];
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inStr) {
        if (ch === '\\') k++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '#') break; // comment — rest of line is inert
      else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
        opened = true;
      } else if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
    if (inStr) inStr = null; // simple strings don't span lines in these files
    if (opened && depth <= 0) return j;
  }
  return lines.length - 1;
}

// ---------------------------------------------------------------------------------------------
// Scan plumbing + CLI
// ---------------------------------------------------------------------------------------------

/** Recursively collect files under `dir` whose name matches `exts`, skipping `excludeRe`. */
function walk(dir, exts, excludeRe) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, exts, excludeRe));
    } else if (exts.some((e) => entry.endsWith(e)) && !(excludeRe && excludeRe.test(entry))) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const violations = [];
  const add = (invariant, file, line, snippet) =>
    violations.push({ invariant, where: `${relative(ROOT, file)}:${line}`, snippet: snippet.trim() });

  function scan(files, patterns) {
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        for (const { re, invariant } of patterns) {
          if (re.test(text)) add(invariant, file, i + 1, text);
        }
      });
    }
  }

  // Invariant 4 — no provider key anywhere in the client bundle source, nor in next.config.ts.
  const inv4Files = [
    ...walk(join(ROOT, 'frontend/src'), ['.ts', '.tsx'], null),
    ...(existsSync(join(ROOT, 'frontend/next.config.ts')) ? [join(ROOT, 'frontend/next.config.ts')] : []),
  ];
  scan(inv4Files, [
    { re: /(ANTHROPIC|OPENAI)_API_KEY/, invariant: '4 (API keys server-side only)' },
    { re: /process\.env\.[A-Z0-9_]*(API_KEY|SECRET)/, invariant: '4 (API keys server-side only)' },
    ...KEY_LITERAL_PATTERNS.map((re) => ({ re, invariant: '4 (key-shaped literal in client source)' })),
  ]);

  // Invariant 3 — the WHOLE render path stays deterministic: the shared template, the /print SSR
  // page, and the render API routes (tests may use real time/RNG, so exclude them).
  const renderPath = [
    ...walk(join(ROOT, 'frontend/src/render'), ['.ts', '.tsx'], /\.test\.tsx?$/),
    ...walk(join(ROOT, 'frontend/src/app/print'), ['.ts', '.tsx'], /\.test\.tsx?$/),
    ...walk(join(ROOT, 'frontend/src/app/api/render'), ['.ts', '.tsx'], /\.test\.tsx?$/),
  ];
  scan(renderPath, [
    { re: /Date\.now\(/, invariant: '3 (deterministic render)' },
    { re: /Math\.random\(/, invariant: '3 (deterministic render)' },
    { re: /new Date\(\s*\)/, invariant: '3 (deterministic render)' },
    { re: /\.toLocale\w*\(/, invariant: '3 (deterministic render — locale-dependent output)' },
    { re: /\bIntl\./, invariant: '3 (deterministic render — locale-dependent output)' },
    { re: /crypto\.randomUUID\(/, invariant: '3 (deterministic render)' },
    { re: /performance\.now\(/, invariant: '3 (deterministic render)' },
  ]);

  // Design fidelity (ADR 0011 / design-system.md) — app chrome consumes design TOKENS, not colour
  // literals, so dark/light + the agent palette stay one source. The CV "paper" + the chrome-free
  // /print surface are render path: they keep concrete colours and are excluded — the EXACT
  // /print route only, not any path segment that happens to be named "print".
  // Match EACH colour literal: a hex, or a colour-function call with its args (so the allowlist
  // tests the actual value, e.g. a neutral-black shadow). Global → every literal on a line is
  // checked individually, so an allowed literal can't shield an offending one beside it.
  const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([^)]*\)/g;
  const COLOR_ALLOW = [
    /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/i, // neutral black shadow / scrim
  ];
  // The Microsoft brand-logo squares are a fixed brand asset — allowed ONLY in the MicrosoftLogo
  // file, so brand colours can't leak into general chrome.
  const MS_BRAND = /^#(?:f25022|7fba00|00a4ef|ffb900)$/i;
  const printRoot = join(ROOT, 'frontend/src/app/print') + sep;
  const chromeFiles = [
    ...walk(join(ROOT, 'frontend/src/app'), ['.ts', '.tsx'], /\.test\.tsx?$/),
    ...walk(join(ROOT, 'frontend/src/ui'), ['.ts', '.tsx'], /\.test\.tsx?$/),
    ...walk(join(ROOT, 'frontend/src/lib'), ['.ts', '.tsx'], /\.test\.tsx?$/),
    ...walk(join(ROOT, 'frontend/src/slop'), ['.ts', '.tsx'], /\.test\.tsx?$/),
  ].filter((f) => !f.startsWith(printRoot)); // exact /print route = deterministic render surface
  for (const file of chromeFiles) {
    const allow = file.endsWith(`${sep}MicrosoftLogo.tsx`) ? [...COLOR_ALLOW, MS_BRAND] : COLOR_ALLOW;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        for (const m of text.matchAll(COLOR_LITERAL)) {
          if (!allow.some((re) => re.test(m[0]))) {
            add('design fidelity (tokens-only chrome — design-system.md)', file, i + 1, text);
          }
        }
      });
  }

  // Invariant 3 (cont.) — the CV "paper" tokens are self-contained: no chrome colour var() leaks
  // in (DOCX/text can't read CSS vars). `var(--font-*)` is the one allowed var (bundled fonts).
  const tokensFile = join(ROOT, 'frontend/src/render/template-tokens.ts');
  if (existsSync(tokensFile)) {
    readFileSync(tokensFile, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (/var\(--(?!font-)[a-z0-9-]+\)/i.test(text)) {
          add('3 (paper tokens self-contained — no chrome var())', tokensFile, i + 1, text);
        }
      });
  }

  // Invariant 2 — the export gate: the route declaring the /export path must call
  // needs_signoff() within its own span/body (an unrelated call elsewhere in the file does not
  // count), and a route-level export-409 test must exist (protects against the refactor that
  // moves the gate call and deletes the "redundant" 409 test).
  const routeFiles = walk(join(ROOT, 'backend/app/routes'), ['.py'], null);
  let exportRoutes = 0;
  for (const f of routeFiles) {
    const text = readFileSync(f, 'utf8');
    const routes = parseRoutes(text);
    exportRoutes += routes.filter((r) =>
      [...r.decorator.matchAll(/(["'])((?:\\.|(?!\1).)*?)\1/g)].some((m) => m[2].includes('/export')),
    ).length;
    for (const v of exportGateViolations(text)) {
      add('2 (provenance gate — export route must call needs_signoff() in its own handler)', f, v.line, '@router /export route without the gate');
    }
  }
  if (exportRoutes === 0) {
    add('2 (provenance gate — export route missing)', join(ROOT, 'backend/app/routes'), 0, 'no route declares an /export path');
  }
  const backendTestFiles = walk(join(ROOT, 'backend/tests'), ['.py'], null);
  const hasExport409Test = backendTestFiles.some((f) => {
    const t = readFileSync(f, 'utf8');
    return t.includes('/export') && t.includes('409');
  });
  if (!hasExport409Test) {
    add('2 (provenance gate — export-409 test missing)', join(ROOT, 'backend/tests'), 0, 'no test exercises /export blocking with 409');
  }

  // Invariant 5 — structured outputs only: no raw completion call-sites anywhere under
  // backend/app; the structured .parse( helpers stay present in both provider wrappers.
  scan(walk(join(ROOT, 'backend/app'), ['.py'], null), [
    { re: /\.(messages|responses|completions)\.create\(/, invariant: '5 (structured outputs — raw completion call-site)' },
  ]);
  // The marker must exist as CODE — both wrappers' module docstrings mention `.parse(` in
  // prose, so the check runs on a comment- and string-stripped view of the file.
  for (const [wrapper, marker] of [
    ['backend/app/ai/providers/anthropic.py', 'messages.parse('],
    ['backend/app/ai/providers/openai.py', 'responses.parse('],
  ]) {
    const p = join(ROOT, wrapper);
    if (existsSync(p) && !codeOnly(readFileSync(p, 'utf8')).includes(marker)) {
      add('5 (structured outputs — wrapper lost its .parse( call)', p, 0, `expected executable ${marker}`);
    }
  }

  // Invariant 6 — agent→provider wiring matches the canonical map (per literal, module-keyed).
  for (const f of walk(join(ROOT, 'backend/app/ai/agents'), ['.py'], null)) {
    for (const msg of providerViolations(basename(f, '.py'), readFileSync(f, 'utf8'))) {
      add('6 (provider split — docs/ai-panel.md)', f, 0, msg);
    }
  }

  // Invariant 8 — workspace-scoped routes carry a require_workspace_* dependency; the
  // cross-tenant deny suite exists.
  for (const f of routeFiles) {
    for (const v of workspaceRouteViolations(readFileSync(f, 'utf8'))) {
      add('8 (tenant isolation — workspace route without require_workspace_*)', f, v.line, '@router route with {workspace_id}');
    }
  }
  const tenancyTests = join(ROOT, 'backend/tests/test_tenancy.py');
  if (!existsSync(tenancyTests) || readFileSync(tenancyTests, 'utf8').trim().length === 0) {
    add('8 (tenant isolation — test_tenancy.py missing/empty)', tenancyTests, 0, 'cross-tenant deny tests must exist');
  }

  if (violations.length === 0) {
    console.log('check-invariants: OK');
    process.exit(0);
  }
  console.error('check-invariants: FAIL — invariant violation(s):');
  for (const v of violations) {
    console.error(`  invariant ${v.invariant}\n    ${v.where}  ${v.snippet}`);
  }
  console.error('\nThese invariants are load-bearing (docs/invariants.md). Move the offending code server-side / out of the render path.');
  process.exit(1);
}

// Import-safe: the self-tests import the exported pieces without running the scans.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
