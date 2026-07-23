#!/usr/bin/env node
/**
 * Diff-based doc-impact lint. The guidance says "update doc X when code Y changes"; prose
 * contracts rot because nothing checks them. This is the mechanical check. The RULES array
 * below must stay 1:1 with the table in AGENTS.md §14 (check-agent-guidance.mjs enforces it).
 *
 * Modes:
 *  - Default (committed): diff merge-base(head, origin/main) → head. Used by pre-push and CI.
 *    On main (merge-base == head) or with no origin/main, fall back to head~1 → head — and that
 *    fallback is ADVISORY: unmet rules WARN and the exit code is 0 even under --fail-on-gap
 *    (there is no branch increment to enforce; enforcement lives in PR runs + pre-push, and a
 *    squash merge legitimately drops ack trailers from main's history).
 *  - --worktree (used by quality-gate.mjs): rules light from the union of the committed diff,
 *    the base→worktree diff, and untracked files (status A) — so the gate sees uncommitted work.
 *    When merge-base == head the base IS head (only worktree changes are linted; never the
 *    previous main commit). No head~1 fallback in this mode.
 *
 * Flags:
 *   --against <ref>   explicit diff base (overrides merge-base resolution; never advisory)
 *   --head <ref>      the tip to lint (default HEAD) — pre-push passes each pushed sha
 *   --worktree        include uncommitted + untracked changes (see above)
 *   --fail-on-gap     unmet rules exit 1 (except the advisory fallback)
 *   --list-rules      print the rules and exit
 *
 * Exit codes: 0 clean (or advisory fallback) · 1 unmet with --fail-on-gap · 2 unmet in warn
 * mode. quality-gate.mjs maps exit 2 → GAP for this check only.
 *
 * Required-doc credit: a rule is satisfied only by a required doc that is added or modified
 * (status A/M/T) in the diff — a DELETED doc never satisfies its rule.
 *
 * Ack scoping: a `Docs-Impact-Ack: <rule-id> <reason>` trailer counts only when BOTH hold:
 *   1. it rides a non-merge commit in the range whose OWN diff lights the rule, and
 *   2. it carries a non-empty reason.
 * A rule lit by a dirty/untracked path (--worktree) ignores committed acks — uncommitted work
 * cannot have been acked. A rule lit only by committed paths honours committed acks, so a clean
 * tree with a sanctioned ack in range still passes the gate.
 *
 * Node stdlib only. Favours false positives — acknowledge via the trailer.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RULES = [
  { id: 'schema-change', modified: [/^backend\/app\/schema\//], requiredDocs: ['docs/architecture/data-model.md'] },
  { id: 'schema-contract', modified: [/^backend\/app\/schema\//], requiredDocs: ['frontend/openapi.json', 'frontend/src/lib/api/generated-types.ts'] },
  { id: 'new-api-route', added: [/^backend\/app\/routes\/.+\.py$/], requiredDocs: ['docs/architecture/api.md'] },
  { id: 'ai-agent-change', added: [/^backend\/app\/ai\/agents\/.+\.py$/], modified: [/^backend\/app\/ai\/agents\/.+\.py$/], requiredDocs: ['docs/ai-panel.md'] },
  { id: 'provider-change', modified: [/^backend\/app\/ai\/providers\/.+\.py$/], requiredDocs: ['docs/architecture/api.md'] },
  { id: 'render-change', modified: [/^frontend\/src\/render\//], requiredDocs: ['docs/architecture/renderer.md'] },
  { id: 'auth-change', modified: [/^backend\/app\/auth\//], requiredDocs: ['docs/architecture/security.md'] },
  { id: 'tenancy-change', modified: [/^backend\/app\/persistence\//], requiredDocs: ['docs/architecture/security.md'] },
  // §14 says "a */.env.example" — any service's env example, not a hardcoded pair.
  { id: 'env-vars-changed', modified: [/(^|\/)\.env\.example$/], requiredDocs: ['docs/architecture/deployment.md'] },
  // §14 says "frontend *.test.ts(x)" — anywhere under frontend/, not only src/.
  { id: 'new-test-suite', added: [/^backend\/tests\/.+_test\.py$/, /^backend\/tests\/test_.+\.py$/, /^frontend\/.+\.test\.tsx?$/], requiredDocs: ['docs/testing/strategy.md'] },
  { id: 'dependency-change', modified: [/^backend\/pyproject\.toml$/, /^frontend\/package\.json$/], requiredDocs: ['docs/architecture/overview.md', 'docs/testing/strategy.md'], requiredAny: true, confirmLit: (ctx) => structuralDependencyChange(ctx) },
  { id: 'new-diagram', added: [/^docs\/diagrams\/[^/]+\.mmd$/], requiredDocs: ['docs/index.html', 'docs/README.md'] },
  { id: 'adr-added', added: [/^docs\/adr\/(?!_template\.md)[^/]+\.md$/], requiredDocs: ['docs/index.html', 'docs/README.md'] },
  // §14 says "scripts/**" — the whole harness, not just *.mjs + hooks/.
  { id: 'guidance-self-update', modified: [/^AGENTS\.md$/, /^CLAUDE\.md$/, /^backend\/AGENTS\.md$/, /^frontend\/AGENTS\.md$/, /^scripts\//, /^\.github\/workflows\//], requiredDocs: ['docs/agent-guidance-changelog.md'] },
];

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for the scripts/*.test.mjs self-tests)
// ---------------------------------------------------------------------------------------------

/** Parse `git diff --no-renames --name-status` output → [{status, path}]. With --no-renames a
 * rename arrives as an independent D + A pair, so a file renamed INTO a trigger directory lights
 * its rule and a required doc renamed AWAY stops counting (its old path is a D). */
export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
}

