# Runbook: local stack + live Playwright verification of the ingest flow

Status: active
Last updated: 2026-07-03

## When to use

You need to drive the real app in a browser — e.g. the owed live verification of PR-F (the F3b SSE
ingest run) and the E1/E2 ingest states (AGENTS.md §6). This stands up the **whole stack on one
machine with no Postgres, no email, and no SSO**, logs in, seeds your provider keys, and drives
the import flow via Playwright MCP — the **"Add source" modal on `/master`** since C4 (`/ingest`
survives only as a redirect to `/master?import=1`). The browser drive in step 5 may need a **fresh**
agent session — see the ⚠️ blocker below. Cleanup is a few local files plus Ctrl-C.

## ⚠️ The one blocker: Playwright MCP needs a restart

`mcp__playwright__*` tools only load when Claude Code **starts** and reads `.mcp.json` (and trusts the
server). `.mcp.json` is committed (root), but **a session that was already running when it changed
will NOT have the tools** — you must start a fresh Claude Code session in this repo and approve the
`playwright` MCP server when prompted. Until then, steps 1–4 work headlessly (curl). Chromium is
already cached at `~/.cache/ms-playwright`; on first launch `npx @playwright/mcp@latest` may fetch its
matching build (one-time, ~150 MB).

`.mcp.json` runs the server `--headless --isolated`, so the browser drive needs **no X display** (an
earlier headed run died when an SSH-forwarded display dropped) and starts from a clean profile each
session. You can't watch it live; drive it with `browser_snapshot` / `browser_take_screenshot`. If
`mcp__playwright__*` is still absent after a restart, you can drive Chromium headless directly from a
Node script via `frontend/node_modules/playwright` (`chromium.launch({headless:true})`, inject the
`contender_session` cookie with `ctx.addCookies`) — the same engine the PDF render route uses.

## Prepare local state

- Copy `backend/.env.example` to `backend/.env`. Set `ENVIRONMENT=development`,
  `DATABASE_URL=sqlite+aiosqlite:////tmp/contender-dev.db`, `COOKIE_SECURE=false`, and
  `ALLOWLIST_EMAILS=owner@example.com`. Generate a fresh `SECRETS_ENCRYPTION_KEY`; never reuse a
  production encryption key. Leave Resend and Entra unset for this local drive.
- Copy `frontend/.env.example` to `frontend/.env.local`; its default
  `BACKEND_INTERNAL_URL=http://127.0.0.1:8000` is suitable locally.
- `.mcp.json` declares the tracked Playwright MCP server (`--headless --isolated`) and contains no
  secret.
- Install backend and frontend dependencies as described in the root README. Install the matching
  Playwright Chromium build if it is not already cached.

## Steps

### 1. Start the backend (terminal A)

```bash
cd backend && uv run uvicorn app.main:app --reload
```

Leave it running — the magic-link login URL prints **here**. Logs are `console` format (set in
`.env`) so the link is easy to spot. Once the DB file exists it will hold the encrypted provider key,
so tighten its perms: `chmod 600 /tmp/contender-dev.db`.

> **Backgrounding warning:** `nohup uv run uvicorn … & echo $!` captures the PID of the **uv
> wrapper**, not uvicorn — killing that PID orphans the real listener and leaves :8000 busy. If you
> background the server, kill the actual listener PID (find it with `ss -ltnp 'sport = :8000'`) and
> wait for the port to free before restarting.

### 2. Start the frontend (terminal B)

```bash
cd frontend && pnpm dev      # :3000 — proxies /auth/*, /ai/*, /admin/*, /workspaces/* to :8000
```

### 3. Log in as owner

**Browser path (for the Playwright drive):** visit `http://localhost:3000`, request a link for
`owner@example.com`, copy the `http://localhost:3000/auth/magic/callback?token=…` line from
terminal A, open it in the browser. The session cookie is now set on the `localhost:3000` origin.

**Headless path (for curl seeding / scripts):** logs in against the backend directly and saves a
cookie jar:

