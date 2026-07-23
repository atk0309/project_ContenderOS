## What changed

Describe the behaviour change and why it is needed. Link the issue when one exists.

## Validation

- [ ] I ran `node scripts/quality-gate.mjs --fail-on-gap` and it passed.
- [ ] I listed any intentionally skipped live-provider or Postgres checks below.
- [ ] For a non-trivial UI/render change, I verified the affected routes and states with Playwright
      and checked preview/PDF parity.

Commands and results:

<!-- Include concise command evidence. Never paste secrets, tokens, real CV data, or private URLs. -->

## Safety and documentation

- [ ] This change preserves the invariants in `AGENTS.md`.
- [ ] Tests cover the changed behaviour, including deny/failure cases where relevant.
- [ ] Documentation was updated according to the doc-impact checklist, or no rule was triggered.
- [ ] Generated OpenAPI/TypeScript files are in sync when backend schemas changed.
- [ ] The diff contains no credentials, personal data, generated CVs, databases, or populated env files.

## Known risks or follow-ups

<!-- State "None" when there are no known residual risks. -->
