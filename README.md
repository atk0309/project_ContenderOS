# ContenderOS

Contender is an open-source, self-hosted CV-tailoring cockpit. Paste a job posting, let a
schema-constrained panel of AI agents tailor and review a master CV, edit against a live preview,
export ATS/plain and designed PDF or DOCX variants, and track the application through a pipeline.

The repository is designed for a small set of allowlisted owner accounts. It is not a hosted
multi-tenant service and it ships with no provider credentials, personal CVs, or production
configuration.

## Why it is different

- **Facts stay traceable.** Every tailored bullet points back to a master-profile source. Net-new
  claims block export until the candidate explicitly signs them off.
- **AI judges; deterministic code renders.** Providers return validated JSON. One frontend template
  drives the live preview and document exports.
- **Provider roles are deliberate.** Claude handles authoring passes; OpenAI handles adjudication.
- **Credentials stay server-side.** Provider keys are encrypted in the database and managed from
  the owner-only admin surface.
- **The full quality contract is local.** One command runs guidance, invariant, backend, schema,
  frontend, and documentation checks.

See [the invariants](docs/invariants.md), [the AI panel](docs/ai-panel.md), and
[the architecture index](docs/README.md) for the design contract.

## Repository layout

```text
backend/    FastAPI service: AI panel, persistence, auth, and provenance enforcement
frontend/   Next.js UI and deterministic preview/PDF/DOCX renderer
scripts/    local quality gate, invariant guards, and documentation checks
docs/       architecture, ADRs, features, runbooks, and design references
```

## Local setup

Requirements: Node 26, pnpm 10, Python 3.14, and
[uv](https://docs.astral.sh/uv/). Local development and the default test suite use SQLite; a
Postgres service is needed for the Postgres-only concurrency tests.

```bash
# Backend
cd backend
uv sync --extra dev
cp .env.example .env

# Frontend
cd ../frontend
npm install --global corepack@0.35.0
corepack enable
pnpm install
pnpm gen:types
cp .env.example .env.local

# Optional repository hook
cd ..
node scripts/install-hooks.mjs
```

Fill the copied environment files with your own local values. Anthropic and OpenAI API keys are
entered after sign-in through the admin menu; they must never be added to either frontend
configuration or source control.

## Quality gate

Before submitting or publishing a change, run:

```bash
node scripts/quality-gate.mjs
```

The gate checks agent guidance, architectural invariants, script self-tests, documentation impact,
backend lint/types/tests, generated API-schema drift, and frontend lint/types/tests. A skipped check
is reported as a gap, not a pass.

## Deployment

The documented target is Railway with separate backend and frontend services plus managed Postgres.
Only the frontend should receive a public domain; it proxies authenticated requests to the backend
over the private network. Read [the deployment guide](docs/architecture/deployment.md) and
[security model](docs/architecture/security.md) before exposing an instance.

Do not put a real CV behind a publicly reachable route until authentication, the allowlist, secure
cookies, database encryption, and tenant checks are configured and verified.

## Privacy and test data

Tracked fixtures and design examples are synthetic. Keep the public repository that way:

- use reserved domains such as `example.com` and clearly fictional identities;
- never commit CVs, recruiter details, exported documents, screenshots of live sessions, databases,
  cookies, tokens, or populated environment files;
- report a suspected secret or personal-data exposure privately as described in
  [SECURITY.md](SECURITY.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the repository's [AGENTS.md](AGENTS.md) before changing
code. The local quality gate is required for every contribution, and participation is governed by
the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

ContenderOS is available under the [MIT License](LICENSE).
