# Contender — frontend (Next.js)

The design-true UI **and** the deterministic renderer. One React `ResumeTemplate` drives both the
live preview and the exported PDF (Playwright prints the hidden `/print/[cvId]` route), so what you
see equals what you ship. DOCX comes from the same JSON via the `docx` lib. All AI/data/auth lives
in the FastAPI backend — Next holds no business logic, only the UI + the render routes.

## Setup

```bash
npm i -g corepack@0.35.0   # Node 25+ no longer bundles corepack
corepack enable
pnpm install
pnpm gen:types      # generate API types from ../backend (via frontend/openapi.json)
cp .env.example .env.local
pnpm dev
```

## Quality gate (frontend half)

```bash
pnpm gen:types && pnpm lint && pnpm typecheck && pnpm test
```

Run from the repo root with `node scripts/quality-gate.mjs` to gate both services at once.

## Design source of truth

The visual spec is the Claude Design handoff (`Contender.dc.html`). Tokens are ported verbatim
to `src/app/globals.css`; recreate screens pixel-for-pixel.
