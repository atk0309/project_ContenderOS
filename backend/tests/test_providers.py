"""Provider-wrapper tests for the native-PDF plumbing (PR-A / ADR 0007).

The payload-shape tests mock the Anthropic client, so they assert that `run_claude` constructs the
right `messages` (a document content block + the text prompt, or a plain string) and forwards
`max_tokens` — without a live, billed API call. The *acceptance* of a PDF document block together
with `output_format` in one real call is the genuinely external question; it is verified by the
`TEST_ANTHROPIC_KEY`-gated live spike below (skipped by default — a declared verification gap until
run with a real key, never a pass off the SQLite gate; AGENTS §4)."""

from __future__ import annotations

import asyncio
import base64
import os
from pathlib import Path
from typing import Any, TypeVar
from unittest.mock import AsyncMock, MagicMock

import pytest
from app.ai.providers.anthropic import make_anthropic_client, run_claude
from app.ai.providers.base import (
    AgentParseError,
    AgentRefusal,
    AgentTruncated,
    Document,
)
from app.ai.providers.openai import run_openai
from pydantic import BaseModel, ValidationError

_T = TypeVar("_T", bound=BaseModel)


class _Out(BaseModel):
    ok: bool = True


def _fake_parse_response(parsed: _Out) -> MagicMock:
    """A stand-in for the SDK's ParsedMessage: just the attributes run_claude reads."""
    resp = MagicMock()
    resp.usage.input_tokens = 1
    resp.usage.output_tokens = 1
    resp.stop_reason = "end_turn"
    resp.parsed_output = parsed
    return resp


def _client_returning(parsed: _Out) -> MagicMock:
    client = MagicMock()
    client.messages.parse = AsyncMock(return_value=_fake_parse_response(parsed))
    return client


def test_run_claude_text_only_sends_plain_string_content() -> None:
    """No document → the user message content is the bare prompt string (unchanged behaviour), and
    the default max_tokens is forwarded."""
    client = _client_returning(_Out(ok=True))

    async def run() -> _Out:
        return await run_claude(
            client=client,
            model="m",
            system="s",
            user="u",
            output=_Out,
            agent_id="extractor-basics",
        )

    out = asyncio.run(run())
    assert out.ok is True
    kwargs = client.messages.parse.call_args.kwargs
    assert kwargs["messages"] == [{"role": "user", "content": "u"}]
    assert kwargs["max_tokens"] == 8000


def test_run_claude_with_document_sends_pdf_block_and_max_tokens() -> None:
    """A Document → the content becomes [document-block, text-block]; the PDF rides as a base64
    `document` source with media_type application/pdf, and a per-agent max_tokens override is
    forwarded to the provider."""
    client = _client_returning(_Out(ok=True))
    data_b64 = base64.b64encode(b"%PDF-1.4 fake bytes").decode()

    async def run() -> _Out:
        return await run_claude(
            client=client,
            model="m",
            system="s",
            user="u",
            output=_Out,
            document=Document(data_b64=data_b64),
            max_tokens=12000,
            agent_id="extractor-work",
        )

    out = asyncio.run(run())
    assert out.ok is True
    kwargs = client.messages.parse.call_args.kwargs
    assert kwargs["max_tokens"] == 12000
    content: Any = kwargs["messages"][0]["content"]
    assert isinstance(content, list)
    assert content[0]["type"] == "document"
    assert content[0]["source"] == {
        "type": "base64",
        "media_type": "application/pdf",
        "data": data_b64,
    }
    assert content[1] == {"type": "text", "text": "u"}
    # output_format is still passed alongside the document — the structured-output contract holds.
    assert kwargs["output_format"] is _Out


