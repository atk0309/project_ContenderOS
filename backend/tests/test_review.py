"""The review route (`POST /workspaces/{id}/cv/{cv_id}/review`) — the AI review fan-out (PR-2a).

Offline: SQLite stands in for Postgres, the membership store is in-memory so per-workspace
authorization (invariant 8) is exercised, and the AI is faked at TWO seams:

- the Tailor (seeding a CV at `create`) goes through `get_runner` / `get_model_resolver`, faked as
  before;
- the review panel goes through `build_panel_runner` — which calls `get_*_client` /
  `get_model_resolver` DIRECTLY, bypassing `dependency_overrides` — so it is faked at the
  `get_panel_runner_builder` seam (the `get_runner_factory` precedent in `test_ingest.py`).

Both arms run the full fan-out; a degraded agent lands in `failures` (blocking) /
`AgentDone(ok=false)` (stream) rather than failing the request (invariant 5). The concurrency seam
(R2) gets an offline guard here; its prod-safety is proven only by the live local-stack drive
(§ verification), not this suite.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Iterator
from typing import TypeVar

import app.ai.agents.registry as registry
import httpx
import pytest
from anthropic import APIError as AnthropicAPIError
from app.ai.agents.fact_checker import apply_fact_check_authority
from app.ai.agents.gatekeeper import GatekeeperContext, gatekeeper
from app.ai.agents.registry import (
    build_panel_runner,
    get_model_resolver,
    get_panel_runner_builder,
    get_runner,
)
from app.ai.agents.review import run_review
from app.ai.providers.base import AgentParseError, AgentRefusal, ModelTierUnset
from app.ai.providers.clients import invalidate_client
from app.auth.deps import current_user
from app.main import app
from app.persistence import cv_store, get_membership_store, review_store
from app.persistence.models import ProviderModels, StoredCvReview
from app.schema import (
    AuthUser,
    EditorReport,
    FactCheckReport,
    FactCheckThread,
    GatekeeperVerdict,
    Membership,
    ReviewBundle,
    SlopReport,
    TailoredCV,
    Thread,
)
from app.schema.common import (
    AnchorKind,
    Decision,
    FactVerdict,
    Origin,
    Provider,
    SectionType,
    Severity,
    Tier,
)
from app.schema.master import Language
from app.schema.tailored import TailoredBullet, TailoredItem, TailoredSection
from fastapi.testclient import TestClient
from openai import APIError as OpenAIAPIError
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.factories import InMemoryMembershipStore, sample_job_spec, sample_master_profile

TOut = TypeVar("TOut", bound=BaseModel)

OWNER = AuthUser(email="owner@example.com")
STRANGER = AuthUser(email="stranger@example.com")

_STORE = InMemoryMembershipStore(
    [
        Membership(workspace_id="default", email=OWNER.email),
        Membership(workspace_id="ws2", email=OWNER.email),
    ]
)


def _model_cv() -> TailoredCV:
    """A grounded bullet + a bogus-source bullet the server turns net-new (so the CV needs sign-off,
    used to prove a needs-sign-off CV is still reviewable)."""
    return TailoredCV(
        job_spec_ref="job-1",
        master_version="1",
        version=1,
        summary="Integration manager.",
        sections=[
            TailoredSection(
                section_id="s1",
                type=SectionType.work,
                items=[
                    TailoredItem(
                        item_id="i1",
                        source_id="exampleco-integration-mgr",
                        highlights=[
                            TailoredBullet(
                                bullet_id="b1",
                                source_id="exampleco-1",
                                text="Led migration of 40 EDI partners.",
                                origin=Origin.verbatim,
                            ),
                            TailoredBullet(
                                bullet_id="b2",
                                source_id="bogus",
                                text="Owned the SLA dashboard end to end.",
                                origin=Origin.verbatim,
                            ),
                        ],
                    )
                ],
            )
        ],
    )


def _sample_verdict(score: int = 72) -> GatekeeperVerdict:
    return GatekeeperVerdict(
        decision=Decision.borderline,
        ats_match_score=score,
        missing_keywords=["AS2"],
        unmet_must_haves=[],
        recruiter_notes="Solid EDI match; thin on REST.",
        threads=[],
    )


def _sample_editor() -> EditorReport:
    return EditorReport(overall="Tighten the summary.", threads=[])


def _sample_fact_check() -> FactCheckReport:
    return FactCheckReport(threads=[])


def _sample_slop() -> SlopReport:
    return SlopReport(threads=[])


_SAMPLES: dict[type[BaseModel], BaseModel] = {
    GatekeeperVerdict: _sample_verdict(),
    EditorReport: _sample_editor(),
    FactCheckReport: _sample_fact_check(),
    SlopReport: _sample_slop(),
}


def _panel_runner(
    *,
    verdict: GatekeeperVerdict | None = None,
    raises: dict[type[BaseModel], Exception] | None = None,
) -> object:
    """A session-free fake panel runner: dispatches on `output` → the matching sample report; raises
    a per-output exception when configured (to exercise per-agent degrade / a propagating bug)."""
    samples = dict(_SAMPLES)
    if verdict is not None:
        samples[GatekeeperVerdict] = verdict

    async def runner(*, output: type[TOut], **_: object) -> TOut:
        if raises and output in raises:
            raise raises[output]
        return output.model_validate(samples[output].model_dump(by_alias=True))

    return runner


async def _panel_resolve(provider: Provider, tier: Tier) -> str:
    return "fake-model-id"


def _fake_builder(
    *,
    verdict: GatekeeperVerdict | None = None,
    raises: dict[type[BaseModel], Exception] | None = None,
) -> object:
    """A `get_panel_runner_builder` override returning a session-free (runner, resolve) pair."""

    async def build(_session: AsyncSession) -> tuple[object, object]:
        return _panel_runner(verdict=verdict, raises=raises), _panel_resolve

    return build


def _failing_builder(exc: Exception) -> object:
    """A builder that raises during setup (unset tier / missing key) → the route's preflight 503."""

    async def build(_session: AsyncSession) -> tuple[object, object]:
        raise exc

    return build


def _tailor_runner() -> object:
    """The `get_runner` override for the Tailor at `create` (only ever asked for a TailoredCV)."""

    async def runner(*, output: type[TOut], **_: object) -> TOut:
        return output.model_validate(_model_cv().model_dump(by_alias=True))

    return runner


def _fixed_resolver() -> object:
    async def resolve(provider: Provider, tier: Tier) -> str:
        return "fake-model-id"

    return resolve


