# CLAUDE.md — Claude Code wrapper

@AGENTS.md

Status: Claude Code-specific harness mapping. Canonical shared guidance lives in `AGENTS.md` — read
it first. This file holds only Claude-specific mechanics that aren't portable to other agents. Do
not duplicate `AGENTS.md` rules here.

## 1. Authority

- `AGENTS.md` is the source of truth for repository behaviour, invariants, the local quality gate,
  the doc-impact checklist, and the self-update protocol.
- Nested `backend/AGENTS.md` and `frontend/AGENTS.md` govern their subtree's toolchain.
- If guidance seems missing, it belongs in `AGENTS.md`.

## 2. Plan mode

Use plan mode for multi-file, architecture, schema, security, render-path, or ambiguous changes.
Skip it for tiny, obvious edits.

## 3. Harness mapping

### Playwright MCP (live preview verification)

`AGENTS.md` §6 is canonical. Claude-specific mechanics:

- A `playwright` MCP server, when declared in `.mcp.json`, surfaces as `mcp__playwright__*` tools.
- Before navigating to `http://localhost:3000`, ensure the frontend dev server is running
  (`pnpm --dir frontend dev`). Start once and reuse.
- Never add Playwright MCP usage to `node scripts/quality-gate.mjs`. Verification is an agent
  obligation surfaced in the final response, not a gated step.

### Deferred tools / connectors

Many tools (M365/Graph, provider SDK equivalents) load via `tool_search`, not the static list.
Search before assuming a capability is unavailable. Keep provider calls behind `app/ai/providers/`
regardless of how the tool surfaces.

## 4. Self-update

Follow `AGENTS.md` §15. The `guidance-self-update` doc-impact rule applies to changes in this file
too — a CLAUDE.md edit needs a `docs/agent-guidance-changelog.md` entry.
