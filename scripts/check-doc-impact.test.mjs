/**
 * Self-tests for check-doc-impact.mjs — the gate that guards everything must itself be guarded.
 *
 * Two layers:
 *  - pure unit tests over the exported helpers (dependency buckets, ack regex, trigger regexes);
 *  - end-to-end fixtures: scratch git repos (an "origin" + a clone, so origin/main resolves) with
 *    the lint run as a subprocess, pinning the mode/exit-code/ack-scoping semantics:
 *      uncommitted trigger → exit 2 (gate maps to GAP) · committed unmet → --fail-on-gap exit 1 ·
 *      ack on its lighting commit → pass · clean tree with a committed ack → pass (--worktree) ·
 *      on-main fallback → WARN + exit 0 even under --fail-on-gap · dirty lighting voids acks ·
 *      merge-commit acks never count · --head isolates the linted tip · deleted docs never
 *      satisfy · renames land as D+A (a file renamed into a trigger dir lights its rule).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RULES,
  bucketsDiffer,
  hasValidAck,
  parseNameStatus,
  pkgJsonBuckets,
  pyprojectBuckets,
  ruleLit,
} from './check-doc-impact.mjs';

const SCRIPT = fileURLToPath(new URL('./check-doc-impact.mjs', import.meta.url));
const rule = (id) => RULES.find((r) => r.id === id);

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

test('parseNameStatus: statuses + tab-in-path safety', () => {
  const parsed = parseNameStatus('A\tdocs/new.md\nM\tbackend/app/x.py\nD\tgone.md\nT\tlinkish');
  assert.deepEqual(parsed, [
    { status: 'A', path: 'docs/new.md' },
    { status: 'M', path: 'backend/app/x.py' },
    { status: 'D', path: 'gone.md' },
    { status: 'T', path: 'linkish' },
  ]);
});

test('hasValidAck: requires a trailer-style line AND a non-empty reason', () => {
  assert.ok(hasValidAck('feat: x\n\nDocs-Impact-Ack: tenancy-change relocation only', 'tenancy-change'));
  assert.ok(!hasValidAck('feat: x\n\nDocs-Impact-Ack: tenancy-change', 'tenancy-change'), 'bare id, no reason');
  assert.ok(!hasValidAck('feat: x\n\nDocs-Impact-Ack: tenancy-change\n', 'tenancy-change'), 'trailing newline, no reason');
  assert.ok(!hasValidAck('remember Docs-Impact-Ack: tenancy-change reason', 'tenancy-change'), 'mid-line prose mention');
  assert.ok(!hasValidAck('Docs-Impact-Ack: schema-change reason', 'tenancy-change'), 'different rule id');
});

test('trigger regexes match the §14 prose, not a narrower subset', () => {
  const entries = (paths, status = 'M') => paths.map((p) => ({ status, path: p }));
  // env-vars-changed: any */.env.example
  assert.ok(ruleLit(rule('env-vars-changed'), entries(['backend/.env.example'])));
  assert.ok(ruleLit(rule('env-vars-changed'), entries(['services/worker/.env.example'])));
  assert.ok(!ruleLit(rule('env-vars-changed'), entries(['backend/.env.example.bak'])));
  // new-test-suite: frontend *.test.ts(x) anywhere under frontend/, backend tests/test_*.py
  assert.ok(ruleLit(rule('new-test-suite'), entries(['frontend/e2e/smoke.test.ts'], 'A')));
  assert.ok(ruleLit(rule('new-test-suite'), entries(['frontend/src/app/x.test.tsx'], 'A')));
  assert.ok(ruleLit(rule('new-test-suite'), entries(['backend/tests/test_concurrency.py'], 'A')));
  assert.ok(!ruleLit(rule('new-test-suite'), entries(['frontend/src/app/x.test.tsx'], 'M')), 'added-only rule');
  // guidance-self-update: all of scripts/**, not just *.mjs + hooks/
  assert.ok(ruleLit(rule('guidance-self-update'), entries(['scripts/some-helper.sh'])));
  assert.ok(ruleLit(rule('guidance-self-update'), entries(['scripts/hooks/pre-push'])));
  assert.ok(ruleLit(rule('guidance-self-update'), entries(['.github/workflows/ci.yml'])));
});

