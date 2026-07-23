# AI Panel

> **Disambiguation.** This documents the *product's* AI reviewer panel. The *coding agents* that
> build this repo (Claude Code, Codex) are governed by `/AGENTS.md`. Two different senses of "agent."

## What an agent is

Not a framework. A pinned config exposed as a typed function:

```
provider + tier + system prompt + output schema (Pydantic)
```

No sampling params anywhere: `Agent` carries none and the runners send none (see the per-provider
notes below) — determinism comes from the structured-output contract.

Definitions live in `backend/app/ai/agents/<id>.py`; `registry.py` routes by provider. The output
schema is enforced by the provider's **structured outputs**, so a malformed response is impossible —
typed JSON or a surfaced error, never parsing gymnastics.

### Model selection (admin-managed, not pinned)

An agent declares a **provider + tier** (`strong`/`fast`/`cheap`), not a model string. The tier
resolves to a concrete model id at call time from the DB tier map the owner sets in the Admin Menu
(ADR 0006); `registry.get_model_resolver` does the lookup and fails closed (`ModelTierUnset` → 503)
when a tier is unassigned. Provider clients are built from the DB-stored (encrypted) key
(`providers/clients.py`) — never an env singleton. Both the runner and the resolver are injectable
FastAPI dependencies, so route tests stay offline. **Tiers are strong-only today:** every shipped
agent declares `strong`; `fast`/`cheap` are deliberate ADR 0006 headroom (assigning them a model has
no effect until an agent declares one).

### On Anthropic (Claude) — authoring

`client.messages.parse(model=..., output_format=PydanticModel)` returns `.parsed_output` as a
validated instance (GA). Check `stop_reason == "refusal"` before reading content. Opus 4.8 rejects
sampling params — no sampling params are sent (the runner signature carries none).
Wrapper: `backend/app/ai/providers/anthropic.py`
(`make_anthropic_client`, `list_anthropic_models`, `run_claude`).

A multimodal agent may also pass a **`Document`** (a base64 PDF): `run_claude` sends it as a native
`document` content block ahead of the text prompt in the **same** `messages.parse` call, so the PDF
and the enforced `output_format` travel together (ADR 0007). `Agent` carries a per-agent `max_tokens`
(default 8000) for agents whose output is large. The `document` and `max_tokens` thread
`Agent` → `run_agent` → `ProviderRunner`; the OpenAI runner accepts-and-ignores `document` (the
adjudicators are text-only — invariant 6). The ingestion **Extractor** is the first such agent. On
the native-PDF path its text prompt is a **neutral placeholder** (`NATIVE_PDF_INPUT`) — the PDF *is*
the input, so the pypdf-extracted text is kept for evidence/fallback only and is never placed in the
prompt beside the PDF (a garbled multi-column extraction would otherwise give the model two rival
readings).

### On OpenAI — adjudication

Structured outputs via the **Responses API** `client.responses.parse(..., text_format=PydanticModel)`
→ `output_parsed` (non-beta surface; SDK version: see `backend/uv.lock`). No sampling params are sent
— a tier may resolve to a reasoning/o-series model that rejects them. Wrapper:
`backend/app/ai/providers/openai.py` (`make_openai_client`, `list_openai_models`, `run_openai`).

## The panel

