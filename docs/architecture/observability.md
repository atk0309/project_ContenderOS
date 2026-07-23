# Observability

Status: active — seed doc  
Last updated: 2026-07-22

## What exists today

- **Per-agent-call log line.** Both provider wrappers (`app/ai/providers/{anthropic,openai}.py`)
  emit one structured `agent_call` line per call. A **successful** call logs agent id (threaded from
  `run_agent` through the `ProviderRunner`), provider, model, input/output token usage, latency, the
  provider's raw terminal signal (`stop=` for Anthropic / `status=` for OpenAI, kept alongside), and
  a classified `outcome=` field: `ok | refusal | truncation | schema-parse-fail | error`. The
  classification mirrors what the wrapper raises: a `content_filter`-incomplete response classifies
  as `truncation` because `AgentTruncated` is what is raised for any incomplete status;
  `schema-parse-fail` is claimed only when the returned response ended normally yet carries no
  parsed output. A pydantic `ValidationError` raised inside `.parse(` logs the generic
  `outcome=error err=ValidationError` and propagates unchanged — both SDKs validate the model's
  text regardless of the terminal state (anthropic `lib/_parse/_response.py`, openai
  `lib/_parsing/_responses.py`), so it can equally be a truncation's partial JSON; the terminal
  signal is unreachable on the raise path, and `err=ValidationError` is the honest signal. Any
  other **SDK-raised failure** logs an error-only line (agent/provider/model/latency +
  `outcome=error err=<type>` — no response exists, so no tokens/signal).
- **JSON log formatting for Railway.** `app/logging_config.py` + `backend/log_config.json` (loaded
  by uvicorn via `--log-config`) format every line as one-line JSON so Railway reads the real
  `level` from the payload instead of colouring by stream; the `LOG_FORMAT` env knob selects
  `json`/`console` (local dev defaults to readable console lines). See `deployment.md` §Logging.
- **Targeted event lines** where a silent failure would be costly: review settle-time save
  failures/supersessions and per-agent degrades (`contender.review` / `contender.cv`), and the
  ingest native-PDF fallback + Judge degrade (`contender.ingest`).
- **Application lifecycle lines** (`contender.applications`, in `persistence/application_store.py`):
  created, stage change, recruiter updated, deleted.

## Still guidance (not yet emitted)

Other important state transitions — tailor run, review started/settled, accepted correction,
export — have no dedicated log lines yet (only the failure-path lines above). Add them as work
touches those routes.

## Per-job cost (optional, recommended)

Each application fires ~6–7 agent calls across two providers; the `agent_call` lines carry the
token usage to aggregate. There is no cost table yet — a future `agent_runs`-style aggregate (and
surfacing cost in the UI) remains an option once cost is measured. The other levers stay deferred:
prompt caching of the stable prefix (the `MasterProfile` / `TailoredCV` JSON the adjudicators read
— ADR 0010 is why they read structured JSON; caching itself is deferred indefinitely) and demoting
a high-volume agent to the `cheap` tier (every shipped agent declares `strong` today — the tier map
is ADR 0006 headroom).

## Failure visibility

Do not swallow agent errors. A silent failure that ships a malformed CV is worse than a loud one
(`/AGENTS.md` §8). Surface refusal/truncation/parse-fail to the UI as an explicit agent failure.
