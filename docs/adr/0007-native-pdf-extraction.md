# ADR 0007: Native PDF ingestion via Claude document blocks

Status: accepted  
Date: 2026-06-24

## Context

The ingestion pipeline (CV / LinkedIn → master profile) must read PDFs the candidate already has:
LinkedIn "Save to PDF" exports (multi-column) and old CVs (sometimes scanned images). Plain
text extraction (`pypdf`) garbles multi-column layouts and returns nothing for scanned images — so
text-only extraction would fail on a meaningful fraction of the stated inputs.

The shared `ProviderRunner` is text-in (`system: str`, `user: str` → typed output). The Extractor
needs the model to *see* the document, while every agent still returns provider-enforced structured
output (invariant 5) and the authoring/adjudication provider split holds (invariant 6).

## Decision

Extend the shared agent plumbing with an **optional, provider-neutral `Document`** (a base64 PDF):

- `ProviderRunner.__call__` gains `document: Document | None = None` and `max_tokens: int`.
- `run_claude` sends the PDF as a native **`document` content block** ahead of the text prompt, in
  the **same** `messages.parse(output_format=…)` call — so the PDF and the structured-output schema
  travel together. `run_openai` accepts-and-ignores `document` (the OpenAI adjudicators are text-only
  — the PDF is read only by the Claude Extractor, invariant 6).
- `Agent` gains a per-agent `max_tokens` (default `DEFAULT_MAX_TOKENS = 8000`); the Extractor over a
  full multi-page CV is the agent most likely to truncate, so it can raise its budget.
- `pypdf` is kept (PR-C) only as a **best-effort text copy** for audit / evidence-verification / a
  page-and-size guard — not the extraction path.

## Options considered

- **`pypdf` text extraction only** — no provider-abstraction change, but garbles multi-column and
  can't OCR scanned CVs; fails on half the stated inputs. Rejected as the primary path.
- **Claude native document blocks (chosen)** — reads multi-column and scanned PDFs directly and
  preserves structured output. Cost: widens the shared `ProviderRunner` for one provider, and the
  acceptance of *(PDF document block + `output_format`) in one call* is a real-API question a fake
  cannot answer.
- **A separate multimodal runner / per-provider split** — more surface than needed; the optional
  kwarg keeps one runner signature and one routing path.

## Consequences

- One optional `document` kwarg threads through `Agent` → `run_agent` → `ProviderRunner` →
  `run_claude` / `run_openai` / `get_runner`; every test fake is forward-compatible (absorbs the new
  kwargs). No caller passes a document yet — the Extractor wires it in PR-C, capability-ahead-of-
  caller (as the OpenAI path shipped ahead of its first adjudicator).
- **Verification gap (declared, not a pass):** the mocked tests assert the constructed payload shape
  (a `document` block + the text block, `max_tokens` forwarded) but cannot prove the API *accepts*
  the combination. `backend/tests/test_providers.py::test_run_claude_live_pdf_spike` makes the real
  call; it is **skipped** until `TEST_ANTHROPIC_KEY`, `TEST_ANTHROPIC_MODEL`, and `TEST_PDF_PATH` are
  set. Run it once with a real key before PR-C depends on native PDF.
- **Fallback:** if the live spike shows the combination is rejected (or unreliable on scanned PDFs),
  the documented fallback is `pypdf`-text → the existing **text-in** Extractor — the plumbing already
  supports a text-only Extractor, so only the route's input changes.
- **Update (PR-C):** the document caller has landed (`POST /workspaces/{id}/ingest/file` →
  `routes/ingest.py`), so "no caller passes a document yet" above is now historical. PR-C adds a
  **per-request native→text-only retry** in `_extract` (drop the PDF block and re-run over the pypdf
  text on a `BadRequestError` — the 400 for an unprocessable document / "schema too complex" — or an
  `AgentParseError`, only when that text is non-empty; transient 429/timeout/5xx propagate as 502
  instead) — runtime resilience for a single upload, **distinct** from the spike-failure "make
  pypdf-text the primary path" fallback above. pypdf (`ai/pdf_text.py`) is the audit/evidence text + the 10 MiB / 30-page guard, not the
  extraction path.

## Spike outcome (run with a real key)

- **Native PDF block + `output_format` is ACCEPTED** — `messages.parse` with a base64 PDF `document`
  block and a *small* output schema returned valid structured output (extracted the name from a sample
  PDF). The native path is sound; no fallback to pypdf-text-as-primary needed.
- **But the full `ExtractedProfile` schema is REJECTED** — `400 "Schema is too complex"`, on **both**
  the PDF and the text path (so it's the output schema, not the document). The core product's
  `TailoredCV` schema is accepted → the limit is ingestion-specific.
- **Resolution:** the Extractor is split into **three sequential section-scoped structured-output
  calls** (basics / work / qualifications) merged into `ExtractedProfile` — see `ai-panel.md`.
- **Update (live spike finally run with a key, 2026-06-25):** the split ALONE was not enough — the
  basics call still 400'd, intermittently as **"Schema is too complex"** OR **"Grammar compilation
  timed out"**. Isolating each sub-schema overturned the original "prop/def/anyOf count" theory: the
  real driver is **optional-field count in one object** — the grammar compiler encodes every
  presence-subset (~2^N) of optional fields, so the *smallest* schema (basics: 13 props, 0 anyOf, but
  ~11 OPTIONAL `str = ""` fields) timed out while larger but mostly-required schemas (`qualifications`
  17/3, `TailoredCV` 19/5) compiled fine. **Fix:** make `RawBasics` fields **REQUIRED** (the model
  emits `""`/`[]` for absent; `run_extract` maps `"" → None`) — the grammar collapses to one fixed
  shape. After the fix the full 3-schema + native-PDF spike passes in ~15 s (was a ~180 s timeout).
- **Forward risk:** PR-E's Reconciler/Judge outputs hit the same ceiling — design per-section/per-unit
  and **minimise optional fields** (required + `"" / []` sentinels beat optional), then re-spike.

## Links

`backend/app/ai/providers/{base,anthropic,openai}.py`, `backend/app/ai/agents/{types,registry}.py`,
`backend/tests/test_providers.py`, `docs/ai-panel.md`, `docs/architecture/api.md`.