@pytest.fixture
def client(sqlite_maker: async_sessionmaker[AsyncSession]) -> Iterator[TestClient]:
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_membership_store] = lambda: _STORE
    # Tailor (create_cv) seam:
    app.dependency_overrides[get_runner] = _tailor_runner
    app.dependency_overrides[get_model_resolver] = _fixed_resolver
    # Review panel seam (the fan-out bypasses get_runner — fake the whole builder):
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder()
    try:
        yield TestClient(app, base_url="https://testserver")
    finally:
        app.dependency_overrides.clear()


def _put_master(client: TestClient, workspace: str = "default") -> None:
    res = client.put(
        f"/workspaces/{workspace}/master",
        json=sample_master_profile().model_dump(by_alias=True),
    )
    assert res.status_code == 200, res.text


def _create(client: TestClient, workspace: str = "default") -> str:
    _put_master(client, workspace)
    res = client.post(
        f"/workspaces/{workspace}/cv",
        json={"jobSpec": sample_job_spec().model_dump(by_alias=True)},
    )
    assert res.status_code == 200, res.text
    return str(res.json()["id"])


def _create_draft(client: TestClient, workspace: str = "default") -> str:
    _put_master(client, workspace)
    res = client.post(f"/workspaces/{workspace}/cv/from-master")
    assert res.status_code == 200, res.text
    return str(res.json()["id"])


def _review(
    client: TestClient,
    cv_id: str,
    workspace: str = "default",
    base_version: int | None = None,
) -> httpx.Response:
    """Blocking review (no `Accept`). `baseVersion` defaults to the stored CV's current version."""
    bv = base_version
    if bv is None:
        bv = int(client.get(f"/workspaces/{workspace}/cv/{cv_id}").json()["cv"]["version"])
    res: httpx.Response = client.post(
        f"/workspaces/{workspace}/cv/{cv_id}/review", json={"baseVersion": bv}
    )
    return res


def _stream_review(
    client: TestClient, cv_id: str, workspace: str = "default", base_version: int = 1
) -> tuple[list[dict[str, object]], httpx.Headers]:
    """Drive the SSE arm; collect parsed events up to and including `run_done`. Returns the events +
    the response headers (so a test can assert there is no `X-Run-Id`)."""
    events: list[dict[str, object]] = []
    with client.stream(
        "POST",
        f"/workspaces/{workspace}/cv/{cv_id}/review",
        headers={"accept": "text/event-stream"},
        json={"baseVersion": base_version},
    ) as res:
        assert res.status_code == 200, res.read()
        assert res.headers["content-type"].startswith("text/event-stream")
        headers = res.headers
        for line in res.iter_lines():
            if line.startswith("data:"):
                event = json.loads(line[len("data:") :].strip())
                events.append(event)
                if event["type"] == "run_done":
                    break
    return events, headers


# --- auth / guards (short-circuit before the panel; unchanged from PR-1b) -----------------------


def test_review_denies_non_member(client: TestClient) -> None:
    cv_id = _create(client)
    app.dependency_overrides[current_user] = lambda: STRANGER
    assert _review(client, cv_id, base_version=1).status_code == 403


def test_review_cross_tenant_404(client: TestClient) -> None:
    cv_id = _create(client, workspace="default")
    assert _review(client, cv_id, workspace="ws2", base_version=1).status_code == 404


# --- Clear review (owner DELETE .../review; idempotent, owner-gated, tenant-scoped) --------------
# (`_get_review` is defined below in the persisted-review section; reused here.)


def _delete_review(client: TestClient, cv_id: str, workspace: str = "default") -> httpx.Response:
    res: httpx.Response = client.delete(f"/workspaces/{workspace}/cv/{cv_id}/review")
    return res


def test_clear_review_owner_removes_persisted_run(client: TestClient) -> None:
    cv_id = _create(client)
    _stream_review(client, cv_id, base_version=1)
    assert _get_review(client, cv_id).json() is not None  # persisted
    res = _delete_review(client, cv_id)
    assert res.status_code == 200, res.text
    assert _get_review(client, cv_id).json() is None  # gone


def test_clear_review_is_idempotent(client: TestClient) -> None:
    cv_id = _create(client)
    assert _delete_review(client, cv_id).status_code == 200  # never reviewed → 200 no-op
    _stream_review(client, cv_id, base_version=1)
    assert _delete_review(client, cv_id).status_code == 200
    assert _delete_review(client, cv_id).status_code == 200  # second clear → still 200


def test_clear_review_denies_non_member(client: TestClient) -> None:
    cv_id = _create(client)
    app.dependency_overrides[current_user] = lambda: STRANGER
    assert _delete_review(client, cv_id).status_code == 403


def test_clear_review_cross_tenant_leaves_other_workspace_untouched(client: TestClient) -> None:
    cv_id = _create(client, workspace="default")
    _stream_review(client, cv_id, base_version=1)
    # OWNER also owns ws2, but the review lives in `default`; a ws2-scoped clear is a 200 no-op that
    # must NOT touch the default workspace's row (invariant 8, workspace-scoped delete).
    assert _delete_review(client, cv_id, workspace="ws2").status_code == 200
    assert _get_review(client, cv_id).json() is not None


def test_review_stale_base_version_is_409(client: TestClient) -> None:
    cv_id = _create(client)  # stored at version 1
    assert _review(client, cv_id, base_version=99).status_code == 409


def test_review_unknown_cv_404(client: TestClient) -> None:
    _put_master(client)
    assert _review(client, "nope", base_version=1).status_code == 404


# --- blocking arm: full fan-out + server authority ----------------------------------------------


def test_owner_gets_full_review_bundle(client: TestClient) -> None:
    """A CV with a target job runs all four agents; the blocking arm returns the full bundle."""
    cv_id = _create(client)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text
    bundle = res.json()
    assert bundle["cvVersion"] == 1
    assert bundle["gatekeeper"]["decision"] == "borderline"
    assert bundle["editor"]["overall"]
    assert bundle["factCheck"]["threads"] == []
    assert bundle["slop"]["threads"] == []
    assert bundle["failures"] == []


def test_ats_score_clamped_high(client: TestClient) -> None:
    """The model isn't trusted for the 0-100 range — the server clamps an over-range score."""
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(
        verdict=_sample_verdict(score=250)
    )
    cv_id = _create(client)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text
    assert res.json()["gatekeeper"]["atsMatchScore"] == 100