| Agent | Provider | In | Out (schema) | The one rule |
|---|---|---|---|---|
| **Parser** | Claude | raw job text | `ParsedJobSpec` | Extract only (no owner fields). Flag vague/contradictory language as `redFlags`. `/ai/parse` upgrades the result to the wire/persisted `JobSpec` (which adds the owner-supplied `postingUrl`). |
| **Tailor** | Claude | `MasterProfile` + `JobSpec` (+ prior) | `TailoredCV` | Reweight & reword **real facts only**. Every bullet gets `sourceId` + a stable `bulletId`. Net-new ⇒ `origin: net-new`, `needsSignoff: true`. |
| **Editor** | OpenAI | `TailoredCV` + `JobSpec` | `EditorReport` | Line-edit critique anchored to a stable id (the CV JSON carries them; ADR 0010). Critique, don't rewrite. |
| **Fact-Checker** | OpenAI | `TailoredCV` + `MasterProfile` | `FactCheckReport` | Every claim must trace to a master bullet. `supported`/`unsupported`/`overstated`. |
| **AI-Language Spotter** | deterministic + Claude | `TailoredCV` | `SlopReport` | Heuristics first (frontend), model pass for the subtle stuff. Match the operator's voice. |
| **Gatekeeper** | OpenAI | `TailoredCV` + `JobSpec` + master `languages` | `GatekeeperVerdict` | Be the recruiter/ATS, not a coach. Judge against *this* posting (the stored `cv_job_specs`). Don't invent qualifications. Declared master languages count as evidence for language must-haves (DevPR42) — the Editor deliberately does not receive them; the Fact-Checker already sees them via the full master JSON. |
| **Corrector** | Claude | accepted **bullet** contexts (`currentText` + `masterText` + threads) | `{bulletId → text}` per bullet | **Per-bullet** (DevPR29): only the accepted bullets go in and only their revised text comes back — latency scales with edit size, not CV size. Reword-in-place: keep the same fact + stored `sourceId`. Because the output is text-only (never structure), there's nothing to add/drop/re-parent, so `assert_structure_preserved` is gone; a missing accepted id / blank / oversized text → **422** (splice), a duplicate id → **422** (route), an unknown id is ignored. The **server** splices the accepted bullets onto the stored CV, re-grounds them, and bumps `version`/`parentVersion` on save — never the model. |
| **Extractor** | Claude | a CV / LinkedIn document | `ExtractedProfile` (assembled from 3 section calls) | Extract only — verbatim, `evidence` per unit, never mint ids/dedup. Runs as **3 sequential structured-output calls** (basics / work / qualifications) merged in `run_extract` — the full `ExtractedProfile` schema is rejected by the API as "too complex" (see below). The **qualifications** call emits education / skills / **languages** (D2a: `ExtractedLanguage` = name + optional fluency) — **no certificates since DevPR31** (nothing renders or edits them, so proposing them sent accepted data into a black hole; the apply-time merge stays for persisted pre-DevPR31 runs). |
| **Reconciler** | Claude | extracted work + master work entries | `WorkReconciliation` (a list of `{extractedIndex, masterWorkId}`) | Classify which extracted roles ARE an existing master entry, **by index only** — no prose, never re-emit content. The server re-grounds each match + diffs highlights server-side (ADR 0008). Runs only when both sides have work. |
| **Judge** | OpenAI | the server's reconciled proposals | `JudgeReport` (a list of `{proposalId, verdict, reason}`) | Recommend include / exclude / needs-review per proposal — **advisory only**: never gates apply or the bulk net-new add; an omitted/unknown id or an OpenAI outage → needs-review (the run still reaches review). The first OpenAI agent. |

