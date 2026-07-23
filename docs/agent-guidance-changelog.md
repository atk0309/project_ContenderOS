# Agent guidance changelog

Durable changes to `AGENTS.md`, nested agent guidance, `CLAUDE.md`, repository scripts, and GitHub
workflows are recorded here. The local `guidance-self-update` rule enforces that contract.

## 2026-07-23 (dependency toolchain refresh)

- Moved CI to `astral-sh/setup-uv@v9.0.0` (the release has no floating `v9` ref), pinned uv
  `0.11.31`, and aligned CI with `pnpm@11.16.0`.
- Migrated pnpm policy and security overrides from `package.json` to `pnpm-workspace.yaml`, including
  the pnpm 11 build allowlist and exact release-age exception required by the reviewed lockfile.
- Kept application type-checking on TypeScript 7 while retaining TypeScript 5 solely for
  `openapi-typescript`'s supported compiler API; Dependabot ignores only that incompatible major.
- Refreshed direct and transitive backend/frontend packages, Docker base digests, lockfiles, and
  Next 16.2's generated TypeScript settings as one validated toolchain update.

Why for future agents: keep pnpm aligned between CI and `packageManager`, copy
`pnpm-workspace.yaml` into the frontend Docker dependency layer, and pin setup-uv to a published ref.

## 2026-07-23 (initial public source release)

- Prepared the repository for its fresh-history public release as **ContenderOS** under the MIT
  License.
- Generalised deployment guidance so GitHub checks prove CI and production-build mechanics without
  implying that a public fork is connected to any maintainer deployment.
- Replaced the private-instance statement about a live M365 gate with the durable rule: every
  production operator must configure authentication and the server-side allowlist before accepting
  real CV data.
- Generalised the CI workflow comments to describe an optional hosting integration rather than a
  specific private deployment.

Why for future agents: this public repository is a self-hostable source distribution. Never infer
that its default branch is deployed, and never weaken the deny-by-default authentication,
allowlisting, tenant-isolation, provenance, or sign-off requirements for convenience.
