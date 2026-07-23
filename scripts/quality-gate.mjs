#!/usr/bin/env node
/**
 * The local quality gate — the single command before declaring work complete.
 * GitHub Actions are NOT this gate; they are a pre-merge safety net + deployment mechanics.
 *
 * Runs, in order:
 *   1. check-agent-guidance.mjs   (meta: required files, @AGENTS.md import, links, size caps,
 *                                  §14↔RULES 1:1, hook-installed warn)
 *      check-invariants.mjs       (executable guards for invariants 2/3/4/5/6/8 + design
 *                                  fidelity; 1 & 7 are deliberately not machine-guarded)
 *      node --test scripts/*.test.mjs   (self-tests for the harness scripts themselves)
 *   2. check-doc-impact.mjs       (diff vs the Doc-impact checklist, in --worktree mode so
 *                                  uncommitted + untracked work is seen; unmet rules are a GAP)
 *   3. backend gate               (ruff -> mypy -> pytest, in backend/)
 *   4. schema sync                (regen OpenAPI + TS types, fail if the committed artifacts drift)
 *   5. frontend gate              (biome lint -> tsc -> vitest, in frontend/)
 *
 * A check whose tool is missing (deps not installed) is reported as a GAP, not a pass.
 * Flags: --fail-on-gap (gaps fail the run, and the doc-impact lint runs in --fail-on-gap mode).
 * Exit codes: 0 all pass · 1 any FAIL (or any GAP under --fail-on-gap) · 2 gaps in warn mode —
 * a scripted consumer can no longer mistake a gapped run for a green one.
 */
import { spawnSync } from 'node:child_process';

const failOnGap = process.argv.includes('--fail-on-gap');
const results = []; // { name, state: 'pass'|'fail'|'gap', detail }

function run(name, cmd, argv, { cwd = '.', gapOnMissing = false, gapOnExit2 = false } = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
  if (r.error && r.error.code === 'ENOENT') {
    results.push({ name, state: gapOnMissing ? 'gap' : 'fail', detail: `${cmd} not found` });
    return false;
  }
  // gapOnExit2 is per-invocation and scoped to the doc-impact lint only: its exit 2 means "unmet
  // rules in warn mode" (a gap, not a crash). Other tools (mypy/pytest/ruff) exit 2 on real
  // failures and must stay FAIL.
  const state = r.status === 0 ? 'pass' : gapOnExit2 && r.status === 2 ? 'gap' : 'fail';
  results.push({ name, state, detail: state === 'pass' ? '' : `exit ${r.status}` });
  return state === 'pass';
}

console.log('\n=== 1. agent-guidance + invariant guards + scripts self-tests (meta) ===');
run('guidance', 'node', ['scripts/check-agent-guidance.mjs']);
run('invariants', 'node', ['scripts/check-invariants.mjs']);
// The glob is expanded by node's own test runner (not the shell) — spawnSync passes it through.
run('scripts:selftest', 'node', ['--test', 'scripts/*.test.mjs']);

console.log('\n=== 2. doc-impact lint (worktree mode) ===');
run(
  'doc-impact',
  'node',
  ['scripts/check-doc-impact.mjs', '--worktree', ...(failOnGap ? ['--fail-on-gap'] : [])],
  { gapOnExit2: true },
);

console.log('\n=== 3. backend gate (ruff -> mypy -> pytest) ===');
run('backend:lint', 'uv', ['run', 'ruff', 'check', '.'], { cwd: 'backend', gapOnMissing: true });
run('backend:format', 'uv', ['run', 'ruff', 'format', '--check', '.'], { cwd: 'backend', gapOnMissing: true });
run('backend:types', 'uv', ['run', 'mypy'], { cwd: 'backend', gapOnMissing: true });
run('backend:test', 'uv', ['run', 'pytest'], { cwd: 'backend', gapOnMissing: true });

console.log('\n=== 4. schema sync (Pydantic -> OpenAPI -> TS, no-drift) ===');
const exported = run('schema:export', 'uv', ['run', 'python', '-m', 'app.export_openapi'], {
  cwd: 'backend',
  gapOnMissing: true,
});
const gened = run('schema:gen-types', 'pnpm', ['gen:types'], { cwd: 'frontend', gapOnMissing: true });
if (exported && gened) {
  run('schema:no-drift', 'git', [
    'diff',
    '--exit-code',
    '--',
    'frontend/openapi.json',
    'frontend/src/lib/api/generated-types.ts',
  ]);
} else {
  results.push({ name: 'schema:no-drift', state: 'gap', detail: 'regen step missing' });
}

console.log('\n=== 5. frontend gate (biome -> tsc -> vitest) ===');
run('frontend:lint', 'pnpm', ['lint'], { cwd: 'frontend', gapOnMissing: true });
run('frontend:types', 'pnpm', ['typecheck'], { cwd: 'frontend', gapOnMissing: true });
run('frontend:test', 'pnpm', ['test'], { cwd: 'frontend', gapOnMissing: true });

// ----- summary -----
console.log('\n=== quality gate summary ===');
for (const r of results) {
  const mark = r.state === 'pass' ? 'PASS' : r.state === 'gap' ? 'GAP ' : 'FAIL';
  console.log(`  ${mark}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
}
const gaps = results.filter((r) => r.state === 'gap');
if (gaps.length) {
  console.log(`\n${gaps.length} gap(s): a skipped check is NOT a pass. Install deps and re-run, or report the gap.`);
}
const hardFail = results.some((r) => r.state === 'fail') || (failOnGap && gaps.length > 0);
process.exit(hardFail ? 1 : gaps.length ? 2 : 0);