**Status.** P2 landed the agent framework (`Agent`, `run_agent`, the injectable `ProviderRunner` —
`backend/app/ai/agents/`), the Anthropic wrapper (`providers/anthropic.py`), and the **Parser** agent,
wired to `POST /ai/parse`. The OpenAI wrapper (`providers/openai.py`) + admin-managed provider config
(DB-encrypted keys, dynamic model tiers — ADR 0006) followed. P3 landed the **Tailor** agent
(`agents/tailor.py`), wired to `POST /workspaces/{id}/cv` (persists via the CV store; the stateless
`POST /ai/tailor` was later removed — no product consumer), plus the **provenance + sign-off gate**
(invariant 2) end-to-end and the render
path fetching real CVs (see `architecture/renderer.md`). The first SSE surface has landed on
**ingestion** (the synchronous run streams per-agent progress under `Accept: text/event-stream`,
reusing `schema/sse.py`); the review fan-out reuses the same events. The OpenAI **adjudicators**
(Editor / Fact-Checker / Gatekeeper) have landed, and the **Corrector** followed (PR #38/#39, then
per-bullet in DevPR29 via PR #54 / ADR 0014). **PR-0 spike RUN &
GREEN (2026-06-27):** the review wire schemas (`EditorReport` / `FactCheckReport` / `GatekeeperVerdict`
via OpenAI `responses.parse`; `SlopReport` + a Corrector→`TailoredCV` round-trip via Anthropic
`messages.parse`) compile on the live APIs as-is despite their optional density — so the adjudicators
reuse `schema/reviews.py` unchanged (no per-section split needed). **PR-1b landed the Gatekeeper**
(`agents/gatekeeper.py`, OpenAI). **PR-2a landed the fan-out:** the **Editor** (`agents/editor.py`,
OpenAI — line-edits against the posting), **Fact-Checker** (`agents/fact_checker.py`, OpenAI — per-claim
supported/overstated/unsupported, `sourceId` validated server-side against the anchored item's source
work, see Orchestration), and **AI-Language Spotter** (`agents/spotter.py`, Claude — voice/slop flags),
orchestrated by `agents/review.py::run_review`. `POST /workspaces/{id}/cv/{cv_id}/review` (owner-only)
is content-negotiated: blocking → the full `ReviewBundle` (all applicable reports + `failures`); SSE
(`Accept: text/event-stream`) → `AgentStarted`/`AgentReport`/`AgentDone` per agent + a terminal
`RunDone`. Both arms run the same fan-out and are advisory (never gate export); a no-job draft runs only
the job-independent Fact-Checker + Spotter. The **Corrector** + `…/apply` landed next (PR #38/#39;
now **per-bullet** — DevPR29/ADR 0014, see the roster row above): apply resolves only the applied
bullets' notes and keeps the other advisories + decisions.

The **ingestion** pipeline has landed its first agent — the **Extractor** (`agents/extractor.py`,
orchestrated by `agents/ingest.py`), wired to `POST /workspaces/{id}/ingest`: paste a CV / LinkedIn
document → extract → net-new proposals → owner accept/decline/edit → the master is **built**
server-side (`app/ai/ingest_apply.py`, under the per-workspace advisory lock). The Extractor takes an
optional PDF `document` block (ADR 0007). PR-E added the **Reconciler** (`agents/reconciler.py`):
when a master already exists, it matches extracted roles to existing entries (by index) so the server
can build `enrich` / `correction` / `net-new` proposals and re-ground every target (ADR 0008). PR-E E2
added the advisory **Judge** (`agents/judge.py`) — the **first OpenAI agent in the repo** —
recommending include / exclude / needs-review per proposal; advisory only (it never gates apply nor
the bulk net-new add, and degrades to a visible "suggestions unavailable" needs-review on an OpenAI
outage, so the run always reaches review).

PR-F made the synchronous run **observable**: `run_extract` and `run_ingest` take an optional
`progress` callback; the streaming route threads one in to emit an `AgentStarted`/`AgentDone` per agent
(the advisory Judge always reports `ok=true` — a degrade is "done", not "failed") then a terminal
`RunDone{ok, resultRef}`. DevPR33 added **`AgentProgress` status notes** on the same stream: one
owner-facing sentence (label voice — it renders verbatim in the ImportModal's aria-live status
line) per extractor pass ("Contact details captured", "Found N roles in your work history",
"Education, skills & languages captured") and around the reconciler/Judge legs (incl. a quiet
Judge-degrade note). Each note precedes that agent's terminal `AgentDone`, and a note never
precedes the run's first `AgentStarted`. The review fan-out deliberately emits none (concurrent
adjudicators share one status line — review-side progress is future UX work). `progress=None` (the
JSON path) is the unchanged blocking pipeline. Each provider call also logs its `agentId` + outcome
(AGENTS §8).

**Why the Extractor is three calls.** A live ADR-0007 spike showed the real Anthropic API rejects a
single `messages.parse(output_format=ExtractedProfile)` (**400 "Schema is too complex"** /
**"Grammar compilation timed out"**, on both text and native-PDF paths). The driver is **optionality,
not raw size**: the structured-output grammar compiler must encode every presence-subset of an
object's OPTIONAL fields (~2^N), so an optional-dense schema blows its time budget. Confirmed live — a
section with MORE props/defs but mostly-required fields (`qualifications`: 17 props/3 defs, and the
core product's `TailoredCV`: 19 props/5 defs) compiles fine, while the *smaller* but optional-dense
basics (13 props, 0 anyOf) did NOT. Fix: `run_extract` issues three section-scoped calls —
`basics_extractor` (→ `RawBasics`, every field **REQUIRED**; the model emits `""`/`[]` for absent and
`run_extract` maps `"" → None`), `work_extractor` (→ `ExtractedWorkList`), `qualifications_extractor`
(→ `ExtractedQualifications`) — **sequentially** (the request `AsyncSession` the resolver/client use is
not concurrency-safe) and merges them into `ExtractedProfile`. The containers are **internal agent I/O**
(defined in `agents/extractor.py`, kept off the wire/OpenAPI surface) but `extra="forbid"` so a section
call can't silently absorb another's fields (invariant 5). Forward risk: PR-E's Reconciler/Judge
outputs must be designed under the same budget — **minimise optional fields**, not just prop count.
**D2a (languages):** `languages` (`ExtractedLanguage` = required `language` + one optional `fluency`)
folds into the existing `qualifications_extractor` call rather than a fourth call — a single optional
scalar keeps the schema well under the cliff. **Re-spiked GREEN** against a real key
(`test_run_claude_live_languages_extractor_spike`) — the fake runner returns a canned object and
can't prove the API still accepts the grown schema; the live spike does (the slice's acceptance gate).