test('pkgJsonBuckets/bucketsDiffer: version bump vs add/remove vs scope move', () => {
  const before = pkgJsonBuckets(JSON.stringify({ dependencies: { react: '^19.0.0' }, devDependencies: { vitest: '^4.0.0' } }));
  const bump = pkgJsonBuckets(JSON.stringify({ dependencies: { react: '^19.2.0' }, devDependencies: { vitest: '^4.1.0' } }));
  const added = pkgJsonBuckets(JSON.stringify({ dependencies: { react: '^19.0.0', zod: '^3.0.0' }, devDependencies: { vitest: '^4.0.0' } }));
  const moved = pkgJsonBuckets(JSON.stringify({ dependencies: {}, devDependencies: { vitest: '^4.0.0', react: '^19.0.0' } }));
  assert.ok(!bucketsDiffer(before, bump), 'pure version bump is not structural');
  assert.ok(bucketsDiffer(before, added), 'added dependency is structural');
  assert.ok(bucketsDiffer(before, moved), 'runtime→dev move is structural');
});

test('pyprojectBuckets: sections, multi-line arrays, extras, bare names, PEP 503', () => {
  const toml = [
    '[project]',
    'dependencies = [',
    '  "fastapi>=0.100",',
    '  "uvicorn[standard]>=0.30",',
    '  "gunicorn",',
    ']',
    'name = "x"',
    '[project.optional-dependencies]',
    'dev = ["Pytest>=8", "ruff_lint>=1"]',
    '',
  ].join('\n');
  const buckets = pyprojectBuckets(toml);
  assert.deepEqual([...buckets.get('project.dependencies')].sort(), ['fastapi', 'gunicorn', 'uvicorn']);
  assert.deepEqual([...buckets.get('optional.dev')].sort(), ['pytest', 'ruff-lint'], 'PEP 503 normalisation');
  const bumped = pyprojectBuckets(toml.replace('fastapi>=0.100', 'fastapi>=0.139'));
  assert.ok(!bucketsDiffer(buckets, bumped));
  const removed = pyprojectBuckets(toml.replace('  "gunicorn",\n', ''));
  assert.ok(bucketsDiffer(buckets, removed));
});

// ---------------------------------------------------------------------------------------------
// End-to-end fixtures (scratch repos)
// ---------------------------------------------------------------------------------------------

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function write(repo, path, content) {
  mkdirSync(join(repo, dirname(path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commit(repo, msg) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}

/** origin repo (main) + a clone (so origin/main resolves in the clone). Returns both paths. */
function makeRepos(t, originExtra = null) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-impact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'user.email', 't@example.com');
  git(origin, 'config', 'user.name', 't');
  write(origin, 'docs/architecture/data-model.md', 'base\n');
  write(origin, 'docs/architecture/security.md', 'base\n');
  write(origin, 'docs/architecture/overview.md', 'base\n');
  write(origin, 'docs/testing/strategy.md', 'base\n');
  write(origin, 'docs/agent-guidance-changelog.md', 'base\n');
  write(origin, 'backend/app/persistence/store.py', 'x = 1\n');
  write(origin, 'backend/app/schema/base.py', 'x = 1\n');
  write(origin, 'frontend/package.json', `${JSON.stringify({ dependencies: { react: '^19.0.0' } }, null, 2)}\n`);
  write(origin, 'misc.txt', 'base\n');
  commit(origin, 'base');
  if (originExtra) originExtra(origin);
  const work = join(dir, 'work');
  git(dir, 'clone', '-q', origin, 'work');
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 't');
  return { origin, work };
}