def test_ats_score_clamped_low(client: TestClient) -> None:
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(
        verdict=_sample_verdict(score=-5)
    )
    cv_id = _create(client)
    assert _review(client, cv_id).json()["gatekeeper"]["atsMatchScore"] == 0


def test_needs_signoff_cv_is_reviewable(client: TestClient) -> None:
    """Review loads the stored CV directly (not the gated export path), so a CV with unsigned
    net-new bullets is reviewable — the point is to review BEFORE sign-off (ADR 0010)."""
    cv_id = _create(client)  # _model_cv has a bogus-source bullet → net-new, needs sign-off
    read = client.get(f"/workspaces/default/cv/{cv_id}").json()["cv"]
    bullets = [b for s in read["sections"] for i in s["items"] for b in i["highlights"]]
    assert any(b["needsSignoff"] for b in bullets)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text  # NOT a 409
    assert res.json()["gatekeeper"]["decision"] == "borderline"


def test_no_job_draft_runs_job_independent_two(client: TestClient) -> None:
    """A no-job (keyless) draft has no posting, so the Gatekeeper + Editor don't apply (null), but
    the job-independent Fact-Checker + Spotter still run (dec #2)."""
    cv_id = _create_draft(client)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text
    bundle = res.json()
    assert bundle["gatekeeper"] is None
    assert bundle["editor"] is None
    assert bundle["factCheck"] is not None
    assert bundle["slop"] is not None
    assert bundle["failures"] == []


def test_gatekeeper_threads_grounded_to_real_anchors(client: TestClient) -> None:
    """The server keeps a thread only when its `anchorId` is a real id of the MATCHING `anchorKind`
    (ADR 0003). `_model_cv` has bullet `b1`, item `i1`, section `s1`."""

    def bullet(aid: str, c: str) -> Thread:
        return Thread(
            anchor_id=aid, anchor_kind=AnchorKind.bullet, severity=Severity.minor, comment=c
        )

    verdict = _sample_verdict()
    verdict.threads = [
        bullet("b1", "real bullet — kept"),
        bullet("ghost", "hallucinated id — dropped"),
        bullet("s1", "section id under a bullet kind — mis-pinned, dropped"),
        Thread(
            anchor_id="s1", anchor_kind=AnchorKind.section, severity=Severity.info, comment="ok"
        ),
    ]
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(verdict=verdict)
    cv_id = _create(client)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text
    kept = {(t["anchorId"], t["anchorKind"]) for t in res.json()["gatekeeper"]["threads"]}
    assert kept == {("b1", "bullet"), ("s1", "section")}


# --- config faults (503 preflight) vs per-agent degrade (200 + failures) ------------------------


def test_unset_tier_is_503(client: TestClient) -> None:
    """An unset tier (a provider-config fault) raises in the builder preflight → a clean 503 BEFORE
    the fan-out, not a degrade."""
    app.dependency_overrides[get_panel_runner_builder] = lambda: _failing_builder(
        ModelTierUnset(Provider.openai, Tier.strong)
    )
    cv_id = _create(client)
    assert _review(client, cv_id).status_code == 503


@pytest.mark.parametrize(
    ("failed_output", "field"),
    [(GatekeeperVerdict, "gatekeeper"), (EditorReport, "editor")],
)
def test_agent_failure_degrades_not_errors(
    client: TestClient, failed_output: type[BaseModel], field: str
) -> None:
    """A single agent's refusal/parse-fail degrades to a `failures` entry (its report null), 200 —
    it does not 422/502 the whole review (dec #5). The other agents still report."""
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(
        raises={failed_output: AgentRefusal("refused")}
    )
    cv_id = _create(client)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text
    bundle = res.json()
    assert bundle[field] is None
    details = {f["detail"] for f in bundle["failures"]}
    assert details == {"AgentRefusal"}
    # a sibling still reported
    assert bundle["slop"] is not None


def test_provider_apierror_degrades(client: TestClient) -> None:
    """The two SDK `APIError` classes are DISTINCT — both must be caught so an Anthropic Spotter
    error (the common transient failure) degrades instead of nuking the whole review. The green gate
    is otherwise blind to this (R2 tech-#15)."""
    req = httpx.Request("POST", "https://provider.test")
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(
        raises={
            SlopReport: AnthropicAPIError("boom", request=req, body=None),
            GatekeeperVerdict: OpenAIAPIError("boom", request=req, body=None),
        }
    )
    cv_id = _create(client)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text
    bundle = res.json()
    assert bundle["slop"] is None and bundle["gatekeeper"] is None
    assert bundle["editor"] is not None and bundle["factCheck"] is not None
    assert {f["agentId"] for f in bundle["failures"]} == {"spotter", "gatekeeper"}


def test_programming_bug_propagates_500(client: TestClient) -> None:
    """A non-`_EXPECTED` exception (a real bug, not a provider outage) must NOT be swallowed — the
    blocking arm propagates it to a 500 rather than hiding it as a degrade (dec #5)."""
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(
        raises={EditorReport: ValueError("bug")}
    )
    cv_id = _create(client)
    # TestClient re-raises a server exception by default — which IS the point: a real bug is not
    # swallowed into a `failures` entry; it propagates (→ a 500 in prod), unlike an outage.
    with pytest.raises(ValueError, match="bug"):
        _review(client, cv_id)


# --- streaming arm ------------------------------------------------------------------------------


def test_stream_emits_one_report_per_agent_then_run_done(client: TestClient) -> None:
    cv_id = _create(client)
    events, headers = _stream_review(client, cv_id)
    started = [e["agentId"] for e in events if e["type"] == "agent_started"]
    reports = [e["agentId"] for e in events if e["type"] == "agent_report"]
    done_ok = [e["agentId"] for e in events if e["type"] == "agent_done" and e["ok"]]
    assert set(started) == {"editor", "fact-checker", "gatekeeper", "spotter"}
    assert set(reports) == {"editor", "fact-checker", "gatekeeper", "spotter"}
    assert set(done_ok) == {"editor", "fact-checker", "gatekeeper", "spotter"}
    assert events[-1]["type"] == "run_done" and events[-1]["ok"] is True
    # Transient review → no persisted run → no X-Run-Id (else the FE mints a fake resultRef).
    assert "x-run-id" not in headers
    assert events[-1].get("resultRef") is None


