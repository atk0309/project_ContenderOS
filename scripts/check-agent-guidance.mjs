#!/usr/bin/env node
/**
 * Validate the repository's agent-guidance + docs contract (META checks).
 *
 * Node stdlib only — runs in an early-stage repo before any deps are installed. Sibling of
 * check-doc-impact.mjs: this validates that the required files exist, CLAUDE imports AGENTS,
 * links resolve, every guidance file is within budget, the AGENTS.md §14 table stays 1:1 with
 * the doc-impact lint's RULES, and (warn-only) that the pre-push hook is active; that one
 * validates a code/doc pair moved together. Exit 0 on success, 1 on any failure.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RULES } from './check-doc-impact.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LINES = 220; // soft cap (warn), per guidance file
const MAX_BYTES = 32 * 1024; // hard cap (fail) — Codex truncates above 32 KiB

// Every guidance file an agent loads gets the budget — the truncation rationale applies to the
// nested AGENTS.md files (Codex loads them for subtree work) exactly as it does to the root one.
const GUIDANCE_FILES = ['AGENTS.md', 'CLAUDE.md', 'backend/AGENTS.md', 'frontend/AGENTS.md'];

const REQUIRED_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'backend/AGENTS.md',
  'frontend/AGENTS.md',
  'backend/.env.example',
  'frontend/.env.example',
  'docs/index.html',
  'docs/README.md',
  'docs/invariants.md',
  'docs/ai-panel.md',
  'docs/agent-guidance-changelog.md',
  'docs/testing/strategy.md',
  'scripts/quality-gate.mjs',
  'scripts/check-doc-impact.mjs',
  'scripts/check-invariants.mjs',
  // The gate's scripts:selftest step is a glob (`node --test scripts/*.test.mjs`) that exits 0
  // when nothing matches — requiring the suites here means they can't silently vanish.
  'scripts/check-doc-impact.test.mjs',
  'scripts/check-agent-guidance.test.mjs',
  'scripts/check-invariants.test.mjs',
];

/**
 * Extract the rule ids from the AGENTS.md §14 table (exported for the self-tests).
 *
 * Scope: only the lines between the `## 14.` heading and the next `##` heading — AGENTS.md has a
 * second table (§5, backticked commands in its last cells) that must not be parsed. Within scope:
 * table rows only (`| … |`), skipping the header row and `---` separator row; the rule id is the
 * LAST cell, backticks stripped, kept only if it looks like a rule id (`^[a-z0-9-]+$` — this also
 * drops the header's "Rule id" cell; the separator row is skipped explicitly because `---` would
 * otherwise pass that filter). Prose mentions of rule ids are not table rows and never match.
 */
export function ruleIdsFromSection14(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## 14\./.test(l));
  if (start < 0) return [];
  const ids = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break; // next section
    const line = lines[i];
    if (!/^\s*\|.*\|\s*$/.test(line)) continue; // not a table row
    const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // separator row
    const last = (cells[cells.length - 1] || '').replace(/`/g, '').trim();
    if (/^[a-z0-9-]+$/.test(last)) ids.push(last);
  }
  return ids;
}

function main() {
  let failed = false;
  const fail = (m) => {
    console.error(`ERROR: ${m}`);
    failed = true;
  };
  const warn = (m) => console.error(`WARN:  ${m}`);

  // 1. Required files exist
  for (const f of REQUIRED_FILES) {
    if (!existsSync(join(ROOT, f))) fail(`missing required file: ${f}`);
  }

  // 2. CLAUDE.md must import AGENTS.md
  if (existsSync(join(ROOT, 'CLAUDE.md'))) {
    const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    if (!claude.includes('@AGENTS.md')) {
      fail("CLAUDE.md must contain '@AGENTS.md' so Claude Code loads canonical guidance.");
    }
  }

  // 3. Size budget — every guidance file
  for (const f of GUIDANCE_FILES) {
    const path = join(ROOT, f);
    if (!existsSync(path)) continue; // reported by the required-files check
    const buf = readFileSync(path);
    const lines = buf.toString('utf8').split('\n').length;
    if (buf.byteLength > MAX_BYTES) {
      fail(`${f} is ${buf.byteLength} bytes (> ${MAX_BYTES}). Move detail to /docs.`);
    }
    if (lines > MAX_LINES) {
      warn(`${f} is ${lines} lines (> ${MAX_LINES} soft cap). Consider trimming to /docs.`);
    }
  }

  // 4. Link integrity for the two doc indexes (relative links must resolve)
  const LINK_RE = {
    md: /\]\(([^)#]+)(?:#[^)]*)?\)/g,
    html: /href="([^"#]+)(?:#[^"]*)?"/g,
  };
  function checkLinks(file, kind) {
    const path = join(ROOT, file);
    if (!existsSync(path)) return;
    const text = readFileSync(path, 'utf8');
    const re = LINK_RE[kind];
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const resolved = resolve(dirname(path), target);
      if (!existsSync(resolved)) {
        fail(`${file} links to missing target: ${target} (resolved ${relative(ROOT, resolved)})`);
      }
    }
  }
  checkLinks('docs/README.md', 'md');
  checkLinks('docs/index.html', 'html');

  // 5. AGENTS.md §14 table ↔ check-doc-impact RULES stay 1:1 (the §15 promise, mechanised)
  if (existsSync(join(ROOT, 'AGENTS.md'))) {
    const tableIds = ruleIdsFromSection14(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'));
    const ruleIds = RULES.map((r) => r.id);
    const missingInTable = ruleIds.filter((id) => !tableIds.includes(id));
    const missingInLint = tableIds.filter((id) => !ruleIds.includes(id));
    if (tableIds.length === 0) {
      fail('AGENTS.md §14 table not found (or empty) — cannot verify 1:1 with check-doc-impact RULES.');
    }
    if (missingInTable.length) {
      fail(`doc-impact rules missing from the AGENTS.md §14 table: ${missingInTable.join(', ')}`);
    }
    if (missingInLint.length) {
      fail(`AGENTS.md §14 rows with no check-doc-impact rule: ${missingInLint.join(', ')}`);
    }
    const dupes = tableIds.filter((id, i) => tableIds.indexOf(id) !== i);
    if (dupes.length) fail(`duplicate rule ids in the AGENTS.md §14 table: ${[...new Set(dupes)].join(', ')}`);
  }

  // 6. Pre-push hook active (warn-only; skipped in CI — a fresh CI checkout has no local git
  // config, and the hook layer is a local-workflow concern, not a CI one).
  if (!process.env.CI) {
    let hooksPath = '';
    try {
      hooksPath = execSync('git config core.hooksPath', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: ROOT,
      }).trim();
    } catch {
      /* unset or not a repo */
    }
    if (hooksPath !== 'scripts/hooks') {
      warn('pre-push hook not active (core.hooksPath != scripts/hooks) — run `node scripts/install-hooks.mjs` once.');
    }
  }

  if (failed) {
    console.error('\ncheck-agent-guidance: FAIL');
    process.exit(1);
  }
  console.log('check-agent-guidance: OK');
}

// Import-safe: the self-tests import ruleIdsFromSection14 without running the checks.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