def test_run_claude_logs_agent_id(caplog: pytest.LogCaptureFixture) -> None:
    """The agent id is threaded to the provider wrapper and appears in the agent_call log line
    (AGENTS §8: log agent id / provider / model / tokens / latency / outcome)."""
    client = _client_returning(_Out(ok=True))

    async def run() -> _Out:
        return await run_claude(
            client=client,
            model="m",
            system="s",
            user="u",
            output=_Out,
            agent_id="extractor-basics",
        )

    with caplog.at_level("INFO", logger="contender.ai"):
        asyncio.run(run())
    assert any(
        "agent_call provider=anthropic" in r.getMessage()
        and "agent=extractor-basics" in r.getMessage()
        for r in caplog.records
    )


# --- DevPR45: classified `outcome=` on the agent_call log line ----------------------------------
# The success-path log line now carries outcome=ok|refusal|truncation|schema-parse-fail mirroring
# what the wrapper raises. SDK/pydantic validation raised INSIDE `.parse()` is deliberately NOT
# classified schema-parse-fail: both SDKs validate the text regardless of the terminal state
# (anthropic lib/_parse/_response.py; openai lib/_parsing/_responses.py), so a truncation's partial
# JSON raises the same ValidationError and the terminal signal is unreachable on the raise path —
# it logs the generic outcome=error err=ValidationError and re-raises unchanged.


def _schema_validation_error() -> ValidationError:
    """A real pydantic ValidationError — what both SDKs raise from inside `.parse()` when the
    model's text fails validation (anthropic lib/_parse/_response.py TypeAdapter.validate_json;
    openai lib/_parsing/_responses.py model_parse_json)."""
    try:
        _Out.model_validate_json("this is not json")
    except ValidationError as exc:
        return exc
    raise AssertionError("model_validate_json unexpectedly accepted non-JSON")


def _agent_call_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if "agent_call" in r.getMessage()]