```bash
JAR=/tmp/contender-cookies.txt
curl -s -X POST http://127.0.0.1:8000/auth/magic/request \
  -H 'Content-Type: application/json' -d '{"email":"owner@example.com"}'
# grab the newest token printed in terminal A, then:
TOKEN='<paste-token>'
curl -s -c "$JAR" "http://127.0.0.1:8000/auth/magic/callback?token=$TOKEN" -o /dev/null
curl -s -b "$JAR" http://127.0.0.1:8000/auth/me      # -> {"email":"…","role":"owner"} (role is vestigial — always "owner")
```

### 4. Seed a real provider key + assign the strong tier

All ingest agents run on the **strong** tier (extractors + reconciler → Anthropic; Judge → OpenAI).
Export `TEST_ANTHROPIC_KEY`, `TEST_ANTHROPIC_MODEL`, `TEST_OPENAI_KEY`, and `TEST_OPENAI_MODEL` in
your shell, or place them in a gitignored `backend/.env.secrets` file. The ingest route's preflight
**503s only on an unset Anthropic strong tier**
(model resolution); a tier set but a key missing/undecryptable surfaces later as a **failed run
card**, not a 503 — and an OpenAI/Judge problem never blocks the route at all (the Judge is
advisory and degrades to "suggestions unavailable"). Seed both anyway for the full drive.

```bash
set -a; . backend/.env.secrets; set +a          # load TEST_* into env (do not echo them)
JAR=/tmp/contender-cookies.txt

# Seed keys WITHOUT putting them on the command line (argv is visible via `ps` and lands in shell
# history). Pipe the JSON body in on stdin instead. (Model ids below are not secret, so plain -d.)
seed_key() { printf '{"apiKey":"%s"}' "$2" | \
  curl -s -b "$JAR" -X PUT "http://127.0.0.1:8000/admin/providers/$1/key" \
       -H 'Content-Type: application/json' --data-binary @-; echo; }
seed_key anthropic "$TEST_ANTHROPIC_KEY"   # required for first-import AND re-import
seed_key openai    "$TEST_OPENAI_KEY"      # only needed for the re-import Judge badges

# Assign the strong tier. NOTE: PUT .../models is a FULL REPLACE — omitting fast/cheap nulls them
# (fine here; every ingest agent is strong-tier). The model id must match an id from
# GET /admin/providers -> availableModels EXACTLY, or it 422s and the tier stays unset.
curl -s -b "$JAR" -X PUT http://127.0.0.1:8000/admin/providers/anthropic/models \
  -H 'Content-Type: application/json' -d "{\"strong\":\"$TEST_ANTHROPIC_MODEL\"}"
curl -s -b "$JAR" -X PUT http://127.0.0.1:8000/admin/providers/openai/models \
  -H 'Content-Type: application/json' -d "{\"strong\":\"$TEST_OPENAI_MODEL\"}"

# CONFIRM both show isSet:true AND a non-null tierStrong BEFORE driving a run:
curl -s -b "$JAR" http://127.0.0.1:8000/admin/providers
unset TEST_ANTHROPIC_KEY TEST_OPENAI_KEY TEST_ANTHROPIC_MODEL TEST_OPENAI_MODEL   # scrub from env
```

**Cost control:** the default strong model is Opus-class. This run verifies *UI behaviour*, not
extraction quality — point the strong tier at the cheapest capable model the provider lists
(`GET /admin/providers` → `availableModels`) before driving runs. Each ingest call costs real money:
~3 Anthropic calls (first import) / ~4 Anthropic + 1 OpenAI (re-import).

### 5. Drive the import modal via Playwright MCP (fresh session only)

Navigate to `http://localhost:3000/master` and open **"Add source"** (or hit
`http://localhost:3000/ingest`, which redirects to `/master?import=1` and auto-opens the modal), at
desktop width and at 375–430 px. Owner-only.