function lint(repo, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('worktree mode: uncommitted trigger → exit 2 warn / exit 1 fail-on-gap; untracked adds light', (t) => {
  const { work } = makeRepos(t);
  write(work, 'backend/app/persistence/store.py', 'x = 2\n'); // dirty, no doc
  let r = lint(work, '--worktree');
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /WARN: {2}tenancy-change/);
  r = lint(work, '--worktree', '--fail-on-gap');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /GAP: {2}tenancy-change/);
  // committed mode stays blind to the dirty edit (that is what --worktree is for)
  r = lint(work, '--fail-on-gap');
  assert.equal(r.status, 0, r.out);
  // untracked new backend test file lights new-test-suite via status A
  write(work, 'backend/tests/test_shiny.py', 'def test_x(): pass\n');
  r = lint(work, '--worktree');
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /new-test-suite/);
});

test('worktree mode: uncommitted trigger + uncommitted doc edit → pass', (t) => {
  const { work } = makeRepos(t);
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  write(work, 'docs/architecture/security.md', 'updated\n');
  const r = lint(work, '--worktree', '--fail-on-gap');
  assert.equal(r.status, 0, r.out);
});

test('committed unmet rule → warn exit 2, --fail-on-gap exit 1 (what pre-push enforces)', (t) => {
  const { work } = makeRepos(t);
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  commit(work, 'feat: persistence change, no doc');
  let r = lint(work);
  assert.equal(r.status, 2, r.out);
  r = lint(work, '--fail-on-gap');
  assert.equal(r.status, 1, r.out);
});

test('ack counts only on its lighting commit, only with a reason, never from a merge commit', (t) => {
  const { work } = makeRepos(t);
  // (a) ack WITH reason on the lighting commit → pass in committed mode AND in --worktree on a
  // clean tree (the r3-T1 fixture: base→worktree must not void committed acks after commit).
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  commit(work, 'feat: relocate\n\nDocs-Impact-Ack: tenancy-change test-double relocation, no behavior change');
  assert.equal(lint(work, '--fail-on-gap').status, 0);
  const clean = lint(work, '--worktree', '--fail-on-gap');
  assert.equal(clean.status, 0, `clean tree + committed ack must pass: ${clean.out}`);
  assert.match(clean.out, /ACK: {3}tenancy-change/);

  // (b) a dirty edit that lights the same rule voids the committed ack
  write(work, 'backend/app/persistence/other.py', 'y = 1\n');
  const dirty = lint(work, '--worktree');
  assert.equal(dirty.status, 2, dirty.out);
  assert.match(dirty.out, /tenancy-change/);
});

test('ack without a reason does not count', (t) => {
  const { work } = makeRepos(t);
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  commit(work, 'feat: change\n\nDocs-Impact-Ack: tenancy-change');
  assert.equal(lint(work, '--fail-on-gap').status, 1, 'bare ack must not count');
});

test('ack on a non-lighting commit does not count', (t) => {
  const { work } = makeRepos(t);
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  commit(work, 'feat: persistence change, no ack');
  write(work, 'misc.txt', 'unrelated\n');
  commit(work, 'chore: unrelated\n\nDocs-Impact-Ack: tenancy-change acked from the wrong commit');
  assert.equal(lint(work, '--fail-on-gap').status, 1, 'ack must ride the lighting commit');
});

test('merge-commit ack never counts', (t) => {
  const { work } = makeRepos(t);
  git(work, 'checkout', '-q', '-b', 'topic');
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  commit(work, 'feat: persistence change, no ack');
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--no-ff', '-m', 'merge topic\n\nDocs-Impact-Ack: tenancy-change ack riding a merge', 'topic');
  const r = lint(work, '--fail-on-gap');
  assert.equal(r.status, 1, r.out);
});

test('on-main head~1 fallback is advisory: WARN + exit 0 even under --fail-on-gap', (t) => {
  const { work } = makeRepos(t, (origin) => {
    write(origin, 'backend/app/schema/base.py', 'x = 2\n'); // schema change, no docs, on main
    commit(origin, 'feat: schema change straight to main');
  });
  // clone HEAD == origin/main → committed mode falls back to HEAD~1 → advisory
  const r = lint(work, '--fail-on-gap');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARN: {2}schema-change/);
  assert.match(r.out, /advisory/);
  // --worktree on the same clone: base = head, the main commit is NOT re-linted
  assert.equal(lint(work, '--worktree', '--fail-on-gap').status, 0);
  // ... even with an unrelated dirty edit (the r2 fixture: fresh synced branch + dirty work)
  write(work, 'misc.txt', 'dirty but unrelated\n');
  assert.equal(lint(work, '--worktree', '--fail-on-gap').status, 0);
});

