/**
 * Self-tests for check-invariants.mjs — the key-literal shapes (invariant 4), the paren-balanced
 * invariant-8 route parser, and the invariant-6 provider map. Key fixtures are CONSTRUCTED (never
 * written as literals) so no secret scanner — including our own guard — can trip on this file.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGENT_PROVIDER_MAP,
  KEY_LITERAL_PATTERNS,
  codeOnly,
  exportGateViolations,
  providerViolations,
  workspaceRouteViolations,
} from './check-invariants.mjs';

const SCRIPT = fileURLToPath(new URL('./check-invariants.mjs', import.meta.url));
const matchesAny = (s) => KEY_LITERAL_PATTERNS.some((re) => re.test(s));

test('invariant 4: all three real key shapes match; the admin placeholder does not', () => {
  const anthropicKey = ['sk', 'ant', 'api03'].join('-') + '-' + 'A1b2'.repeat(6); // sk-ant-api03-…
  const openaiProjKey = ['sk', 'proj'].join('-') + '-' + 'Zz9_'.repeat(6); // sk-proj-… with _
  const legacyKey = 'sk-' + 'a1B2c3d4'.repeat(3); // bare 24-alnum tail, no second hyphen
  assert.ok(matchesAny(anthropicKey), 'sk-ant-* must match (tail contains a hyphen)');
  assert.ok(matchesAny(openaiProjKey), 'sk-proj-* must match (tail contains an underscore)');
  assert.ok(matchesAny(legacyKey), 'legacy bare sk-<20+ alnum> must match (mandatory pattern)');
  // negatives: the admin key-input placeholders and short fragments
  assert.ok(!matchesAny('placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}'));
  assert.ok(!matchesAny('sk-ant-…'));
  assert.ok(!matchesAny('sk-…'));
  assert.ok(!matchesAny('sk-ant-x'), 'tail under 8 chars stays unmatched');
});

test('invariant 8 parser: multi-line decorator with nested responses={} and comments', () => {
  const guarded = [
    '@router.post(',
    '    "/{workspace_id}/cv/{cv_id}/apply",',
    '    response_model=Application,',
    '    # 409 carries one of TWO bodies (comment with an unbalanced paren',
    '    responses={',
    '        status.HTTP_409_CONFLICT: {"model": ApplicationConflict | ExportBlocked},',
    '    },',
    '    dependencies=[Depends(require_workspace_owner)],',
    ')',
    'async def apply(',
    '    workspace_id: str,',
    '    body: ApplyRequest,',
    '    session: AsyncSession = Depends(get_session),',
    ') -> Application | JSONResponse:',
    '    """Docstring mentioning {workspace_id} — outside the span."""',
  ].join('\n');
  assert.deepEqual(workspaceRouteViolations(guarded), []);

  const unguarded = guarded.replace('    dependencies=[Depends(require_workspace_owner)],\n', '');
  assert.deepEqual(workspaceRouteViolations(unguarded), [{ line: 1 }], 'dropping the dependency must fire');
});

test('invariant 8 parser: signature-default Depends counts; docstrings and non-ws routes do not', () => {
  const signatureGuarded = [
    '@router.get("/{workspace_id}/master", response_model=MasterProfile)',
    'async def read_master(',
    '    workspace_id: str,',
    '    user: AuthUser = Depends(require_workspace_member),',
    ') -> MasterProfile:',
    '    ...',
  ].join('\n');
  assert.deepEqual(workspaceRouteViolations(signatureGuarded), []);

  const nonWorkspace = [
    '"""Module docstring mentioning {workspace_id} routes."""',
    '@router.get("/health")',
    'def health() -> dict[str, str]:',
    '    return {"ok": "true"}',
  ].join('\n');
  assert.deepEqual(workspaceRouteViolations(nonWorkspace), [], 'docstring mention must not anchor a rule');

  const unguardedSimple = [
    '@router.get("/{workspace_id}/thing")',
    'async def thing(workspace_id: str) -> None:',
    '    ...',
  ].join('\n');
  assert.deepEqual(workspaceRouteViolations(unguardedSimple), [{ line: 1 }]);
});

test('invariant 8 parser: commented-out or string-quoted dependencies never satisfy the guard', () => {
  const commentSpoof = [
    '@router.get(',
    '    "/{workspace_id}/thing",',
    '    # TODO: add Depends(require_workspace_owner) once ready',
    ')',
    'async def thing(workspace_id: str) -> None:',
    '    ...',
  ].join('\n');
  assert.deepEqual(workspaceRouteViolations(commentSpoof), [{ line: 1 }], 'comment text must not count');

  const stringSpoof = [
    '@router.get(',
    '    "/{workspace_id}/thing",',
    '    summary="checked by require_workspace_owner",',
    ')',
    'async def thing(workspace_id: str) -> None:',
    '    ...',
  ].join('\n');
  assert.deepEqual(workspaceRouteViolations(stringSpoof), [{ line: 1 }], 'string contents must not count');
});

test('invariant 2: needs_signoff() must live in the /export route itself, not elsewhere in the file', () => {
  const gated = [
    '@router.get(',
    '    "/{workspace_id}/cv/{cv_id}/export",',
    '    dependencies=[Depends(require_workspace_owner)],',
    ')',
    'async def export_cv(workspace_id: str, cv_id: str) -> RenderBundle:',
    '    if cv.needs_signoff():',
    '        return blocked',
    '    return bundle',
    '',
    '@router.get("/{workspace_id}/cv", dependencies=[Depends(require_workspace_member)])',
    'async def list_cvs(workspace_id: str) -> list[CvSummary]:',
    '    return summaries',
  ].join('\n');
  assert.deepEqual(exportGateViolations(gated), []);

  // the gate call exists in the file (an unrelated dashboard projection) but NOT in the export
  // route — the exact drift i=63 names must fire
  const drifted = [
    '@router.get("/{workspace_id}/cv", dependencies=[Depends(require_workspace_member)])',
    'async def list_cvs(workspace_id: str) -> list[CvSummary]:',
    '    return [CvSummary(needs_signoff=cv.needs_signoff())]',
    '',
    '@router.get(',
    '    "/{workspace_id}/cv/{cv_id}/export",',
    '    dependencies=[Depends(require_workspace_owner)],',
    ')',
    'async def export_cv(workspace_id: str, cv_id: str) -> RenderBundle:',
    '    return bundle  # gate refactored away',
  ].join('\n');
  assert.deepEqual(exportGateViolations(drifted), [{ line: 5 }]);
  // ... and neither a comment nor a string literal mentioning the gate counts
  const commentSpoof = drifted.replace('    return bundle  # gate refactored away', '    return bundle  # needs_signoff() handled upstream, honest');
  assert.deepEqual(exportGateViolations(commentSpoof), [{ line: 5 }]);
  const stringSpoof = drifted.replace('    return bundle  # gate refactored away', '    return note("needs_signoff() handled upstream")');
  assert.deepEqual(exportGateViolations(stringSpoof), [{ line: 5 }]);
  // ... nor a multi-line docstring inside the handler body
  const docstringSpoof = drifted.replace(
    '    return bundle  # gate refactored away',
    ['    """Gate-checked render.', '', '    Blocks via needs_signoff() upstream, promise.', '    """', '    return bundle'].join('\n'),
  );
  assert.deepEqual(exportGateViolations(docstringSpoof), [{ line: 5 }], 'multi-line docstring must not count');
});

test('invariant 5: the .parse( marker must be CODE — docstring/comment mentions do not count', () => {
  const real = [
    '"""Wrapper.',
    '',
    "Uses the SDK's structured-output helper `messages.parse(output_format=...)` in prose.",
    '"""',
    'async def run(client):',
    '    resp = await client.messages.parse(',
    '        output_format=schema,',
    '    )',
  ].join('\n');
  assert.ok(codeOnly(real).includes('messages.parse('));
  const gutted = real.replace('    resp = await client.messages.parse(\n        output_format=schema,\n    )', '    resp = legacy(client)  # messages.parse( gone');
  assert.ok(!codeOnly(gutted).includes('messages.parse('), 'prose/comment mentions must not satisfy the marker');
});

test('invariant 6: wrong provider, unmapped module, and lost literal all fire; correct wiring passes', () => {
  assert.deepEqual(providerViolations('tailor', 'provider=Provider.anthropic'), []);
  assert.deepEqual(
    providerViolations('extractor', ['provider=Provider.anthropic', 'provider=Provider.anthropic', 'provider=Provider.anthropic'].join('\n')),
    [],
    'all three extractor declarations pass per-match',
  );
  assert.equal(providerViolations('editor', 'provider=Provider.anthropic').length, 1, 'adjudicator on Claude must fire');
  assert.equal(providerViolations('brand_new_agent', 'provider=Provider.openai').length, 1, 'unmapped module with a literal must fire');
  assert.equal(providerViolations('tailor', 'no literals here').length, 1, 'mapped module losing its literal must fire');
  assert.deepEqual(providerViolations('ingest', 'agents wire dynamically'), [], 'dynamic modules stay exempt');
  assert.equal(Object.keys(AGENT_PROVIDER_MAP).length, 10, 'the panel is 10 statically-wired agents');
});

test('the guard passes against the live tree (zero false positives)', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /check-invariants: OK/);
});