def test_stream_one_agent_degrades_others_report(client: TestClient) -> None:
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(
        raises={GatekeeperVerdict: AgentParseError("bad json")}
    )
    cv_id = _create(client)
    events, _ = _stream_review(client, cv_id)
    failed = [e for e in events if e["type"] == "agent_done" and not e["ok"]]
    assert [e["agentId"] for e in failed] == ["gatekeeper"]
    assert failed[0]["detail"] == "AgentParseError"
    # the run still completes successfully (advisory degrade, not a run failure)
    assert events[-1]["type"] == "run_done" and events[-1]["ok"] is True


def test_stream_preflight_unset_tier_is_503_not_a_stream(client: TestClient) -> None:
    app.dependency_overrides[get_panel_runner_builder] = lambda: _failing_builder(
        ModelTierUnset(Provider.openai, Tier.strong)
    )
    cv_id = _create(client)
    res = client.post(
        f"/workspaces/default/cv/{cv_id}/review",
        json={"baseVersion": 1},
        headers={"accept": "text/event-stream"},
    )
    assert res.status_code == 503


def test_stream_propagating_bug_ends_in_run_done_false(client: TestClient) -> None:
    """A non-`_EXPECTED` bug inside the fan-out can't become an HTTP status (the 200 is committed):
    `_review_execute` turns it into a terminal `RunDone(ok=false)` so the stream always ends."""
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(
        raises={EditorReport: ValueError("bug")}
    )
    cv_id = _create(client)
    events, _ = _stream_review(client, cv_id)
    assert events[-1]["type"] == "run_done" and events[-1]["ok"] is False
    assert events[-1]["detail"] == "ValueError"


# --- concurrency seam (R2) — offline guard; prod-safety needs the live drive --------------------


def test_run_review_fans_out_concurrently() -> None:
    """All four agents must be in-flight AT ONCE: each fake runner waits on a 4-party barrier, so a
    sequential gather would deadlock (caught by the wait_for timeout). Proves the gather is real
    concurrency, not sequential."""

    async def scenario() -> object:
        barrier = asyncio.Barrier(4)

        async def runner(*, output: type[TOut], **_: object) -> TOut:
            await barrier.wait()
            return output.model_validate(_SAMPLES[output].model_dump(by_alias=True))

        return await asyncio.wait_for(
            run_review(
                _model_cv(),
                sample_master_profile(),
                sample_job_spec(),
                1,
                runner=runner,
                resolve=_panel_resolve,
            ),
            timeout=5,
        )

    bundle = asyncio.run(scenario())
    assert isinstance(bundle, BaseModel)
    assert bundle.gatekeeper and bundle.editor and bundle.fact_check and bundle.slop  # type: ignore[attr-defined]
    assert bundle.failures == []  # type: ignore[attr-defined]


def test_run_review_cancels_siblings_on_unexpected_error() -> None:
    """A real bug in one member propagates (dec #5) AND the gather cancels + AWAITS the
    still-running siblings before re-raising, so their billed provider calls don't leak past the
    failure (PR #35 Codex P2). The bare-`gather` it replaces cancels but returns without awaiting,
    so the siblings' cancellation handlers wouldn't have run by then — this asserts they do."""

    async def scenario() -> None:
        cancelled: set[str] = set()

        async def runner(*, output: type[TOut], **_: object) -> TOut:
            if output is EditorReport:
                await asyncio.sleep(0)  # let the siblings park first
                raise ValueError("bug")  # a non-_EXPECTED bug, not a provider outage
            try:
                await asyncio.sleep(3600)  # block until cancelled by the fan-out
            except asyncio.CancelledError:
                cancelled.add(output.__name__)
                raise
            return output.model_validate(_SAMPLES[output].model_dump(by_alias=True))

        with pytest.raises(ValueError, match="bug"):
            await asyncio.wait_for(
                run_review(
                    _model_cv(),
                    sample_master_profile(),
                    sample_job_spec(),
                    1,
                    runner=runner,
                    resolve=_panel_resolve,
                ),
                timeout=5,
            )
        # All three siblings were cancelled AND awaited (handlers ran) before the bug re-raised.
        assert cancelled == {"SlopReport", "FactCheckReport", "GatekeeperVerdict"}

    asyncio.run(scenario())


# --- gatekeeper languages slice (DevPR42) -------------------------------------------------------


def test_gatekeeper_build_input_includes_declared_languages() -> None:
    text = gatekeeper.build_input(
        GatekeeperContext(
            cv=_model_cv(),
            job=sample_job_spec(),
            languages=(
                Language(language="French", fluency="Native speaker"),
                Language(language="German", fluency="B2"),
            ),
        )
    )
    assert "CANDIDATE LANGUAGES" in text
    assert "French" in text


def test_gatekeeper_build_input_no_languages_no_heading() -> None:
    text = gatekeeper.build_input(GatekeeperContext(cv=_model_cv(), job=sample_job_spec()))
    assert "CANDIDATE LANGUAGES" not in text


def test_run_review_feeds_languages_to_gatekeeper_only() -> None:
    """The orchestrator hands the master's declared languages to the Gatekeeper alone: only its
    input gains the dedicated CANDIDATE LANGUAGES section."""

    async def scenario() -> dict[str, str]:
        captured: dict[str, str] = {}

        async def runner(*, agent_id: str, user: str, output: type[TOut], **_: object) -> TOut:
            captured[agent_id] = user
            return output.model_validate(_SAMPLES[output].model_dump(by_alias=True))

        # NEVER mutate the shared factory profile — copy-with-update keeps it languages-free.
        master = sample_master_profile().model_copy(
            update={
                "languages": [
                    Language(language="French", fluency="Native speaker"),
                    Language(language="German", fluency="B2"),
                ]
            }
        )
        await run_review(
            _model_cv(), master, sample_job_spec(), 1, runner=runner, resolve=_panel_resolve
        )
        return captured

    captured = asyncio.run(scenario())
    assert "CANDIDATE LANGUAGES" in captured["gatekeeper"]
    assert "CANDIDATE LANGUAGES" not in captured["editor"]
    # HEADING-only assertion for the fact-checker: it legitimately receives the languages CONTENT
    # (they ride in its full MASTER PROFILE JSON dump) — only the dedicated section must be absent.
    assert "CANDIDATE LANGUAGES" not in captured["fact-checker"]


