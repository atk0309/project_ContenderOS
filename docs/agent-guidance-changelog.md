# Agent guidance changelog

Durable changes to `AGENTS.md`, nested agent guidance, `CLAUDE.md`, repository scripts, and GitHub
workflows are recorded here. The local `guidance-self-update` rule enforces that contract.

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