**Server-side provenance (the gate's boundary).** Tailor proposes `origin`/`sourceId` per bullet, but
the server is the authority (`backend/app/ai/provenance.py`, run by `run_tailor` before persistence):
a bullet is grounded only when its `sourceId` is a `Highlight` of **its own item's source work
entry** — a bullet pointing nowhere, or at another employer's highlight (the renderer attributes
employer/dates from the item's `sourceId`, so that would misattribute experience), is forced to
`origin: net-new`, its `sourceId` nulled, and `needsSignoff: true`, which blocks export until the
candidate signs off. We trust the cosmetic verbatim-vs-reworded label only when the `sourceId` is real
*and under the right item*, and do **not** text-diff against the master bullet, so catching an
*overstatement on a real source* is the **Fact-Checker/Editor** layer's job, not the gate's. Blank or
duplicate stable ids are rejected (422) before anything is stored, so reviewer anchoring (ADR 0003)
holds.

## Orchestration

Parser → Tailor are sequential (Tailor needs the JobSpec). The review **fans out**
(`agents/review.py::run_review`): the Fact-Checker + Spotter (job-independent) always run, and the
Gatekeeper + Editor join when the CV targets a job; all run concurrently via `asyncio.gather` and each
emits an `AgentReport` SSE event as it reports in, so the reviewer panel lights up incrementally.
**Concurrency seam (R2):** the `AsyncSession` is not concurrency-safe, so a naive gather that each
agent's `resolve()` + cold-cache client build would 500 in prod. `agents/registry.py::build_panel_runner`
resolves both tiers + builds both provider clients **serially up front** (the only session work) and
returns a **session-free** `(runner, resolve)` pair, so the gather is network-only; the streaming route
preflights it on the request session (a missing key / unset tier → a clean 503 before the 200).
**Per-agent degrade (dec #5):** each member self-degrades — a provider/agent failure becomes an
`AgentFailure` (+ `AgentDone(ok=false)`), never cancelling siblings; a real bug propagates (no blind
catch). The gather materialises `asyncio.Task`s so that on such an unexpected escape it **cancels and
awaits** the still-running siblings before re-raising — their billed provider calls don't leak past
the failure — without `return_exceptions` masking the bug. Each adjudicator's output passes a server-authority pass before it's surfaced (Gatekeeper score
clamp + thread grounding; the Fact-Checker validates each thread's `sourceId` **per-item** against the
anchored item's source-work highlights — ids are unique only within a work entry — and downgrades an
unbacked claim to `unsupported`). Prompt-cache the stable prefix (the `MasterProfile` / `TailoredCV`
JSON — ADR 0010) across the cycle (**deferred** — see the cost note in `architecture/observability.md`).

## The slop detector, split

- **Deterministic** (`frontend/src/slop/heuristics.ts`): overused lexicon, em-dash density,
  "not just X, it's Y", adverb openers, low sentence-length variance, tricolon stacking. CV-aware —
  normal action-verb openers are not flagged. Runs on every keystroke, free, client-side.
- **Model** (Spotter agent, Claude): tonal blandness, faux-confidence, off-voice phrasing that's
  individually clean. Then the voice rewrite, primed on real samples of the operator's writing.

**Framing:** voice-matching, not "beat the AI detector." Third-party detectors are unreliable;
optimising against them is a trap. Reading like the operator and passing a recruiter's smell test is
the real target.

## Interface voice (copy rules for any UI text agents surface)

- Active voice. Name things by what the user controls, not how the system is built.
- An action keeps its name through the flow: **Tailor** → toast **Tailored**.
- Errors don't apologise and are never vague: say what happened and the fix.
- Empty states are invitations to act, not décor.
