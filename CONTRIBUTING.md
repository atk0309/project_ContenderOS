# Contributing

Thanks for helping improve ContenderOS.

## Before you start

Read `AGENTS.md` and any nested `AGENTS.md` that applies to the files you plan to change. Those
documents define the architectural invariants, generated-schema workflow, documentation contract,
and required validation.

## Privacy rules

This repository must remain safe to clone and publish.

- Do not add real CVs, personal names, email addresses, phone numbers, recruiter records, account
  identifiers, tenant identifiers, access tokens, cookies, database snapshots, or deployment
  secrets.
- Use clearly synthetic identities and reserved domains such as `example.com` in tests, docs, and
  design fixtures.
- Keep generated documents, screenshots from live sessions, populated environment files, and local
  databases out of source control.
- If sensitive data lands in a commit, stop and report it privately using `SECURITY.md`; deleting it
  in a later commit is not enough.

## Development workflow

1. Create a focused branch.
2. Make the smallest change that preserves the invariants.
3. Add or update tests and documentation with the code.
4. Run `node scripts/quality-gate.mjs`.
5. For non-trivial UI or renderer work, perform the live preview and PDF verification described in
   `AGENTS.md`.

Pull requests should explain the behaviour change, user impact, validation performed, and any known
gaps. By contributing, you agree that your contribution is licensed under the repository's MIT
License.