/** True when the rule's trigger regexes match the given diff entries (`added` patterns test
 * status-A paths; `modified` patterns test every changed path). confirmLit is NOT applied here. */
export function ruleLit(rule, entries) {
  const addedPaths = entries.filter((e) => e.status === 'A').map((e) => e.path);
  const allPaths = entries.map((e) => e.path);
  return (
    (rule.added || []).some((re) => addedPaths.some((p) => re.test(p))) ||
    (rule.modified || []).some((re) => allPaths.some((p) => re.test(p)))
  );
}

/** True when the commit message carries a `Docs-Impact-Ack: <id> <reason>` on its own
 * (trailer-style) line WITH a non-empty reason — a bare rule id does not count. */
export function hasValidAck(message, id) {
  return new RegExp(`^\\s*Docs-Impact-Ack:\\s*${id}\\s+\\S+`, 'm').test(message);
}

// --- dependency-change refinement -----------------------------------------------------------
// The rule exists so a NEW or REMOVED dependency lands in the architecture/testing docs. A pure
// version bump (Dependabot's staple) changes neither, so it should not demand a doc edit. Confirm
// the rule only when the set of declared dependency names changes — compared PER SCOPE/bucket, so
// moving a package between runtime/dev/optional still counts (it changes the shipped surface).
const PEP503 = (n) => n.toLowerCase().replace(/[-_.]+/g, '-'); // PyPI name equivalence (pyproject)
const reqName = (s) => {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s); // PEP 508 name, incl. bare (no operator)
  return m ? PEP503(m[1]) : null;
};