test('--head isolates the linted tip (pre-push semantics)', (t) => {
  const { work } = makeRepos(t);
  write(work, 'misc.txt', 'benign\n');
  commit(work, 'chore: benign');
  const shaA = git(work, 'rev-parse', 'HEAD');
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  commit(work, 'feat: persistence change, no doc');
  assert.equal(lint(work, '--fail-on-gap').status, 1, 'HEAD range contains the gap');
  assert.equal(lint(work, '--fail-on-gap', '--head', shaA).status, 0, 'pushed tip A is clean');
});

test('option-like refs are rejected before invoking git', (t) => {
  const { work } = makeRepos(t);
  const r = lint(work, '--head', '--help');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /invalid --head ref/);
});

test('a deleted required doc never satisfies its rule', (t) => {
  const { work } = makeRepos(t);
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  rmSync(join(work, 'docs/architecture/security.md'));
  commit(work, 'feat: change persistence, DELETE the security doc');
  const r = lint(work, '--fail-on-gap');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /tenancy-change/);
});

test('a doc committed but deleted in the worktree loses its credit (--worktree)', (t) => {
  const { work } = makeRepos(t);
  write(work, 'backend/app/persistence/store.py', 'x = 2\n');
  write(work, 'docs/architecture/security.md', 'updated\n');
  commit(work, 'feat: persistence change WITH doc');
  assert.equal(lint(work, '--worktree', '--fail-on-gap').status, 0, 'committed doc satisfies');
  rmSync(join(work, 'docs/architecture/security.md')); // dirty delete
  const r = lint(work, '--worktree');
  assert.equal(r.status, 2, `stale committed credit must not survive a worktree delete: ${r.out}`);
  assert.match(r.out, /tenancy-change/);
});

test('an ack riding a version-only bump does not validate a later structural change', (t) => {
  const { work } = makeRepos(t);
  write(work, 'frontend/package.json', `${JSON.stringify({ dependencies: { react: '^19.2.0' } }, null, 2)}\n`);
  commit(work, 'chore: bump react\n\nDocs-Impact-Ack: dependency-change routine version bump');
  assert.equal(lint(work, '--fail-on-gap').status, 0, 'version-only range stays dark');
  write(work, 'frontend/package.json', `${JSON.stringify({ dependencies: { react: '^19.2.0', zod: '^3.0.0' } }, null, 2)}\n`);
  commit(work, 'feat: add zod, no docs');
  const r = lint(work, '--fail-on-gap');
  assert.equal(r.status, 1, `the bump commit does not light dependency-change, so its ack must not count: ${r.out}`);
  assert.match(r.out, /dependency-change/);
});

test('dependency-change: worktree "after" reads the file on disk; version-only stays dark', (t) => {
  const { work } = makeRepos(t);
  // version-only dirty bump → confirmLit veto → no rule
  write(work, 'frontend/package.json', `${JSON.stringify({ dependencies: { react: '^19.2.0' } }, null, 2)}\n`);
  assert.equal(lint(work, '--worktree', '--fail-on-gap').status, 0);
  // dirty ADD of a dependency → structural → lit (docs untouched → gap)
  write(work, 'frontend/package.json', `${JSON.stringify({ dependencies: { react: '^19.0.0', zod: '^3.0.0' } }, null, 2)}\n`);
  const r = lint(work, '--worktree');
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /dependency-change/);
});

test('rename into a trigger dir lights its rule (--no-renames → D+A)', (t) => {
  const { work } = makeRepos(t);
  git(work, 'mv', 'misc.txt', 'backend/app/persistence/misc.py');
  commit(work, 'refactor: move file into persistence');
  const r = lint(work, '--fail-on-gap');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /tenancy-change/);
});
