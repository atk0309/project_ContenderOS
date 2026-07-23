#!/usr/bin/env node
// Activate the repo's tracked git hooks via `core.hooksPath`. Cross-platform; run once per clone.
//
// Why core.hooksPath and not a file copy into $GIT_DIR/hooks: a copy silently no-ops in linked
// worktrees (`git rev-parse --git-dir` there is `.git/worktrees/<name>`, whose hooks/ git never
// executes), and a copied hook rots when the tracked scripts/hooks/* changes. The RELATIVE path
// resolves against the working-tree root at hook time (githooks(5)), so the main checkout and
// every linked worktree each run their own checked-out scripts/hooks/.
import { execSync } from 'node:child_process';
import { chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

try {
  execSync('git rev-parse --git-dir', { stdio: 'ignore' });
} catch {
  console.error('Not a git repository — run `git init` first.');
  process.exit(1);
}
execSync('git config core.hooksPath scripts/hooks');
// Hooks must be executable; the checkout preserves the tracked mode on POSIX, but make sure
// (best-effort — irrelevant on Windows).
try {
  for (const f of readdirSync('scripts/hooks')) chmodSync(join('scripts/hooks', f), 0o755);
} catch {
  /* best-effort */
}
console.log('core.hooksPath -> scripts/hooks (this clone + all its linked worktrees)');
