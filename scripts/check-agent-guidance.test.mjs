/**
 * Self-tests for check-agent-guidance.mjs — chiefly the §14-table parser that enforces the
 * "§14 table and the lint's RULES stay 1:1" promise (AGENTS.md §15). The parser must survive the
 * decoys the real file contains: the §5 command table (backticked commands in its last cells),
 * header + separator rows, and prose mentions of rule ids outside any table.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ruleIdsFromSection14 } from './check-agent-guidance.mjs';
import { RULES } from './check-doc-impact.mjs';

test('parses rule ids from §14 only, skipping header/separator rows and decoy tables', () => {
  const doc = [
    '# AGENTS.md',
    '',
    '## 5. Canonical commands',
    '',
    '| Purpose | Command |',
    '|---|---|',
    '| Doc-impact rules | `node scripts/check-doc-impact.mjs --list-rules` |',
    '| Gate | `node scripts/quality-gate.mjs` |',
    '',
    'Prose mentioning `schema-change` and `guidance-self-update` outside a table.',
    '',
    '## 14. Doc-impact checklist',
    '',
    'The lint enforces the same rules (`ai-agent-change` is one of them).',
    '',
    '| Change type | Required doc updates | Rule id |',
    '|---|---|---|',
    '| Modified `backend/app/schema/**` | `docs/architecture/data-model.md` | `schema-change` |',
    '| Added `backend/app/routes/*.py` | `docs/architecture/api.md` | `new-api-route` |',
    '| Modified `AGENTS.md` | `docs/agent-guidance-changelog.md` | `guidance-self-update` |',
    '',
    '**Escape hatch.** Add `Docs-Impact-Ack: <rule-id> <reason>`.',
    '',
    '## 15. Self-update protocol',
    '',
    '| Decoy | Table |',
    '|---|---|',
    '| after section 14 | `not-a-rule` |',
  ].join('\n');
  assert.deepEqual(ruleIdsFromSection14(doc), ['schema-change', 'new-api-route', 'guidance-self-update']);
});

test('missing §14 heading → empty list (the runtime check fails loudly on that)', () => {
  assert.deepEqual(ruleIdsFromSection14('# nothing here\n\n| a | b |\n|---|---|\n| x | `y` |\n'), []);
});

test('the REAL AGENTS.md §14 table is 1:1 with the doc-impact RULES', () => {
  const agents = readFileSync(fileURLToPath(new URL('../AGENTS.md', import.meta.url)), 'utf8');
  const tableIds = ruleIdsFromSection14(agents);
  const ruleIds = RULES.map((r) => r.id);
  assert.deepEqual(new Set(tableIds), new Set(ruleIds));
  assert.equal(tableIds.length, new Set(tableIds).size, 'no duplicate rows');
});