@pytest.mark.parametrize(
    ("stop_reason", "parsed", "raises", "outcome"),
    [
        ("end_turn", _Out(ok=True), None, "ok"),
        ("refusal", None, AgentRefusal, "refusal"),
        ("max_tokens", None, AgentTruncated, "truncation"),
        ("end_turn", None, AgentParseError, "schema-parse-fail"),
    ],
)
def test_run_claude_outcome_classification(
    stop_reason: str,
    parsed: _Out | None,
    raises: type[Exception] | None,
    outcome: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The Anthropic agent_call line carries a classified outcome= mirroring the raise, while the
    raw stop= field survives."""
    resp = _fake_parse_response(_Out(ok=True))
    resp.stop_reason = stop_reason
    resp.parsed_output = parsed
    client = MagicMock()
    client.messages.parse = AsyncMock(return_value=resp)

    async def run() -> _Out:
        return await run_claude(
            client=client, model="m", system="s", user="u", output=_Out, agent_id="tailor"
        )

    with caplog.at_level("INFO", logger="contender.ai"):
        if raises is None:
            assert asyncio.run(run()).ok is True
        else:
            with pytest.raises(raises):
                asyncio.run(run())
    lines = _agent_call_lines(caplog)
    assert any(f"outcome={outcome}" in line and f"stop={stop_reason}" in line for line in lines)


def _fake_openai_response(
    *,
    status: str = "completed",
    parsed: _Out | None = None,
    incomplete_reason: str | None = None,
    refusal: bool = False,
) -> MagicMock:
    """A stand-in for the SDK's ParsedResponse: EXPLICIT attributes for everything run_openai
    reads — a bare MagicMock auto-attribute is truthy-but-not-iterable and breaks the refusal
    scan over `resp.output`."""
    resp = MagicMock()
    resp.status = status
    resp.usage.input_tokens = 1
    resp.usage.output_tokens = 1
    if incomplete_reason is None:
        resp.incomplete_details = None
    else:
        resp.incomplete_details = MagicMock()
        resp.incomplete_details.reason = incomplete_reason
    if refusal:
        part = MagicMock()
        part.type = "refusal"
        item = MagicMock()
        item.content = [part]
        resp.output = [item]
    else:
        resp.output = []
    resp.output_parsed = parsed
    return resp


@pytest.mark.parametrize(
    ("status", "parsed", "incomplete_reason", "refusal", "raises", "outcome"),
    [
        ("completed", _Out(ok=True), None, False, None, "ok"),
        ("incomplete", None, "max_output_tokens", False, AgentTruncated, "truncation"),
        ("completed", None, None, True, AgentRefusal, "refusal"),
        ("completed", None, None, False, AgentParseError, "schema-parse-fail"),
    ],
)
def test_run_openai_outcome_classification(
    status: str,
    parsed: _Out | None,
    incomplete_reason: str | None,
    refusal: bool,
    raises: type[Exception] | None,
    outcome: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The OpenAI agent_call line carries a classified outcome= mirroring the raise precedence
    (incomplete → refusal-part → parsed None), while the raw status= field survives."""
    resp = _fake_openai_response(
        status=status, parsed=parsed, incomplete_reason=incomplete_reason, refusal=refusal
    )
    client = MagicMock()
    client.responses.parse = AsyncMock(return_value=resp)

    async def run() -> _Out:
        return await run_openai(
            client=client, model="m", system="s", user="u", output=_Out, agent_id="judge"
        )

    with caplog.at_level("INFO", logger="contender.ai"):
        if raises is None:
            assert asyncio.run(run()).ok is True
        else:
            with pytest.raises(raises):
                asyncio.run(run())
    lines = _agent_call_lines(caplog)
    assert any(f"outcome={outcome}" in line and f"status={status}" in line for line in lines)


def test_run_claude_parse_raised_validation_error_stays_raw(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A pydantic ValidationError raised INSIDE `messages.parse` logs the generic outcome=error
    with err=ValidationError and re-raises the ORIGINAL exception unchanged. It must NOT become
    AgentParseError/outcome=schema-parse-fail: the SDK validates every text block regardless of
    stop_reason (anthropic lib/_parse/_response.py), so this could be a truncation's partial JSON
    — and AgentParseError would trigger ingest's billed PDF-fallback retry on it."""
    original = _schema_validation_error()
    client = MagicMock()
    client.messages.parse = AsyncMock(side_effect=original)

    async def run() -> _Out:
        return await run_claude(
            client=client, model="m", system="s", user="u", output=_Out, agent_id="tailor"
        )

    with caplog.at_level("WARNING", logger="contender.ai"), pytest.raises(ValidationError) as exc:
        asyncio.run(run())
    assert exc.value is original  # the raw exception, not a wrapped/converted one
    lines = _agent_call_lines(caplog)
    assert any(
        "provider=anthropic" in line and "outcome=error" in line and "err=ValidationError" in line
        for line in lines
    )
    assert not any("outcome=schema-parse-fail" in line for line in lines)


def test_run_openai_parse_raised_validation_error_stays_raw(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A pydantic ValidationError raised INSIDE `responses.parse` logs the generic outcome=error
    with err=ValidationError and re-raises the ORIGINAL exception unchanged — the SDK validates
    output_text parts regardless of status (openai lib/_parsing/_responses.py), so this could be
    an incomplete response's partial JSON, not provably a schema-parse failure."""
    original = _schema_validation_error()
    client = MagicMock()
    client.responses.parse = AsyncMock(side_effect=original)

    async def run() -> _Out:
        return await run_openai(
            client=client, model="m", system="s", user="u", output=_Out, agent_id="judge"
        )

    with caplog.at_level("WARNING", logger="contender.ai"), pytest.raises(ValidationError) as exc:
        asyncio.run(run())
    assert exc.value is original  # the raw exception, not a wrapped/converted one
    lines = _agent_call_lines(caplog)
    assert any(
        "provider=openai" in line and "outcome=error" in line and "err=ValidationError" in line
        for line in lines
    )
    assert not any("outcome=schema-parse-fail" in line for line in lines)


@pytest.mark.skipif(
    not (
        os.getenv("TEST_ANTHROPIC_KEY")
        and os.getenv("TEST_ANTHROPIC_MODEL")
        and os.getenv("TEST_PDF_PATH")
    ),
    reason=(
        "live spike (ADR 0007): set TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL and TEST_PDF_PATH "
        "(a real PDF) to confirm the API accepts a PDF document block + output_format in one call"
    ),
)
def test_run_claude_live_pdf_spike() -> None:
    """The external check the mocks can't make: a real `messages.parse` with a base64 PDF document
    block AND `output_format`, asserting schema-valid structured output (not a 400).

    Exercises ALL THREE section-scoped Extractor schemas (basics / work / qualifications), each with
    the PDF attached — the single full `ExtractedProfile` is rejected by the API as 'Schema is too
    complex' (why the Extractor was split). A quals-only check could hide a too-complex on the
    anyOf-dense basics; if any one fails, split that section further before relying on it."""
    from app.ai.agents.extractor import (
        basics_extractor,
        qualifications_extractor,
        work_extractor,
    )
    from app.ai.agents.types import Agent

    key = os.environ["TEST_ANTHROPIC_KEY"]
    model = os.environ["TEST_ANTHROPIC_MODEL"]
    pdf_b64 = base64.b64encode(Path(os.environ["TEST_PDF_PATH"]).read_bytes()).decode()
    document = Document(data_b64=pdf_b64)

    async def extract(agent: Agent[str, _T]) -> _T:
        client = make_anthropic_client(key)
        try:
            return await run_claude(
                client=client,
                model=model,
                system=agent.system(),
                user=agent.build_input("(the candidate's CV is the attached PDF)"),
                output=agent.output,
                document=document,
                max_tokens=agent.max_tokens,
                agent_id=agent.id,
            )
        finally:
            await client.close()

    basics = asyncio.run(extract(basics_extractor))
    assert basics.name.strip()  # RawBasics.name is a plain str
    work = asyncio.run(extract(work_extractor))
    assert isinstance(work.work, list)
    quals = asyncio.run(extract(qualifications_extractor))
    assert isinstance(quals.education, list)


@pytest.mark.skipif(
    not (os.getenv("TEST_ANTHROPIC_KEY") and os.getenv("TEST_ANTHROPIC_MODEL")),
    reason=(
        "live spike (D2a): set TEST_ANTHROPIC_KEY + TEST_ANTHROPIC_MODEL to confirm the real API "
        "accepts the qualifications Extractor schema WITH the new `languages` field — folding "
        "`ExtractedLanguage` (name + optional fluency) into the existing required-ish call must "
        "not tip it over the structured-output grammar budget (the optionality cliff, ADR 0007); "
        "the fake runner returns a canned object and can't prove acceptance."
    ),
)
def test_run_claude_live_languages_extractor_spike() -> None:
    """D2a acceptance gate. The qualifications Extractor now also emits `languages`; only a real
    `messages.parse` proves the added field keeps the schema compilable (no '400 Schema is too
    complex'). Text-only — a LANGUAGES section in the doc should surface at least one entry with the
    fluency carried through."""
    from app.ai.agents.extractor import ExtractedQualifications, qualifications_extractor

    key = os.environ["TEST_ANTHROPIC_KEY"]
    model = os.environ["TEST_ANTHROPIC_MODEL"]
    doc = (
        "Imported Candidate — Integration Manager\n\n"
        "EDUCATION\nBSc Computer Science, Example University (2020)\n\n"
        "SKILLS\nEDI, AS2, Python\n\n"
        "LANGUAGES\nEnglish (Professional), French (Conversational), Spanish (Basic)"
    )

    async def run() -> ExtractedQualifications:
        client = make_anthropic_client(key)
        try:
            return await run_claude(
                client=client,
                model=model,
                system=qualifications_extractor.system(),
                user=qualifications_extractor.build_input(doc),
                output=qualifications_extractor.output,
                max_tokens=qualifications_extractor.max_tokens,
                agent_id=qualifications_extractor.id,
            )
        finally:
            await client.close()

    quals = asyncio.run(run())
    assert isinstance(quals.languages, list)  # schema accepted; no "Schema is too complex"
    names = {x.language.strip().casefold() for x in quals.languages}
    assert "english" in names  # the model surfaced the LANGUAGES section


@pytest.mark.skipif(
    not (os.getenv("TEST_ANTHROPIC_KEY") and os.getenv("TEST_ANTHROPIC_MODEL")),
    reason=(
        "live spike (DevPR29): set TEST_ANTHROPIC_KEY + TEST_ANTHROPIC_MODEL to confirm the real "
        "API accepts the per-bullet Corrector's `CorrectedBullets` output and echoes the bulletId "
        "— the fake runner returns a canned object, can't prove acceptance (ADR 0007 grammar)."
    ),
)
def test_run_claude_live_corrector_spike() -> None:
    """DevPR29 acceptance gate. The Corrector now emits `{revisions:[{bulletId,text}]}` per accepted
    bullet; only a real `messages.parse` proves the schema compiles and the model echoes the
    bulletId with a non-empty revision."""
    from app.ai.agents.corrector import (
        BulletCorrection,
        CorrectContext,
        CorrectedBullets,
        corrector,
    )
    from app.schema.common import Severity
    from app.schema.reviews import Thread

    key = os.environ["TEST_ANTHROPIC_KEY"]
    model = os.environ["TEST_ANTHROPIC_MODEL"]
    ctx = CorrectContext(
        bullets=[
            BulletCorrection(
                bullet_id="b-1",
                current_text=(
                    "Drove platform uptime to 99.9% across 12 markets, ensuring reliability and "
                    "continuity of logistics integration pipelines."
                ),
                master_text="Raised pipeline uptime to 99.9% across 12 markets.",
                threads=[
                    Thread(
                        anchor_id="b-1",
                        severity=Severity.minor,
                        comment="Trailing clause is padding; tighten to the uptime metric.",
                        suggested_revision="Drove platform uptime to 99.9% across 12 markets.",
                    )
                ],
            )
        ]
    )

    async def run() -> CorrectedBullets:
        client = make_anthropic_client(key)
        try:
            return await run_claude(
                client=client,
                model=model,
                system=corrector.system(),
                user=corrector.build_input(ctx),
                output=corrector.output,
                max_tokens=corrector.max_tokens,
                agent_id=corrector.id,
            )
        finally:
            await client.close()

    result = asyncio.run(run())
    assert isinstance(result.revisions, list)  # schema accepted; no "Schema is too complex"
    assert "b-1" in {r.bullet_id for r in result.revisions}  # the model echoed the bulletId
    assert next(r for r in result.revisions if r.bullet_id == "b-1").text.strip()  # non-empty


@pytest.mark.skipif(
    not (os.getenv("TEST_ANTHROPIC_KEY") and os.getenv("TEST_ANTHROPIC_MODEL")),
    reason=(
        "live spike (PR-E): set TEST_ANTHROPIC_KEY + TEST_ANTHROPIC_MODEL to confirm the API "
        "accepts the Reconciler's WorkReconciliation output schema — the offline fake runner can't "
        "(a too-complex schema only 400s against a real key)."
    ),
)
def test_run_claude_live_reconciler_spike() -> None:
    """PR-E grammar re-spike: the work Reconciler's `WorkReconciliation` output is structurally
    simpler than the live-passing Extractor schemas, but only a real key proves the API accepts it
    (the fake runner returns a canned object without ever calling the API). Text-only — the
    Reconciler reads identity lines, not a PDF."""
    from app.ai.agents.reconciler import (
        ReconcileWorkContext,
        WorkReconciliation,
        work_reconciler,
    )
    from app.schema.ingest import ExtractedWork
    from app.schema.master import WorkEntry

    key = os.environ["TEST_ANTHROPIC_KEY"]
    model = os.environ["TEST_ANTHROPIC_MODEL"]
    ctx = ReconcileWorkContext(
        extracted=[
            ExtractedWork(company="ExampleCo", position="Integration Manager", start_date="2019")
        ],
        master=[
            WorkEntry(
                id="w1",
                company="ExampleCo",
                position="Integration Manager",
                start_date="2019",
                highlights=[],
            )
        ],
    )

    async def run() -> WorkReconciliation:
        client = make_anthropic_client(key)
        try:
            return await run_claude(
                client=client,
                model=model,
                system=work_reconciler.system(),
                user=work_reconciler.build_input(ctx),
                output=work_reconciler.output,
                max_tokens=work_reconciler.max_tokens,
                agent_id=work_reconciler.id,
            )
        finally:
            await client.close()

    result = asyncio.run(run())
    assert isinstance(result.matches, list)  # schema accepted; no "Schema is too complex"


@pytest.mark.skipif(
    not (os.getenv("TEST_OPENAI_KEY") and os.getenv("TEST_OPENAI_MODEL")),
    reason=(
        "live spike (PR-E E2): set TEST_OPENAI_KEY + TEST_OPENAI_MODEL to confirm the API accepts "
        "the Judge's JudgeReport via responses.parse — the FIRST live OpenAI structured-output "
        "call in the repo (the offline fake runner can't prove strict-mode acceptance)."
    ),
)
def test_run_openai_live_spike() -> None:
    """PR-E E2 re-spike: the first live OpenAI `responses.parse` call — confirm the API accepts the
    Judge's `JudgeReport` schema (a list of `JudgeDecision`), not a strict-mode rejection. Builds a
    couple of proposals and asserts a schema-valid report."""
    from app.ai.agents.ingest import build_net_new_proposals
    from app.ai.agents.judge import JudgeContext, JudgeReport, judge
    from app.ai.providers.openai import make_openai_client, run_openai
    from app.schema.ingest import ExtractedProfile, ExtractedSkill

    proposals = build_net_new_proposals(
        ExtractedProfile(skills=[ExtractedSkill(name="EDI"), ExtractedSkill(name="Python")]), "doc"
    )
    key = os.environ["TEST_OPENAI_KEY"]
    model = os.environ["TEST_OPENAI_MODEL"]

    async def run() -> JudgeReport:
        client = make_openai_client(key)
        try:
            return await run_openai(
                client=client,
                model=model,
                system=judge.system(),
                user=judge.build_input(JudgeContext(proposals=proposals)),
                output=judge.output,
                max_tokens=judge.max_tokens,
                agent_id=judge.id,
            )
        finally:
            await client.close()

    report = asyncio.run(run())
    assert isinstance(report.decisions, list)  # strict-mode schema accepted


# --- PR-0: review-panel schema-complexity spikes ------------------------------------------------
# The AI Review Panel adds five structured-output agents whose schemas live in
# `app/schema/reviews.py` (Editor / Fact-Checker / Gatekeeper → OpenAI; Spotter → Claude) plus the
# Corrector emitting a full `TailoredCV` → Claude. Those report schemas carry OPTIONAL fields
# (`Thread.suggested_revision`, `FactCheckThread.source_id`, defaulted `anchor_kind`/`threads`) —
# the exact optionality that 400'd the Extractor's `ExtractedProfile` ("Schema is too complex" /
# strict-mode reject). The offline fake runner returns canned objects and never calls the API, so
# ONLY a real-key call proves the providers accept these schemas. These spikes run BEFORE the agents
# are built (PR-2a/PR-3): they validate the WIRE schemas directly with a throwaway prompt, so a
# rejection forces the `RawBasics`-style required-with-sentinel internal-container redesign before
# anything is built on top. Skipped by default — a declared verification gap until run with a real
# key, never a pass off the SQLite gate (AGENTS §4). See docs/ai-panel.md and the plan.


def _sample_review_inputs() -> tuple[str, str, str]:
    """Realistic (cv_json, master_json, job_json) for the review spikes — the same factories the
    route tests use, so the schemas are exercised against representative data."""
    from tests.factories import sample_job_spec, sample_master_profile, sample_tailored_cv

    cv = sample_tailored_cv().model_dump_json(by_alias=True, indent=2)
    master = sample_master_profile().model_dump_json(by_alias=True, indent=2)
    job = sample_job_spec().model_dump_json(by_alias=True, indent=2)
    return cv, master, job


_OPENAI_SPIKE_SKIP = pytest.mark.skipif(
    not (os.getenv("TEST_OPENAI_KEY") and os.getenv("TEST_OPENAI_MODEL")),
    reason=(
        "live spike (PR-0): set TEST_OPENAI_KEY + TEST_OPENAI_MODEL to confirm the API accepts the "
        "review adjudicator schemas via responses.parse (strict-mode); the fake runner can't."
    ),
)
_ANTHROPIC_SPIKE_SKIP = pytest.mark.skipif(
    not (os.getenv("TEST_ANTHROPIC_KEY") and os.getenv("TEST_ANTHROPIC_MODEL")),
    reason=(
        "live spike (PR-0): set TEST_ANTHROPIC_KEY + TEST_ANTHROPIC_MODEL to confirm the API "
        "accepts the SlopReport + Corrector TailoredCV schemas via messages.parse; the fake can't."
    ),
)


def _spike_openai[T: BaseModel](output: type[T], system: str, user: str) -> T:
    from app.ai.providers.openai import make_openai_client, run_openai

    key = os.environ["TEST_OPENAI_KEY"]
    model = os.environ["TEST_OPENAI_MODEL"]

    async def run() -> T:
        client = make_openai_client(key)
        try:
            return await run_openai(
                client=client,
                model=model,
                system=system,
                user=user,
                output=output,
                max_tokens=6000,
                agent_id="pr0-spike",
            )
        finally:
            await client.close()

    return asyncio.run(run())


def _spike_claude[T: BaseModel](output: type[T], system: str, user: str) -> T:
    key = os.environ["TEST_ANTHROPIC_KEY"]
    model = os.environ["TEST_ANTHROPIC_MODEL"]

    async def run() -> T:
        client = make_anthropic_client(key)
        try:
            return await run_claude(
                client=client,
                model=model,
                system=system,
                user=user,
                output=output,
                max_tokens=8000,
                agent_id="pr0-spike",
            )
        finally:
            await client.close()

    return asyncio.run(run())


@_OPENAI_SPIKE_SKIP
def test_review_schema_spike_editor() -> None:
    """OpenAI strict-mode acceptance of `EditorReport` (overall + a list of optional-bearing
    `Thread`s). A 400 here means split/flatten the schema before building `agents/editor.py`."""
    from app.schema.reviews import EditorReport

    cv, _master, job = _sample_review_inputs()
    report = _spike_openai(
        EditorReport,
        "You are a CV line-editor. Critique the CV for the job; anchor every note to a stable id "
        "(bulletId/itemId/sectionId/'summary'). Critique, do not rewrite. Return an EditorReport.",
        f"### CV\n{cv}\n\n### JOB\n{job}",
    )
    assert isinstance(report.threads, list)  # schema accepted; no strict-mode/too-complex reject


@_OPENAI_SPIKE_SKIP
def test_review_schema_spike_fact_checker() -> None:
    """OpenAI strict-mode acceptance of `FactCheckReport` (a list of `FactCheckThread` — the most
    field-dense report: inherits the optional `Thread` fields plus claim/verdict/sourceId)."""
    from app.schema.reviews import FactCheckReport

    cv, master, _job = _sample_review_inputs()
    report = _spike_openai(
        FactCheckReport,
        "You are a CV fact-checker. Every claim must trace to a master highlight; verdict each as "
        "supported/unsupported/overstated and cite the master id as sourceId. Return a "
        "FactCheckReport.",
        f"### CV\n{cv}\n\n### MASTER\n{master}",
    )
    assert isinstance(report.threads, list)


@_OPENAI_SPIKE_SKIP
def test_review_schema_spike_gatekeeper() -> None:
    """OpenAI strict-mode acceptance of `GatekeeperVerdict` (decision + int score + two string lists
    + notes + a nested `Thread` list)."""
    from app.schema.reviews import GatekeeperVerdict

    cv, _master, job = _sample_review_inputs()
    verdict = _spike_openai(
        GatekeeperVerdict,
        "You are a recruiter/ATS first-pass screen for THIS posting. Decide pass/borderline/"
        "reject, score the ATS match 0-100, list missing keywords + unmet must-haves, write blunt "
        "recruiter notes, and anchor fixes that would flip it. Return a GatekeeperVerdict.",
        f"### CV\n{cv}\n\n### JOB\n{job}",
    )
    assert isinstance(verdict.ats_match_score, int)


@_ANTHROPIC_SPIKE_SKIP
def test_review_schema_spike_spotter() -> None:
    """Anthropic grammar-budget acceptance of `SlopReport` (a list of optional-dense `SlopThread`) —
    the real 2^N-optionality risk (Claude honors Pydantic optionals as anyOf presence-subsets)."""
    from app.schema.reviews import SlopReport

    cv, _master, _job = _sample_review_inputs()
    report = _spike_claude(
        SlopReport,
        "You are an AI-language spotter. Flag tonal blandness / faux-confidence / off-voice "
        "phrasing, anchored to a stable id, each with a slop flag. Match the operator's voice. "
        "Return a SlopReport.",
        f"### CV\n{cv}",
    )
    assert isinstance(report.threads, list)


@_ANTHROPIC_SPIKE_SKIP
def test_review_schema_spike_corrector_roundtrip() -> None:
    """Anthropic acceptance of a correction-shaped `TailoredCV` round-trip (PR-0 schema spike;
    predates the DevPR29 per-bullet Corrector, kept as TailoredCV schema-acceptance evidence).
    The Tailor spike proves TailoredCV compiles on fresh tailoring; this proves the CORRECTION
    shape: feed a CV + an accepted reword and confirm a schema-valid TailoredCV comes back with the
    **bulletId set preserved**. The production apply path no longer round-trips a whole CV — the
    Corrector returns `{bulletId → text}` and the server splices (`apply_corrections`), so this
    spike's only remaining claim is schema acceptance, not the apply contract. NOTE:
    `version`/`parentVersion` are SERVER-owned (`_guarded_save` overwrites whatever the model
    emits), so the spike deliberately does not assert them."""
    from app.schema import TailoredCV

    from tests.factories import sample_tailored_cv

    before_ids = {
        b.bullet_id for s in sample_tailored_cv().sections for it in s.items for b in it.highlights
    }
    cv, master, _job = _sample_review_inputs()
    revised = _spike_claude(
        TailoredCV,
        "You are a CV corrector. Apply ONLY the accepted reword to the bullet it anchors; preserve "
        "every bulletId and all other fields exactly. Work from real facts only. Return the "
        "revised TailoredCV.",
        f"### MASTER\n{master}\n\n### CURRENT CV\n{cv}\n\n### ACCEPTED THREAD\n"
        'anchorId=b2 — reword to: "Cut partner onboarding time 60% via a standard playbook."',
    )
    after_ids = {b.bullet_id for s in revised.sections for it in s.items for b in it.highlights}
    assert revised.sections and revised.sections[0].items  # schema accepted; valid TailoredCV back
    assert after_ids == before_ids  # reword-in-place: the bulletId set is preserved (no adds/drops)