def test_build_panel_runner_is_session_free(
    sqlite_maker: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    """`build_panel_runner` resolves both tiers + builds both clients SERIALLY up front (the only
    session work), then returns a (runner, resolve) pair that touches NO session — so the fan-out's
    `asyncio.gather` is network-only. Here the session is CLOSED before we call the pair, so any
    session access would raise; and the client stubs must actually be CALLED (a stale singleton
    would falsely pass — R2 Codex-#6)."""
    invalidate_client(Provider.openai)
    invalidate_client(Provider.anthropic)
    calls = {"oai": 0, "ant": 0, "run_openai": 0, "run_claude": 0}

    async def fake_get_openai_client(_session: AsyncSession) -> object:
        calls["oai"] += 1
        return object()

    async def fake_get_anthropic_client(_session: AsyncSession) -> object:
        calls["ant"] += 1
        return object()

    async def fake_run_openai(*, output: type[TOut], **_: object) -> TOut:
        calls["run_openai"] += 1
        return output.model_validate(_SAMPLES[output].model_dump(by_alias=True))

    async def fake_run_claude(*, output: type[TOut], **_: object) -> TOut:
        calls["run_claude"] += 1
        return output.model_validate(_SAMPLES[output].model_dump(by_alias=True))

    monkeypatch.setattr(registry, "get_openai_client", fake_get_openai_client)
    monkeypatch.setattr(registry, "get_anthropic_client", fake_get_anthropic_client)
    monkeypatch.setattr(registry, "run_openai", fake_run_openai)
    monkeypatch.setattr(registry, "run_claude", fake_run_claude)

    async def scenario() -> None:
        async with sqlite_maker() as seed:
            seed.add(ProviderModels(provider="openai", tier_strong="m-oai"))
            seed.add(ProviderModels(provider="anthropic", tier_strong="m-ant"))
            await seed.commit()
        async with sqlite_maker() as session:
            runner, resolve = await build_panel_runner(session)
        # Built up front (both client stubs actually called — not a cached singleton).
        assert calls["oai"] == 1 and calls["ant"] == 1
        # Session is now closed; the pair must work without touching it.
        assert await resolve(Provider.openai, Tier.strong) == "m-oai"
        assert await resolve(Provider.anthropic, Tier.strong) == "m-ant"
        await runner(
            provider=Provider.openai,
            model="m-oai",
            system="s",
            user="u",
            output=GatekeeperVerdict,
            agent_id="gatekeeper",
        )
        await runner(
            provider=Provider.anthropic,
            model="m-ant",
            system="s",
            user="u",
            output=SlopReport,
            agent_id="spotter",
        )
        assert calls["run_openai"] == 1 and calls["run_claude"] == 1

    asyncio.run(scenario())
    invalidate_client(Provider.openai)
    invalidate_client(Provider.anthropic)


# --- fact-check sourceId server authority -------------------------------------------------------


def _fc_thread(verdict: FactVerdict, source_id: str | None) -> FactCheckThread:
    return FactCheckThread(
        # b1 in _model_cv → item i1 → master work "exampleco-integration-mgr"
        anchor_id="b1",
        anchor_kind=AnchorKind.bullet,
        severity=Severity.minor,
        comment="c",
        claim="claim",
        verdict=verdict,
        source_id=source_id,
    )


def test_fact_check_authority_grounds_sourceid_per_item() -> None:
    """`sourceId` is validated against the anchored item's source-work highlights
    (`exampleco-1`/`exampleco-2`); the floor and unsupported-clears-citation rule hold.
    """
    cv = _model_cv()
    master = sample_master_profile()
    report = FactCheckReport(
        threads=[
            _fc_thread(FactVerdict.supported, "exampleco-1"),  # valid → kept
            _fc_thread(FactVerdict.supported, "bogus"),  # out-of-scope → nulled → downgraded
            _fc_thread(
                FactVerdict.unsupported, "exampleco-2"
            ),  # unsupported MUST drop its citation
            _fc_thread(FactVerdict.supported, None),  # no source → downgraded to unsupported
        ]
    )
    out = apply_fact_check_authority(report, cv, master)
    results = [(t.verdict, t.source_id) for t in out.threads]
    assert results == [
        (FactVerdict.supported, "exampleco-1"),
        (FactVerdict.unsupported, None),
        (FactVerdict.unsupported, None),
        (FactVerdict.unsupported, None),
    ]


# --- persisted review runs (ADR 0013) -----------------------------------------------------------


def _get_review(client: TestClient, cv_id: str, workspace: str = "default") -> httpx.Response:
    res: httpx.Response = client.get(f"/workspaces/{workspace}/cv/{cv_id}/review")
    return res


def _put_decisions(
    client: TestClient,
    cv_id: str,
    decisions: dict[str, str],
    cv_version: int,
    workspace: str = "default",
) -> httpx.Response:
    res: httpx.Response = client.put(
        f"/workspaces/{workspace}/cv/{cv_id}/review/decisions",
        json={"decisions": decisions, "cvVersion": cv_version},
    )
    return res


async def _raising_save(_session: AsyncSession, **_: object) -> None:
    """A clean save failure that does NOT dirty the session (no pending work)."""
    raise RuntimeError("save boom")


async def _dirty_failing_save(session: AsyncSession, **_: object) -> None:
    """A COMMIT-TIME save failure that DIRTIES the session (a bad row → NOT NULL violation on the
    `cv_version` integer column at flush), so the tombstone's rollback-before-delete ordering is
    actually exercised (without the rollback the conditional delete would raise
    `PendingRollbackError`). Note a JSON column stores Python `None` as JSON null, so a NOT NULL
    integer is used to force the DB error."""
    session.add(
        StoredCvReview(
            cv_id="dirtyfail",
            workspace_id="default",
            cv_version=None,  # NOT NULL int → IntegrityError at commit (dirties the session)
            bundle={},
            reviewed_text={},
            decisions={},
        )
    )
    await session.commit()


def test_blocking_review_persists_and_get_roundtrips(client: TestClient) -> None:
    """The blocking arm persists the run at settle; GET returns the exact bundle + a server-derived
    `reviewedText` (bulletId→text) + empty decisions + an `updatedAt`."""
    cv_id = _create(client)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text
    assert "x-review-saved" not in res.headers  # success → no header

    saved = _get_review(client, cv_id)
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body is not None
    assert body["cvId"] == cv_id
    assert body["bundle"]["cvVersion"] == 1
    assert body["bundle"]["gatekeeper"]["decision"] == "borderline"
    assert body["reviewedText"]["b1"] == "Led migration of 40 EDI partners."
    assert body["reviewedText"]["b2"]  # the net-new bullet's text is snapshotted too
    assert body["decisions"] == {}
    assert body["updatedAt"]


def test_blocking_persist_failure_returns_200_bundle_and_header(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A completed (billed) run must not 500 on a save hiccup: 200 + the full bundle + a
    `X-Review-Saved: false` header, and nothing persists (GET → null)."""
    cv_id = _create(client)
    monkeypatch.setattr(review_store, "save_review", _raising_save)
    res = _review(client, cv_id)
    assert res.status_code == 200, res.text
    assert res.json()["gatekeeper"]["decision"] == "borderline"  # bundle intact
    assert res.headers["x-review-saved"] == "false"
    monkeypatch.undo()
    assert _get_review(client, cv_id).json() is None  # nothing restorable


def test_sse_review_persists_at_settle(client: TestClient) -> None:
    """The SSE arm persists BEFORE the terminal RunDone; a later GET restores it. A degraded run
    still persists (its `failures[]` land in the stored bundle)."""
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder(
        raises={GatekeeperVerdict: AgentParseError("bad json")}
    )
    cv_id = _create(client)
    events, _ = _stream_review(client, cv_id)
    assert events[-1]["type"] == "run_done" and events[-1]["ok"] is True

    body = _get_review(client, cv_id).json()
    assert body is not None
    assert body["bundle"]["cvVersion"] == 1
    assert body["bundle"]["gatekeeper"] is None  # degraded agent
    assert {f["agentId"] for f in body["bundle"]["failures"]} == {"gatekeeper"}


def test_sse_forced_save_failure_tombstones_old_row(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With an existing OLDER run stored, a settle-time save that DIRTIES the session then fails at
    commit: the run still succeeds (RunDone ok=true, detail=save_failed) and the stale previous run
    is tombstoned (conditional on its captured updatedAt), so a reload can't restore it."""
    cv_id = _create(client)
    first = _stream_review(client, cv_id)  # persists an older row at v1
    assert first[0][-1]["ok"] is True
    assert _get_review(client, cv_id).json() is not None

    monkeypatch.setattr(review_store, "save_review", _dirty_failing_save)
    events, _ = _stream_review(client, cv_id)
    assert events[-1]["type"] == "run_done"
    assert events[-1]["ok"] is True and events[-1]["detail"] == "save_failed"
    monkeypatch.undo()
    assert _get_review(client, cv_id).json() is None  # old row tombstoned, not restored


def test_rerun_resets_decisions(client: TestClient) -> None:
    """A re-run's settle upsert resets the per-finding decisions to empty."""
    cv_id = _create(client)
    _review(client, cv_id)
    assert _put_decisions(client, cv_id, {"gatekeeper:b1": "accepted"}, 1).status_code == 200
    assert _get_review(client, cv_id).json()["decisions"] == {"gatekeeper:b1": "accepted"}
    _review(client, cv_id)  # re-run
    assert _get_review(client, cv_id).json()["decisions"] == {}


def test_nothing_persists_on_stale_409(client: TestClient) -> None:
    cv_id = _create(client)
    assert _review(client, cv_id, base_version=99).status_code == 409
    assert _get_review(client, cv_id).json() is None


def test_nothing_persists_on_503_preflight(client: TestClient) -> None:
    app.dependency_overrides[get_panel_runner_builder] = lambda: _failing_builder(
        ModelTierUnset(Provider.openai, Tier.strong)
    )
    cv_id = _create(client)
    assert _review(client, cv_id).status_code == 503
    app.dependency_overrides[get_panel_runner_builder] = lambda: _fake_builder()
    assert _get_review(client, cv_id).json() is None


def test_nothing_persists_on_unknown_cv(client: TestClient) -> None:
    _put_master(client)
    assert _review(client, "nope", base_version=1).status_code == 404
    assert _get_review(client, "nope").json() is None


def test_get_review_200_null_when_absent(client: TestClient) -> None:
    cv_id = _create(client)  # created but never reviewed
    res = _get_review(client, cv_id)
    assert res.status_code == 200
    assert res.json() is None


def test_get_review_200_null_on_junk_bundle(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """A stored bundle that no longer validates against the current `ReviewBundle` self-heals to
    200-null (schema skew), not a 500."""
    cv_id = _create(client)

    async def seed_junk() -> None:
        async with sqlite_maker() as session:
            session.add(
                StoredCvReview(
                    cv_id=cv_id,
                    workspace_id="default",
                    cv_version=1,
                    bundle={"totally": "not a review bundle"},
                    reviewed_text={},
                    decisions={},
                )
            )
            await session.commit()

    asyncio.run(seed_junk())
    res = _get_review(client, cv_id)
    assert res.status_code == 200
    assert res.json() is None


def test_put_decisions_roundtrip_and_guards(client: TestClient) -> None:
    cv_id = _create(client)
    _review(client, cv_id)
    # roundtrip
    assert _put_decisions(client, cv_id, {"t1": "accepted", "t2": "rejected"}, 1).status_code == 200
    assert _get_review(client, cv_id).json()["decisions"] == {"t1": "accepted", "t2": "rejected"}
    # 409 on a cvVersion mismatch (the review is v1; the client claims it saw v2)
    assert _put_decisions(client, cv_id, {"t1": "accepted"}, 2).status_code == 409


def test_put_decisions_404_when_no_review(client: TestClient) -> None:
    cv_id = _create(client)  # no review stored
    assert _put_decisions(client, cv_id, {"t1": "accepted"}, 1).status_code == 404


def test_put_decisions_422_over_bounds(client: TestClient) -> None:
    cv_id = _create(client)
    _review(client, cv_id)
    too_many = {f"t{i}": "accepted" for i in range(513)}
    assert _put_decisions(client, cv_id, too_many, 1).status_code == 422
    long_key = {"x" * 513: "accepted"}
    assert _put_decisions(client, cv_id, long_key, 1).status_code == 422


def test_real_shaped_threadkeys_fit_the_bound(client: TestClient) -> None:
    """A regression guard: real generated thread keys (kind + anchorId + a uuid-hex suffix) fit
    comfortably under the 512-char key bound, so the DoS guard never rejects a legitimate PUT."""
    cv_id = _create(client)
    _review(client, cv_id)
    keys = {
        f"gatekeeper:{uuid.uuid4().hex}:b1": "accepted",
        f"fact-checker:{uuid.uuid4().hex}:b2": "rejected",
    }
    assert all(len(k) < 512 for k in keys)
    assert _put_decisions(client, cv_id, keys, 1).status_code == 200


def test_review_persist_tenancy(client: TestClient) -> None:
    """Owner reads/writes; a stranger is 403; a cross-workspace GET leaks nothing (null),
    and a cross-workspace decisions PUT is a 404 (mirrors test_review_cross_tenant_404)."""
    cv_id = _create(client, workspace="default")
    _review(client, cv_id)  # persist as OWNER

    app.dependency_overrides[current_user] = lambda: STRANGER
    assert _get_review(client, cv_id).status_code == 403
    assert _put_decisions(client, cv_id, {"t": "accepted"}, 1).status_code == 403

    # OWNER also owns ws2 — a cross-ws read finds no row (zero foreign data) → null; a PUT 404.
    app.dependency_overrides[current_user] = lambda: OWNER
    cross = _get_review(client, cv_id, workspace="ws2")
    assert cross.status_code == 200 and cross.json() is None
    assert _put_decisions(client, cv_id, {"t": "accepted"}, 1, workspace="ws2").status_code == 404


def test_delete_cv_removes_review(client: TestClient) -> None:
    cv_id = _create(client)
    _review(client, cv_id)
    assert _get_review(client, cv_id).json() is not None
    assert client.delete(f"/workspaces/default/cv/{cv_id}").status_code == 200
    assert _get_review(client, cv_id).json() is None


def test_delete_application_removes_review(client: TestClient) -> None:
    """Applying a draft (zero net-new → exportable) locks it; deleting the application removes the
    CV AND its persisted review (that path bypasses cv_store.delete_cv)."""
    cv_id = _create_draft(client)
    _review(client, cv_id)
    applied = client.post(
        "/workspaces/default/applications",
        json={"cvId": cv_id, "jobTitle": "Integration Lead", "baseVersion": 1},
    )
    assert applied.status_code == 200, applied.text
    application_id = applied.json()["id"]
    assert client.delete(f"/workspaces/default/applications/{application_id}").status_code == 200
    # The CV is gone, so a fresh review row can't exist; get_review returns null (row deleted too).
    assert _get_review(client, cv_id).json() is None


def test_apply_corrections_resolves_review_not_deletes(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """ADR 0014: `apply_corrections` RESOLVES the review in place — it keeps the row (at its
    `cv_version`) and records the applied bullets in `resolvedAnchorIds` — instead of deleting it,
    so the candidate's other, un-applied notes survive. Driven at the store layer with a no-op text
    correction (revised == stored) so no Corrector fake is needed; a decision is seeded to prove
    apply PRESERVES decisions (unlike a re-run, which resets them)."""
    cv_id = _create(client)
    _review(client, cv_id)
    # Seed a decision to prove apply preserves it (resolve_threads must not reset decisions).
    assert _put_decisions(client, cv_id, {"editor:bullet:b1:0": "rejected"}, 1).status_code == 200

    async def scenario() -> None:
        async with sqlite_maker() as session:
            await cv_store.apply_corrections(
                session, "default", cv_id, {"b1": "Corrected b1 text."}, {"b1"}, base_version=1
            )
        async with sqlite_maker() as session:
            review = await review_store.get_review(session, "default", cv_id)
            assert review is not None  # kept, NOT deleted
            # Kept at N: the verdict stays visible, stale-marked (ADR 0016); the stored review
            # version is unchanged.
            assert review.cv_version == 1
            assert review.bundle["resolvedAnchorIds"] == ["b1"]  # applied bullet marked resolved
            assert review.decisions == {"editor:bullet:b1:0": "rejected"}  # decisions preserved

    asyncio.run(scenario())


def test_apply_corrections_no_persisted_review_no_ops(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """Apply must run cleanly when NO review row exists — a review whose settle-time save failed
    (ADR 0013 `save_failed`) leaves the client applying from an in-memory-only bundle.
    `resolve_threads` is 0-row-safe (mirrors `delete_review`), so apply won't hit `None.bundle`."""
    cv_id = _create(client)  # no _review → no cv_reviews row

    async def scenario() -> None:
        async with sqlite_maker() as session:
            await cv_store.apply_corrections(
                session, "default", cv_id, {"b1": "Corrected b1 text."}, {"b1"}, base_version=1
            )
        async with sqlite_maker() as session:
            assert await review_store.get_review(session, "default", cv_id) is None  # still no row

    asyncio.run(scenario())


def test_delete_review_no_row_no_op(sqlite_maker: async_sessionmaker[AsyncSession]) -> None:
    """`delete_review` is 0-row-safe (bulk delete, never get-then-raise) — a lifecycle/tombstone
    call that hits no row is a clean no-op."""

    async def scenario() -> None:
        async with sqlite_maker() as session:
            await review_store.delete_review(session, "default", "does-not-exist")
            await session.commit()

    asyncio.run(scenario())


def test_superseded_save_never_regresses_to_newer_row(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """A slow stale-tab run finishing AFTER a newer cv_version's run persisted must not overwrite
    it (`ReviewSuperseded`): the blocking arm returns the bundle with `X-Review-Saved: false`, the
    stored newer row — and its decisions — survive untouched, and nothing is tombstoned."""
    cv_id = _create(client)  # stored CV is v1
    # Simulate "another tab re-ran on a newer CV version and its run persisted first".
    seeded = {"newer:bullet:x:y:0": "accepted"}

    async def seed_newer() -> None:
        async with sqlite_maker() as session:
            session.add(
                StoredCvReview(
                    cv_id=cv_id,
                    workspace_id="default",
                    cv_version=2,
                    bundle={"marker": "newer-run"},
                    reviewed_text={},
                    decisions=dict(seeded),
                )
            )
            await session.commit()

    asyncio.run(seed_newer())
    res = _review(client, cv_id)  # this run reviews the v1 CV → save arrives with cv_version=1
    assert res.status_code == 200
    assert res.headers.get("X-Review-Saved") == "false"

    async def check() -> None:
        async with sqlite_maker() as session:
            row = await review_store.get_review(session, "default", cv_id)
            assert row is not None
            assert row.cv_version == 2  # the newer row won
            assert row.bundle == {"marker": "newer-run"}  # not overwritten, not tombstoned
            assert row.decisions == seeded  # decisions NOT reset by the superseded save

    asyncio.run(check())


def test_save_refused_when_live_cv_advanced_past_reviewed_version(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """ADR 0014 live-CV guard on the UPDATE arm. A review row kept at version N must NOT be
    overwritten by a stale settle at N once the CV has advanced to N+1 (an edit bumped it) —
    `ReviewSuperseded`, original bundle + decisions intact. This is the precondition that makes
    resolve-in-place at apply (keeping the review row instead of deleting it) safe: without the
    guard, `cv_version <= N` still matches the kept row and clobbers it (resurrecting consumed
    notes + resetting decisions)."""
    cv_id = _create(client)  # CV v1
    _review(client, cv_id)  # review row v1
    original = _get_review(client, cv_id).json()
    assert original is not None
    late_bundle = ReviewBundle.model_validate(original["bundle"])  # a v1 run about to settle late

    async def scenario() -> None:
        # An edit bumps the CV to v2 WITHOUT touching the review row (only apply deletes it).
        async with sqlite_maker() as session:
            await cv_store.edit_bullet(
                session, "default", cv_id, "b1", "Reworded bullet text.", base_version=1
            )
        # The stale settle reviewed v1 → tries to save v1 → refused because the live CV is now v2.
        async with sqlite_maker() as session:
            with pytest.raises(review_store.ReviewSuperseded):
                await review_store.save_review(
                    session,
                    workspace_id="default",
                    cv_id=cv_id,
                    cv_version=1,
                    bundle=late_bundle,
                    reviewed_text={},
                )
        async with sqlite_maker() as session:
            row = await review_store.get_review(session, "default", cv_id)
            assert row is not None
            assert row.cv_version == 1  # kept at N, not clobbered back
            assert row.bundle == original["bundle"]  # original run intact

    asyncio.run(scenario())


def test_get_review_orphan_row_self_heals_to_null(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """A `cv_reviews` row whose CV no longer exists (the ADR 0013 lockless-settle orphan) must
    never be served: GET reads 200-null and deletes the orphan (self-heal)."""

    async def seed_orphan() -> None:
        async with sqlite_maker() as session:
            session.add(
                StoredCvReview(
                    cv_id="orphan-cv",
                    workspace_id="default",
                    cv_version=1,
                    bundle={"marker": "orphan"},
                    reviewed_text={},
                    decisions={},
                )
            )
            await session.commit()

    asyncio.run(seed_orphan())
    res = _get_review(client, "orphan-cv")
    assert res.status_code == 200
    assert res.json() is None

    async def check_gone() -> None:
        async with sqlite_maker() as session:
            assert await review_store.get_review(session, "default", "orphan-cv") is None

    asyncio.run(check_gone())


def test_put_decisions_orphan_cv_404(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """Decisions must not land on an orphan review row (CV deleted out from under a settle)."""

    async def seed_orphan() -> None:
        async with sqlite_maker() as session:
            session.add(
                StoredCvReview(
                    cv_id="orphan-cv-2",
                    workspace_id="default",
                    cv_version=1,
                    bundle={"marker": "orphan"},
                    reviewed_text={},
                    decisions={},
                )
            )
            await session.commit()

    asyncio.run(seed_orphan())
    assert _put_decisions(client, "orphan-cv-2", {"k": "accepted"}, 1).status_code == 404


def test_tombstone_skips_rows_newer_than_prior_capture(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """The save-failure tombstone is conditional on the PRE-RUN captured `updated_at`: a row saved
    by a concurrent tab DURING the run (capture is None or older) must survive; only the exact
    pre-run row may be deleted."""
    from app.routes.cv import _tombstone_stale_review

    cv_id = _create(client)
    _review(client, cv_id)  # persist a row

    async def scenario() -> None:
        async with sqlite_maker() as session:
            row = await review_store.get_review(session, "default", cv_id)
            assert row is not None
            stamp = row.updated_at
            # prior=None models "no row existed when this run started" → the row that appeared
            # mid-run survives a tombstone.
            await _tombstone_stale_review(session, "default", cv_id, None)
            assert await review_store.get_review(session, "default", cv_id) is not None
            # the exact pre-run stamp deletes it (the legitimate stale-row case).
            await _tombstone_stale_review(session, "default", cv_id, stamp)
            assert await review_store.get_review(session, "default", cv_id) is None

    asyncio.run(scenario())


def test_late_save_after_apply_does_not_resurrect_review(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """A slow/cross-tab run for an OLD cv_version settling AFTER `apply_corrections` must NOT
    resurrect consumed notes. Apply now RESOLVES the review in place (keeps the row at N, marks the
    applied bullet in `resolvedAnchorIds`) and bumps the CV to N+1; the late save at N is refused by
    `save_review`'s live-CV guard (`ReviewSuperseded`), so the resolved row survives untouched and
    the applied note can never flip back to un-resolved/actionable (ADR 0014)."""
    cv_id = _create(client)
    _review(client, cv_id)
    saved = _get_review(client, cv_id).json()
    assert saved is not None
    late_bundle = ReviewBundle.model_validate(saved["bundle"])  # the v1 run (resolvedAnchorIds=[])

    async def scenario() -> None:
        async with sqlite_maker() as session:
            await cv_store.apply_corrections(
                session, "default", cv_id, {"b1": "Corrected b1 text."}, {"b1"}, base_version=1
            )  # resolves b1 + bumps the CV to v2 (KEEPS the review row at v1)
        async with sqlite_maker() as session:
            with pytest.raises(review_store.ReviewSuperseded):
                await review_store.save_review(
                    session,
                    workspace_id="default",
                    cv_id=cv_id,
                    cv_version=1,
                    bundle=late_bundle,
                    reviewed_text={},
                )
        async with sqlite_maker() as session:
            review = await review_store.get_review(session, "default", cv_id)
            assert review is not None  # kept, not deleted, not clobbered by the late save
            assert review.bundle["resolvedAnchorIds"] == ["b1"]  # consumed note stays resolved

    asyncio.run(scenario())


def test_save_review_refuses_insert_for_deleted_cv(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """The guarded insert selects FROM the CV row itself, so a settle racing a CV delete inserts
    nothing — the settle-vs-delete orphan is prevented structurally at insert time (the read-side
    orphan guard remains as defense-in-depth for legacy rows)."""
    cv_id = _create(client)
    _review(client, cv_id)
    saved = _get_review(client, cv_id).json()
    late_bundle = ReviewBundle.model_validate(saved["bundle"])

    async def scenario() -> None:
        async with sqlite_maker() as session:
            await cv_store.delete_cv(session, "default", cv_id)  # removes CV + review row
        async with sqlite_maker() as session:
            with pytest.raises(review_store.ReviewSuperseded):
                await review_store.save_review(
                    session,
                    workspace_id="default",
                    cv_id=cv_id,
                    cv_version=1,
                    bundle=late_bundle,
                    reviewed_text={},
                )
        async with sqlite_maker() as session:
            assert await review_store.get_review(session, "default", cv_id) is None

    asyncio.run(scenario())
