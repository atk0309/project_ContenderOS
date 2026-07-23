# ADR 0002: Renderer — Next.js render routes, co-located with the template

Status: accepted  
Date: 2026-06-18

## Context

Invariant 3 requires the live preview to equal the exported PDF, from ONE template. PDF/DOCX
rendering must run in Node/React (Playwright print-to-PDF + the `docx` npm lib); Python rendering
(WeasyPrint) would require a second HTML/CSS template and break the single-template guarantee. With a
FastAPI backend, where does rendering live?

## Decision

The Next.js frontend owns rendering. `ResumeTemplate.tsx` is mounted both on screen (preview) and at
a hidden `/print/[cvId]` route; `app/api/render/pdf` launches Playwright Chromium, navigates to that
print route, and calls `page.pdf()`. DOCX + ats-text derive from the same `TailoredCV` +
`template-tokens.ts`. The backend never renders; it calls these routes server-to-server.

## Options considered

- **Python rendering (WeasyPrint + python-docx)** — rejected: forks the template, weaker layout
  fidelity, no mature DOCX equivalent to the `docx` lib.
- **Node render sidecar (3rd service)** — rejected for ship-fast: extra deploy + template sharing.
- **Next.js render routes co-located with the template (chosen)** — preview = PDF by construction;
  Chromium lives in one image; zero extra service.

## Consequences

- Chromium + fonts ship in the frontend image; pin both for byte-stability (`renderer.md`).
- Next.js gains a tiny server surface (3 render routes only) — acceptable; no business logic there.

## Links

`docs/architecture/renderer.md`, ADR 0001, `docs/invariants.md` (3).
