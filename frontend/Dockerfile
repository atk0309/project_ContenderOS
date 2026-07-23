# Contender frontend (Next.js) + the deterministic renderer.
# Chromium + system deps live HERE (the render routes print the CV via Playwright). Fonts are
# bundled so PDFs are byte-stable across environments (docs/architecture/renderer.md).
# The base image is pinned immutably (version tag AND digest — a bare tag still floats) because
# invariant 3 pins the render toolchain; Dependabot's docker ecosystem owns the bumps.
FROM node:26-bookworm-slim@sha256:b16ca7b4dcfb20184e1c70f9ee30c6a75ed1da669cfafd6d2add4761b123d79f AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Node 25+ stopped distributing corepack with the runtime (nodejs TSC decision, 2025-03) — install
# it explicitly, VERSION-PINNED (an unpinned install would float a build-toolchain binary inside a
# digest-pinned image); packageManager in package.json stays the single source of the pnpm version.
RUN npm install -g corepack@0.35.0 && corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
# `--frozen` fails loudly on a stale lock (same contract as the backend image + CI) — no silent
# fallback to a fresh resolve.
RUN pnpm install --frozen-lockfile

COPY . .
# Generate API types from the committed OpenAPI, then build.
RUN pnpm gen:types && pnpm build
# Playwright Chromium + the libs it needs at runtime (libnss3 et al.) for the PDF render route.
# No `|| true`: a failed Chromium install must fail the BUILD, not ship an image whose
# /api/render/pdf route breaks at runtime (invariant 3; deployment.md "known gotcha").
RUN pnpm exec playwright install --with-deps chromium

EXPOSE 3000
CMD ["pnpm", "start"]