Data setup (no workspace-creation endpoint — `default` workspace is implicit for the owner):
- **First-import / net-new:** start with no master. Paste a CV with at least a **name and email** —
  the only two Apply-blocking (red) fields since the PR #30 Basics relax; label/phone/location/
  summary are **recommended** (a yellow nudge, never a 422). A fuller identity + a summary still
  make the nicest demo. Plus ≥1 role, e.g.
  `Sample Candidate · Integration Manager · candidate@example.com · +00 0000 000 000 · Example City. About: integration lead with experience across logistics platforms.`
  followed by a work block. Or upload a PDF (≤10 MB, ≤30 pages) — no PDF fixture exists in-repo, make
  a small one.
- **Re-import / enrich + correct:** first `PUT /workspaces/default/master` a master with existing
  work (reuse `backend/tests/factories.py::sample_master_profile`), then paste/upload an overlapping
  doc so the reconciler emits enrich (new highlights on a matched role) + correction (differing
  identity field) proposals alongside net-new.

## Verification (report per AGENTS.md §6 — routes + states)

**F3b streaming (new):** per-agent checklist updates incrementally
(extractor-basics/work/qualifications → reconciler-work + judge on re-import); bundle lands on
RunDone; "Stop & check my imports" (after the checklist populates) discards the run cleanly; a forced
stream drop / failed run shows the right card; reduced-motion + focus honoured; SSE flushes
incrementally through the Next proxy.

**E1/E2 states:** first-run net-new build → `/workspace` full profile; re-import enrich (named
target) + correction (`.ingest-cols` current-vs-proposed, stacks ≤640 px); "nothing new"; "Add all
new items" does NOT sweep enrich/correction; Judge badges (Worth a look / Suggested skip) **each with a visible
reason line** (generic fallback when the Judge gave an empty reason) + degraded
"suggestions unavailable"; an **unverified** evidence item shows its visible "couldn't find this text"
note (not a hover-only tooltip); applied enrich shows `sourceId` on re-tailor; blocking cards — apply 409
(stale), 422 (identity), partial-apply ✓/⚠, 409 `reloadKeepingDrafts`, focus after
bulk/apply; **close-and-reopen recovery** — the modal has no `?run=` deep-link (C4): reopening
"Add source" resumes the server's open run (review or "still running"), with the recent-imports
list as the backup path. **Apply/Discard confirmation is an in-app focus-trapped modal (Escape works), never a
native popup; a blocked/failed apply (422/409/error) scrolls into view + takes focus** — and with zero
accepted items the disabled Apply reads clearly (prominent "accept one item" hint).

Also confirm the **preview == exported PDF** for any rendered output (invariant 3).

## Teardown / cleanup

```bash
# Ctrl-C terminals A and B (or: pkill -f 'uvicorn app.main:app'; pkill -f 'next dev')
rm -f /tmp/contender-dev.db*       # the * also clears any -journal/-wal a kill -9 left behind
rm -f /tmp/contender-cookies.txt
```

The seeded provider key lives **only** inside `/tmp/contender-dev.db`, encrypted with the one-off
`SECRETS_ENCRYPTION_KEY` in `backend/.env` (NOT the public dev key) — deleting the DB removes the only
stored copy. `backend/.env` + `frontend/.env.local` are gitignored and safe to keep. `.mcp.json` is
tracked — leave it. Reclaim Chromium with `rm -rf ~/.cache/ms-playwright` (optional; reusable).

## Footprint

New on disk: one SQLite file (~0.1–10 MB), two gitignored env files, and the `@playwright/mcp` npx
cache (~tens of MB) — `.mcp.json` is tracked, not new. **No new Chromium download** unless the MCP's
bundled Playwright wants a different build. Processes: two dev servers + an ephemeral headless Chromium.
No Docker, no Postgres, no port besides 3000/8000. **SQLite is single-writer** (no `busy_timeout`
set): fine for a single-user manual drive, but fire ingest runs one at a time or you may hit an
occasional `database is locked`.

## Rollback

This runbook starts nothing persistent. To fully revert: stop both servers, run the cleanup block,
and `rm backend/.env frontend/.env.local`. Nothing in the tracked tree changes (`.mcp.json` is a
committed part of the repo).