// frontend/package.json → Map<bucket, Set<name>>. npm names are case/punctuation-significant
// (`foo_bar` ≠ `foo-bar`), so compare them EXACTLY — no PEP 503 normalisation here.
export function pkgJsonBuckets(blob) {
  const json = JSON.parse(blob);
  const buckets = new Map();
  for (const f of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
    buckets.set(f, new Set(Object.keys(json[f] || {})));
  return buckets;
}

// backend/pyproject.toml → Map<bucket, Set<PEP503 name>>. No stdlib TOML parser, so scan the
// dependency arrays only (section-aware) — that catches bare names like "gunicorn" without grabbing
// config strings, and keeps scopes separate: project.dependencies, optional.<group>, group.<group>.
export function pyprojectBuckets(blob) {
  const buckets = new Map();
  let section = '';
  let openBucket = null; // set while inside a multi-line array
  const add = (bucket, text) => {
    for (const m of text.matchAll(/"([^"]+)"/g)) {
      const n = reqName(m[1]);
      if (n) buckets.get(bucket).add(n);
    }
  };
  // Array-closing `]` detection must ignore `]` inside quoted requirements (extras like
  // `uvicorn[standard]`), so test for it only on the part outside string literals.
  const closes = (text) => text.replace(/"[^"]*"/g, '').includes(']');
  for (const raw of blob.split('\n')) {
    const line = raw.replace(/\s#.*$/, ''); // drop trailing comments (requirements carry none)
    if (openBucket) {
      add(openBucket, line);
      if (closes(line)) openBucket = null;
      continue;
    }
    const sec = /^\s*\[+([^\]]+)\]+\s*$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const arr = /^\s*([A-Za-z0-9._-]+)\s*=\s*\[(.*)$/.exec(line);
    if (!arr) continue;
    let bucket = null;
    if (section === 'project' && arr[1] === 'dependencies') bucket = 'project.dependencies';
    else if (section === 'project.optional-dependencies') bucket = `optional.${arr[1]}`;
    else if (section === 'dependency-groups') bucket = `group.${arr[1]}`;
    if (!bucket) continue;
    if (!buckets.has(bucket)) buckets.set(bucket, new Set());
    add(bucket, arr[2]);
    if (!closes(arr[2])) openBucket = bucket; // array continues on later lines
  }
  return buckets;
}

/** True when any dependency name was added/removed in any bucket (a scope move shows up as a
 * remove in one bucket + an add in another). */
export function bucketsDiffer(before, after) {
  for (const bucket of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(bucket) || new Set();
    const a = after.get(bucket) || new Set();
    for (const n of a) if (!b.has(n)) return true;
    for (const n of b) if (!a.has(n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Git plumbing + CLI
// ---------------------------------------------------------------------------------------------

let repoCwd = process.cwd();
const git = (...args) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: repoCwd,
    }).trim();
  } catch {
    return '';
  }
};

const REF_RE = /^(?!-)[\w./~^@{}-]+$/; // reject malformed or option-like user-supplied refs

function resolveRef(ref, flag) {
  if (!REF_RE.test(ref)) {
    console.error(`check-doc-impact: invalid ${flag} ref: ${ref}`);
    process.exit(1);
  }
  const sha = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  if (!sha) {
    console.error(`check-doc-impact: cannot resolve ${flag} ${ref}`);
    process.exit(1);
  }
  return sha;
}

function depBuckets(path, source) {
  // `source` is a git ref, or {worktree: true} to read the file on disk (--worktree "after").
  let blob;
  if (source && source.worktree) {
    try {
      blob = readFileSync(join(repoCwd, path), 'utf8');
    } catch {
      return null;
    }
  } else {
    blob = git('show', `${source}:${path}`);
    if (!blob) return null; // absent / unreadable at this ref → unknown
  }
  try {
    return path.endsWith('.json') ? pkgJsonBuckets(blob) : pyprojectBuckets(blob);
  } catch {
    return null; // unparseable → can't prove version-only
  }
}

// True when a changed manifest adds/removes a dependency in ANY scope vs `base`. In --worktree
// mode the "after" state is the file on disk (uncommitted manifest edits count); otherwise it is
// `head`. Unknown (absent/unparseable at either end) stays strict → treated as structural.
function structuralDependencyChange({ base, head, worktree, changedPaths }) {
  for (const manifest of ['frontend/package.json', 'backend/pyproject.toml']) {
    if (!changedPaths.has(manifest)) continue;
    const before = depBuckets(manifest, base);
    const after = depBuckets(manifest, worktree ? { worktree: true } : head);
    if (before === null || after === null) return true;
    if (bucketsDiffer(before, after)) return true;
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list-rules')) {
    for (const r of RULES) console.log(`${r.id.padEnd(22)} -> ${r.requiredDocs.join(r.requiredAny ? ' | ' : ', ')}`);
    process.exit(0);
  }
  const failOnGap = args.includes('--fail-on-gap');
  const worktree = args.includes('--worktree');
  const flagValue = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const againstArg = flagValue('--against');
  const headArg = flagValue('--head');

  repoCwd = git('rev-parse', '--show-toplevel') || process.cwd();
  const head = headArg
    ? resolveRef(headArg, '--head')
    : git('rev-parse', '--verify', '--quiet', 'HEAD');
  if (!head) {
    console.log('check-doc-impact: no commits yet — skipping.');
    process.exit(0);
  }

  // Resolve the diff base. `advisory` marks the committed-mode head~1 fallback: there is no
  // branch increment to enforce against, so unmet rules are informational (WARN + exit 0).
  let base = null;
  let advisory = false;
  if (againstArg) {
    base = resolveRef(againstArg, '--against');
  } else {
    const originMain = git('rev-parse', '--verify', '--quiet', 'origin/main');
    const mb = originMain ? git('merge-base', head, 'origin/main') : '';
    if (mb && mb !== head) {
      base = mb;
    } else if (worktree) {
      base = head; // on main / no upstream: lint the worktree changes only
    } else {
      const prev = git('rev-parse', '--verify', '--quiet', `${head}~1`);
      if (!prev) {
        console.log('check-doc-impact: no prior commit to diff against — skipping (first commit).');
        process.exit(0);
      }
      base = prev;
      advisory = true;
    }
  }

  const committedDiff =
    base === head
      ? []
      : parseNameStatus(git('diff', '--no-renames', '--name-status', base, head, '--'));
  // --worktree: rules LIGHT from committed ∪ base→worktree ∪ untracked. The ack-exempt bucket is
  // the DIRTY SET ONLY (head→worktree ∪ untracked) — never base→worktree, which on a clean tree
  // reproduces the whole committed diff and would discard valid committed acks.
  let baseToWorktree = [];
  let untracked = [];
  let dirty = [];
  if (worktree) {
    baseToWorktree = parseNameStatus(git('diff', '--no-renames', '--name-status', base, '--'));
    untracked = git('ls-files', '--others', '--exclude-standard')
      .split('\n')
      .filter(Boolean)
      .map((p) => ({ status: 'A', path: p }));
    dirty = [
      ...parseNameStatus(git('diff', '--no-renames', '--name-status', head, '--')),
      ...untracked,
    ];
  }
  const lighting = [...committedDiff, ...baseToWorktree, ...untracked];
  const changedPaths = new Set(lighting.map((e) => e.path));
  // Required-doc credit: added or modified only — a deleted doc never satisfies a rule. In
  // --worktree mode credit comes from the FINAL state only (base→worktree ∪ untracked): a doc
  // edited in a commit but deleted in the worktree must not keep stale committed credit.
  const creditSource = worktree ? [...baseToWorktree, ...untracked] : committedDiff;
  const creditable = new Set(creditSource.filter((e) => 'AMT'.includes(e.status)).map((e) => e.path));
  const inDiff = (doc) =>
    doc.endsWith('/') ? [...creditable].some((p) => p.startsWith(doc)) : creditable.has(doc);

  // Ack scan: non-merge commits in range, each judged on its OWN diff (computed lazily).
  const rangeCommits =
    base === head
      ? []
      : git('log', '--no-merges', '--format=%H', `${base}..${head}`, '--')
          .split('\n')
          .filter(Boolean);
  const commitDiffCache = new Map();
  const commitDiff = (c) => {
    if (!commitDiffCache.has(c)) {
      commitDiffCache.set(
        c,
        parseNameStatus(git('diff', '--no-renames', '--name-status', `${c}^`, c, '--')),
      );
    }
    return commitDiffCache.get(c);
  };
  // "Lights the rule" is judged per commit with the SAME semantics as the range: for
  // dependency-change that includes the structural add/remove check on the commit's own diff —
  // an ack riding a version-only bump must not validate a later structural change.
  const ackedOnLightingCommit = (rule) =>
    rangeCommits.some((c) => {
      if (!hasValidAck(git('log', '-1', '--format=%B', c, '--'), rule.id)) return false;
      const diff = commitDiff(c);
      if (!ruleLit(rule, diff)) return false;
      if (rule.confirmLit) {
        const commitCtx = {
          base: `${c}^`,
          head: c,
          worktree: false,
          changedPaths: new Set(diff.map((e) => e.path)),
        };
        if (!rule.confirmLit(commitCtx)) return false;
      }
      return true;
    });

  const ctx = { base, head, worktree, changedPaths };
  let gaps = 0;
  for (const rule of RULES) {
    let lit = ruleLit(rule, lighting);
    if (lit && rule.confirmLit && !rule.confirmLit(ctx)) lit = false;
    if (!lit) continue;

    const ok = rule.requiredAny ? rule.requiredDocs.some(inDiff) : rule.requiredDocs.every(inDiff);
    if (ok) continue;
    const litByDirty = worktree && ruleLit(rule, dirty);
    if (!litByDirty && ackedOnLightingCommit(rule)) {
      console.error(`ACK:   ${rule.id} — acknowledged via Docs-Impact-Ack trailer on its lighting commit`);
      continue;
    }
    gaps++;
    const sep = rule.requiredAny ? ' | ' : ', ';
    const label = advisory || !failOnGap ? 'WARN' : 'GAP';
    console.error(`${label}:  ${rule.id} lit but missing doc update -> ${rule.requiredDocs.join(sep)}`);
  }

  if (gaps === 0) {
    console.log('check-doc-impact: OK');
    process.exit(0);
  }
  console.error(
    `\ncheck-doc-impact: ${gaps} unmet rule(s). Add the doc update, or a 'Docs-Impact-Ack: <rule-id> <reason>' trailer on the commit that lights the rule.`,
  );
  if (advisory) {
    console.error(
      'check-doc-impact: advisory only (on-main fallback range — no branch increment to enforce). Not failing.',
    );
    process.exit(0);
  }
  process.exit(failOnGap ? 1 : 2);
}

// Import-safe: executing the checks only when run as a CLI lets the self-tests import the pure
// helpers above without the process exiting at import time.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
