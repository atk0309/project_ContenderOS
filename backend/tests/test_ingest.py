"""Workspace ingestion routes + store + apply, offline (SQLite `sqlite_maker` + fake runner).

Covers the PR-B1 spine: paste → Extractor → net-new proposals → owner accept → master built. Plus
the mandated security tests (owner-allow, non-member-deny, cross-tenant run scoping), the
one-open-run guard, the optimistic lock, staleness, and the first-run identity gate. No network, no
live key — the runner is faked and returns a canned `ExtractedProfile`.
"""

from __future__ import annotations

import asyncio
import io
import json
from collections.abc import Callable, Iterator
from typing import Any, TypeVar

import httpx
import pytest
from app.ai import pdf_text
from app.ai.agents.extractor import (
    ExtractedQualifications,
    ExtractedWorkList,
    RawBasics,
)
from app.ai.agents.ingest import (
    JUDGE_UNAVAILABLE,
    NATIVE_PDF_INPUT,
    _attach_judge,
    _to_basics,
    build_net_new_proposals,
    run_extract,
    run_ingest,
)
from app.ai.agents.judge import JudgeDecision, JudgeReport
from app.ai.agents.reconciler import WorkReconciliation
from app.ai.agents.registry import get_model_resolver, get_runner
from app.ai.ingest_apply import apply_accepted
from app.ai.providers.base import (
    AgentParseError,
    AgentRefusal,
    AgentTruncated,
    Document,
    ProviderKeyMissing,
    ProviderRunner,
)
from app.auth.deps import current_user
from app.main import app
from app.persistence import get_membership_store, ingest_store
from app.persistence.models import StoredIngestionRun, StoredMaster
from app.routes.ingest import _extract, get_resolver_factory, get_runner_factory
from app.schema import AuthUser, MasterProfile, Membership
from app.schema.common import Provider, Tier
from app.schema.ingest import (
    Evidence,
    ExtractedBasics,
    ExtractedCertificate,
    ExtractedEducation,
    ExtractedLanguage,
    ExtractedProfile,
    ExtractedProfileLink,
    ExtractedSkill,
    ExtractedWork,
    IngestionProposal,
    IngestRelationship,
    IngestSourceType,
    IngestUnitKind,
    IngestVerdict,
    ProposalContent,
    ProposalStatus,
)
from app.schema.sse import AgentProgress, AgentStarted, SseEvent
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError
from pypdf import PdfWriter
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.factories import InMemoryMembershipStore, sample_master_profile

OWNER = AuthUser(email="owner@example.com")
STRANGER = AuthUser(email="stranger@example.com")

# Owner is a member of `default` AND `ws2` (so the cross-tenant test exercises a member guessing a
# foreign run id → 404, not merely a non-member → 403).
_STORE = InMemoryMembershipStore(
    [
        Membership(workspace_id="default", email=OWNER.email),
        Membership(workspace_id="ws2", email=OWNER.email),
    ]
)


def sample_extracted() -> ExtractedProfile:
    """A complete-enough extraction to build a valid first-run master (all required Basics
    fields)."""
    return ExtractedProfile(
        basics=ExtractedBasics(
            name="Imported Candidate",
            label="Integration Manager",
            email="jane@example.com",
            phone="+00 111 222 333",
            summary="Integration leader with a decade in EDI.",
            city="Example City",
            region="Example Region",
            country_code="ZZ",
            evidence="Imported Candidate — Integration Manager, Example City",
        ),
        work=[
            ExtractedWork(
                company="ExampleCo",
                position="Integration Manager",
                start_date="2019",
                highlights=["Led migration of 40 EDI partners.", "Cut onboarding time 60%."],
                tags=["integration"],
                evidence="ExampleCo · Integration Manager · 2019",
            )
        ],
        education=[
            ExtractedEducation(
                institution="Example University",
                area="Computer Science",
                study_type="BSc",
                start_date="2010",
                evidence="BSc Computer Science, Example University",
            )
        ],
        skills=[ExtractedSkill(name="EDI", keywords=["AS2"], evidence="Skills: EDI, AS2")],
        languages=[
            ExtractedLanguage(
                language="English", fluency="Native", evidence="Languages: English (Native)"
            )
        ],
    )


_TOut = TypeVar("_TOut", bound=BaseModel)


def _extracted_slice_dict(output: type[BaseModel]) -> dict[str, Any]:
    """The split Extractor calls three section schemas; return the slice of `sample_extracted()`
    matching each call's `output` (as a by-alias dict so `output.model_validate` re-types it)."""
    s = sample_extracted()
    if output is RawBasics:
        b = s.basics
        return RawBasics(
            name=b.name or "",
            label=b.label or "",
            email=b.email or "",
            phone=b.phone or "",
            url=b.url or "",
            summary=b.summary or "",
            city=b.city or "",
            region=b.region or "",
            country_code=b.country_code or "",
            profiles=b.profiles,
            evidence=b.evidence,
        ).model_dump(by_alias=True)
    if output is ExtractedWorkList:
        return ExtractedWorkList(work=s.work).model_dump(by_alias=True)
    if output is ExtractedQualifications:
        return ExtractedQualifications(
            education=s.education,
            skills=s.skills,
            languages=s.languages,
        ).model_dump(by_alias=True)
    if output is WorkReconciliation:
        # Default fake: the Reconciler finds NO match → all extracted work is net-new. Enrich tests
        # override the runner (or call build_reconciled_proposals directly) to return real matches.
        return WorkReconciliation(matches=[]).model_dump(by_alias=True)
    if output is JudgeReport:
        # Default fake: the advisory Judge returns no decisions → every proposal → needs-review.
        return JudgeReport(decisions=[]).model_dump(by_alias=True)
    return s.model_dump(by_alias=True)


def _fake_runner() -> ProviderRunner:
    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[_TOut],
        **_: object,
    ) -> _TOut:
        return output.model_validate(_extracted_slice_dict(output))

    return runner


def _fixed_resolver() -> object:
    async def resolve(provider: object, tier: object) -> str:
        return "fake-model-id"

    return resolve


def _raising_runner(exc: Exception) -> Callable[[], object]:
    def factory() -> object:
        async def runner(*, output: type[BaseModel], **_: object) -> BaseModel:
            raise exc

        return runner

    return factory


def test_run_extract_merges_three_section_calls() -> None:
    """The split Extractor issues one structured-output call PER SECTION (basics/work/quals), in
    order, and merges them into a full ExtractedProfile — proving the assembly + the 3-call shape
    without a key (the single-schema call is rejected by the real API as too complex, ADR 0007)."""
    seen: list[type[BaseModel]] = []

    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[_TOut],
        **_: object,
    ) -> _TOut:
        seen.append(output)
        return output.model_validate(_extracted_slice_dict(output))

    async def resolve(provider: Provider, tier: Tier) -> str:
        return "fake-model-id"

    profile = asyncio.run(run_extract("some cv text", runner=runner, resolve=resolve))
    assert seen == [RawBasics, ExtractedWorkList, ExtractedQualifications]
    assert profile.basics.name == "Imported Candidate"
    assert [w.company for w in profile.work] == ["ExampleCo"]
    assert profile.education and profile.skills
    # Languages ride the qualifications call and are merged into the assembled profile (D2a).
    assert [lang.language for lang in profile.languages] == ["English"]
    # No certificates anywhere: the Extractor stopped emitting them (DevPR31) and the assembled
    # profile has no such field (extra='forbid' would reject one).
    assert not hasattr(profile, "certificates")


def test_extraction_containers_forbid_cross_section_fields() -> None:
    """`extra='forbid'` (CamelModel) — a section call can't silently absorb another section's
    fields, so the split can't quietly drop data (invariant 5)."""
    with pytest.raises(ValidationError):
        ExtractedWorkList.model_validate({"work": [], "education": []})
    with pytest.raises(ValidationError):
        ExtractedQualifications.model_validate({"education": [], "work": []})
    with pytest.raises(ValidationError):
        RawBasics.model_validate({"name": "x", "work": []})


@pytest.fixture
def client(sqlite_maker: async_sessionmaker[AsyncSession]) -> Iterator[TestClient]:
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_membership_store] = lambda: _STORE
    app.dependency_overrides[get_runner] = _fake_runner
    app.dependency_overrides[get_model_resolver] = _fixed_resolver
    # The streaming arm rebuilds runner/resolver from the generator's OWN session via these
    # factories (the request `Depends` closures are torn down once the response finishes) — fake
    # them the same way, ignoring the passed session.
    app.dependency_overrides[get_runner_factory] = lambda: lambda _session: _fake_runner()
    app.dependency_overrides[get_resolver_factory] = lambda: lambda _session: _fixed_resolver()
    try:
        yield TestClient(app, base_url="https://testserver")
    finally:
        app.dependency_overrides.clear()


def _start(client: TestClient, text: str = "My CV text", ws: str = "default") -> httpx.Response:
    res: httpx.Response = client.post(f"/workspaces/{ws}/ingest", json={"text": text})
    return res


def _bulk(
    client: TestClient, run_id: str, proposals: list[dict[str, Any]], action: str = "accept"
) -> httpx.Response:
    items = [{"proposalId": p["proposalId"], "baseVersion": p["version"]} for p in proposals]
    res: httpx.Response = client.post(
        f"/workspaces/default/ingest/{run_id}/decide", json={"items": items, "action": action}
    )
    return res


def _apply(client: TestClient, run_id: str) -> httpx.Response:
    res: httpx.Response = client.post(f"/workspaces/default/ingest/{run_id}/apply")
    return res


def test_paste_returns_review_bundle_of_net_new_proposals(client: TestClient) -> None:
    res = _start(client)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["run"]["status"] == "review"
    kinds = {p["unitKind"] for p in body["proposals"]}
    assert {"basics-field", "work", "education", "skill", "language"} <= kinds
    # Stopped proposing certificates (DevPR31): accepting one sent data into a black hole (nothing
    # renders or edits master certificates). Legacy persisted runs still round-trip — see
    # test_legacy_certificate_proposal_still_round_trips_review_and_apply.
    assert "certificate" not in kinds
    assert all(p["status"] == "pending" for p in body["proposals"])
    # Evidence drawn from the (pasted) source is verifiable; here the canned snippets aren't in the
    # short paste, so they're flagged unverified — shown, never blocking.
    assert all("evidence" in p for p in body["proposals"])


def test_paste_empty_text_is_422(client: TestClient) -> None:
    assert _start(client, text="   ").status_code == 422


def test_paste_503_when_tier_unset(client: TestClient) -> None:
    # Real resolver against the empty SQLite DB → ModelTierUnset → 503, before any run row is
    # opened.
    app.dependency_overrides.pop(get_model_resolver, None)
    assert _start(client).status_code == 503


def test_non_member_denied(client: TestClient) -> None:
    app.dependency_overrides[current_user] = lambda: STRANGER
    assert _start(client).status_code == 403
    assert client.get("/workspaces/default/ingest").status_code == 403


def test_unknown_run_is_404(client: TestClient) -> None:
    assert client.get("/workspaces/default/ingest/nope").status_code == 404


def test_cross_tenant_run_is_404_not_a_leak(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """A run seeded in `ws2` must not be reachable through `default` even by a member of both."""

    async def seed() -> str:
        async with sqlite_maker() as s:
            row = await ingest_store.create_run(
                s,
                workspace_id="ws2",
                source_type=IngestSourceType.pasted,
                doc_text="x",
                master=None,
            )
            return row.id

    run_id = asyncio.run(seed())
    assert client.get(f"/workspaces/default/ingest/{run_id}").status_code == 404
    assert client.get(f"/workspaces/ws2/ingest/{run_id}").status_code == 200


def test_one_open_run_per_workspace_409(client: TestClient) -> None:
    assert _start(client).status_code == 200  # opens a run (status review)
    second = _start(client)
    assert second.status_code == 409


def test_accept_all_then_apply_builds_master(client: TestClient) -> None:
    body = _start(client).json()
    run_id = body["run"]["id"]
    assert _bulk(client, run_id, body["proposals"]).status_code == 200
    res = _apply(client, run_id)
    assert res.status_code == 200, res.text
    result = res.json()
    assert result["appliedCount"] >= 1
    master = result["master"]
    assert master["basics"]["name"] == "Imported Candidate"
    assert master["basics"]["location"]["countryCode"] == "ZZ"
    assert len(master["work"]) == 1 and master["work"][0]["company"] == "ExampleCo"
    assert len(master["work"][0]["highlights"]) == 2
    # The extracted language lands on the built master (D2a end-to-end: extract → propose → apply).
    assert [lang_["language"] for lang_ in master["languages"]] == ["English"]
    assert master["languages"][0]["fluency"] == "Native"
    # The built master is now the workspace's stored master.
    got = client.get("/workspaces/default/master")
    assert got.status_code == 200
    assert got.json()["basics"]["email"] == "jane@example.com"


def test_legacy_certificate_proposal_still_round_trips_review_and_apply(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """DevPR31 stopped PROPOSING certificates, but a pre-DevPR31 run persisted with a certificate
    proposal must still round-trip end to end: the review read returns it, accept works, and apply
    merges it into the master — the kept `IngestUnitKind.certificate` +
    `ProposalContent.certificate` + apply-time merge (`ingest_apply`). Locks the
    open-runs-in-prod guarantee; seeds the legacy state store-side, exactly how such a run exists
    in the DB."""
    assert (
        client.put(
            "/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True)
        ).status_code
        == 200
    )
    stored = MasterProfile.model_validate(client.get("/workspaces/default/master").json())

    legacy = IngestionProposal(
        proposal_id="legacy-cert-1",
        unit_kind=IngestUnitKind.certificate,
        summary="Certificate: TOGAF",
        content=ProposalContent(
            certificate=ExtractedCertificate(
                name="TOGAF", issuer="The Open Group", date="2021", evidence="TOGAF, 2021"
            )
        ),
        evidence=Evidence(snippet="TOGAF, 2021", verified=False),
        status=ProposalStatus.pending,
        version=1,
    )

    async def seed_legacy_run() -> str:
        async with sqlite_maker() as s:
            row = await ingest_store.create_run(
                s,
                workspace_id="default",
                source_type=IngestSourceType.pasted,
                doc_text="Certificates: TOGAF (The Open Group), 2021",
                master=stored,
            )
            await ingest_store.save_proposals_and_review(
                s, workspace_id="default", run_id=row.id, proposals=[legacy]
            )
            return row.id

    run_id = asyncio.run(seed_legacy_run())

    # Review read: the persisted legacy proposal still reaches the review screen.
    bundle = client.get(f"/workspaces/default/ingest/{run_id}").json()
    [p] = bundle["proposals"]
    assert p["unitKind"] == "certificate" and p["status"] == "pending"
    assert p["content"]["certificate"]["name"] == "TOGAF"

    # Accept + apply: the kept apply-time merge lands it on the stored master.
    assert _bulk(client, run_id, [p]).status_code == 200
    res = _apply(client, run_id)
    assert res.status_code == 200, res.text
    certs = res.json()["master"]["certificates"]
    assert any(
        c["name"] == "TOGAF" and c["issuer"] == "The Open Group" and c["date"] == "2021"
        for c in certs
    )


def test_decide_optimistic_lock_409(client: TestClient) -> None:
    body = _start(client).json()
    run_id = body["run"]["id"]
    p = body["proposals"][0]
    url = f"/workspaces/default/ingest/{run_id}/proposals/{p['proposalId']}"
    ok = client.post(url, json={"action": "accept", "baseVersion": p["version"]})
    assert ok.status_code == 200
    # Same baseVersion again — the proposal moved on, so a stale write is a 409.
    stale = client.post(url, json={"action": "decline", "baseVersion": p["version"]})
    assert stale.status_code == 409


def test_bulk_accept_rejects_unknown_proposal_404(client: TestClient) -> None:
    body = _start(client).json()
    run_id = body["run"]["id"]
    res = client.post(
        f"/workspaces/default/ingest/{run_id}/decide",
        json={"items": [{"proposalId": "ghost", "baseVersion": 1}], "action": "accept"},
    )
    assert res.status_code == 404


def _basics(body: dict[str, Any], *field_paths: str) -> list[dict[str, Any]]:
    """The basics-field proposals matching the given `basics.*` fieldPaths."""
    return [
        p
        for p in body["proposals"]
        if p["unitKind"] == "basics-field" and p["content"]["field"]["fieldPath"] in field_paths
    ]


def test_apply_incomplete_identity_is_422(client: TestClient) -> None:
    """Accept only the work entry (no name/email) → a first-run master has no identity → 422 with a
    HUMAN message (the friendly field names), not raw `basics.*` paths and never a 500."""
    body = _start(client).json()
    run_id = body["run"]["id"]
    work = [p for p in body["proposals"] if p["unitKind"] == "work"]
    assert _bulk(client, run_id, work).status_code == 200
    res = _apply(client, run_id)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "name" in detail and "email" in detail
    assert "basics." not in detail  # jargon paths must not leak to the owner


def test_apply_minimal_identity_succeeds_and_defaults_recommended(client: TestClient) -> None:
    """The core relax: accepting ONLY name + email (no headline/phone/location/summary) builds a
    valid master — the recommended fields default empty, the import does not block."""
    body = _start(client).json()
    run_id = body["run"]["id"]
    nm = _basics(body, "basics.name", "basics.email")
    assert len(nm) == 2
    assert _bulk(client, run_id, nm).status_code == 200
    res = _apply(client, run_id)
    assert res.status_code == 200, res.text
    basics = res.json()["master"]["basics"]
    assert basics["name"] and basics["email"]
    assert basics["label"] == "" and basics["phone"] == "" and basics["summary"] == ""
    assert basics["location"] == {"city": "", "region": "", "countryCode": ""}


def test_apply_rejects_edited_blank_basics_value(client: TestClient) -> None:
    """An owner edit can't smuggle whitespace into a required identity field: an accepted basics
    proposal edited to " " is rejected at the apply boundary (the authoritative invariant-2 gate),
    so a first-run master is missing that required field → 422, never a master with a blank name."""
    body = _start(client).json()
    run_id = body["run"]["id"]
    name = next(
        p
        for p in body["proposals"]
        if p["unitKind"] == "basics-field" and p["content"]["field"]["fieldPath"] == "basics.name"
    )
    edited = client.post(
        f"/workspaces/default/ingest/{run_id}/proposals/{name['proposalId']}",
        json={
            "action": "accept",
            "baseVersion": name["version"],
            "edited": {"field": {"fieldPath": "basics.name", "value": " "}},
        },
    )
    assert edited.status_code == 200
    rest = [p for p in body["proposals"] if p["proposalId"] != name["proposalId"]]
    assert _bulk(client, run_id, rest).status_code == 200
    res = _apply(client, run_id)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "name" in detail and "basics.name" not in detail


def test_apply_refuses_when_master_changed_409(client: TestClient) -> None:
    """A manual master save between starting a run and applying it → staleness 409 (re-import)."""
    body = _start(client).json()
    run_id = body["run"]["id"]
    assert _bulk(client, run_id, body["proposals"]).status_code == 200
    saved = client.put(
        "/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True)
    )
    assert saved.status_code == 200
    assert _apply(client, run_id).status_code == 409


def test_apply_tolerates_a_legacy_snapshot_missing_an_additive_field(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """A run reconciled against an existing master BEFORE an additive MasterProfile field (e.g.
    `languages`) shipped must still apply after the deploy — `apply_run` re-hashes the run's STORED
    snapshot with the current serializer, so the new field (defaulting `[]`) cancels on both sides
    and an UNCHANGED master is NOT falsely staled. Simulates the pre-deploy state: strip `languages`
    from the stored snapshot AND corrupt the frozen `snapshot_hash` (apply must ignore it and
    re-hash the snapshot). Without the fix this 409s."""
    # Precondition: the sample master has NO languages, so stripping `languages` from the snapshot
    # below faithfully models a pre-`languages` blob. If the factory ever gains one, fail loudly
    # here (a clear assertion), not as a confusing 409 when the additive field no longer cancels.
    assert sample_master_profile().languages == []
    client.put("/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True))
    body = _start(client).json()  # reconciles against the existing master
    run_id = body["run"]["id"]
    netnew = [p for p in body["proposals"] if p["relationship"] == "net-new"]
    assert _bulk(client, run_id, netnew).status_code == 200  # corrections stay pending (inv. 2)

    async def make_snapshot_legacy() -> None:
        async with sqlite_maker() as s:
            row = await s.get(StoredIngestionRun, run_id)
            assert row is not None and row.master_snapshot is not None
            snap = dict(row.master_snapshot)
            snap.pop("languages", None)  # a snapshot captured before the field existed
            row.master_snapshot = snap
            row.snapshot_hash = (
                "stale-frozen-hash"  # apply must IGNORE this (re-hashes the snapshot)
            )
            await s.commit()

    asyncio.run(make_snapshot_legacy())
    # The live master is unchanged (still languages=[]), so apply must NOT 409 despite the snapshot
    # lacking the field and the frozen hash being wrong.
    assert _apply(client, run_id).status_code == 200


def test_apply_fails_closed_on_an_unparseable_snapshot(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """If the stored snapshot no longer validates (a future NON-additive schema change leaves an
    unknown key — `CamelModel` is `extra='forbid'`), apply must fail closed to a re-import (409
    StaleMaster), NEVER a 500. Guards the re-hash path's `model_validate`."""
    client.put("/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True))
    run_id = _start(client).json()["run"]["id"]

    async def corrupt_snapshot() -> None:
        async with sqlite_maker() as s:
            row = await s.get(StoredIngestionRun, run_id)
            assert row is not None and row.master_snapshot is not None
            snap = dict(row.master_snapshot)
            snap["__removed_legacy_field__"] = (
                "x"  # unknown key → extra='forbid' rejects on validate
            )
            row.master_snapshot = snap
            await s.commit()

    asyncio.run(corrupt_snapshot())
    assert _apply(client, run_id).status_code == 409  # fail closed, not a 500


def test_apply_fails_closed_on_an_unparseable_live_master(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """If the LIVE stored master no longer validates (`get_master` also `model_validate`s — the
    second validation point in the staleness check), apply must fail closed to a re-import (409),
    never a 500. Guards the live-master read, not just the snapshot."""
    client.put("/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True))
    run_id = _start(client).json()["run"]["id"]

    async def corrupt_live_master() -> None:
        async with sqlite_maker() as s:
            row = await s.get(StoredMaster, "default")
            assert row is not None
            blob = dict(row.master)
            blob["__removed_legacy_field__"] = (
                "x"  # unknown key → extra='forbid' rejects on validate
            )
            row.master = blob
            await s.commit()

    asyncio.run(corrupt_live_master())
    assert _apply(client, run_id).status_code == 409  # fail closed, not a 500


def test_discard_frees_the_workspace(client: TestClient) -> None:
    run_id = _start(client).json()["run"]["id"]
    assert _start(client).status_code == 409  # blocked while the run is open
    discarded = client.post(f"/workspaces/default/ingest/{run_id}/discard")
    assert discarded.status_code == 200
    assert discarded.json()["status"] == "discarded"
    assert _start(client).status_code == 200  # workspace free again


def test_proposals_are_frozen_after_apply_409(client: TestClient) -> None:
    """Once a run is applied, its proposals can't be mutated — the audit trail of what the owner
    approved is frozen (a late decide is a 409, not a silent rewrite)."""
    body = _start(client).json()
    run_id = body["run"]["id"]
    assert _bulk(client, run_id, body["proposals"]).status_code == 200
    assert _apply(client, run_id).status_code == 200
    p = body["proposals"][0]
    late = client.post(
        f"/workspaces/default/ingest/{run_id}/proposals/{p['proposalId']}",
        json={"action": "decline", "baseVersion": p["version"]},
    )
    assert late.status_code == 409


def test_failed_extraction_does_not_wedge_the_workspace(client: TestClient) -> None:
    """A model refusal surfaces (422) AND marks the run failed, so the one-open-run guard doesn't
    block the next import on a dead run."""
    app.dependency_overrides[get_runner] = _raising_runner(AgentRefusal("model declined"))
    assert _start(client).status_code == 422
    runs = client.get("/workspaces/default/ingest").json()
    assert runs and runs[0]["status"] == "failed"
    app.dependency_overrides[get_runner] = _fake_runner
    assert _start(client).status_code == 200  # not blocked by the failed run


def test_bulk_decide_unknown_run_is_404(client: TestClient) -> None:
    res = client.post(
        "/workspaces/default/ingest/nope/decide", json={"items": [], "action": "accept"}
    )
    assert res.status_code == 404


def test_import_into_existing_master_reconciles(client: TestClient) -> None:
    """Importing into an existing master (PR-E): a NEW role is appended (net-new); a basics field
    that DIFFERS is a `correction` carrying the live `currentValue`; an equal field is suppressed.
    Bulk 'add all new items' flips only net-new units (a correction submitted in bulk is 422), so a
    differing name is never silently overwritten — the owner accepts a correction per item."""
    client.put("/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True))
    body = _start(client).json()
    run_id = body["run"]["id"]
    props = body["proposals"]

    def field_path(p: dict[str, Any]) -> str | None:
        return (p["content"].get("field") or {}).get("fieldPath")

    name = next(p for p in props if field_path(p) == "basics.name")
    assert name["relationship"] == "correction"  # extracted name differs from the master's
    assert name["currentValue"] == "Sample Candidate"
    assert not any(field_path(p) == "basics.label" for p in props)  # equal → suppressed

    # The Reconciler found no match (default fake) so the imported role is net-new.
    assert any(p["unitKind"] == "work" and p["relationship"] == "net-new" for p in props)
    # Bulk-accept can't sweep a correction (server-enforced net-new predicate, invariant 2).
    assert _bulk(client, run_id, [name]).status_code == 422
    # Add only the net-new units; the corrections stay pending.
    netnew = [p for p in props if p["relationship"] == "net-new"]
    assert _bulk(client, run_id, netnew).status_code == 200
    res = _apply(client, run_id)
    assert res.status_code == 200, res.text
    master = res.json()["master"]
    assert master["basics"]["name"] == "Sample Candidate"  # the correction was not bulk-applied
    assert len(master["work"]) == 2  # the new role was appended


def test_existing_master_without_work_reconciles_basics(client: TestClient) -> None:
    """An existing master with NO work entries still reconciles basics deterministically: a
    differing field is a `correction`, not a net-new 'already set' conflict (the Reconciler model is
    skipped when there's no work to match)."""
    master = sample_master_profile().model_copy(update={"work": []})
    client.put("/workspaces/default/master", json=master.model_dump(by_alias=True))
    props = _start(client).json()["proposals"]
    name = next(
        p for p in props if (p["content"].get("field") or {}).get("fieldPath") == "basics.name"
    )
    assert name["relationship"] == "correction"  # NOT a net-new "already set" conflict
    assert any(p["unitKind"] == "work" and p["relationship"] == "net-new" for p in props)


# --- PR-C: PDF upload --------------------------------------------------------------------------


def _make_pdf(pages: int = 1) -> bytes:
    """A minimal, genuinely-parseable PDF (blank pages → empty pypdf text, which is fine — the fake
    runner returns canned slices regardless of the document content)."""
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def _upload(
    client: TestClient,
    *,
    content: bytes | None = None,
    filename: str = "cv.pdf",
    content_type: str = "application/pdf",
    source_type: str = "cv-pdf",
    ws: str = "default",
) -> httpx.Response:
    res: httpx.Response = client.post(
        f"/workspaces/{ws}/ingest/file",
        files={"file": (filename, _make_pdf() if content is None else content, content_type)},
        data={"sourceType": source_type},
    )
    return res


def test_upload_returns_review_bundle_with_filename(client: TestClient) -> None:
    res = _upload(client)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["run"]["status"] == "review"
    assert body["run"]["sourceType"] == "cv-pdf"
    assert body["run"]["filename"] == "cv.pdf"
    kinds = {p["unitKind"] for p in body["proposals"]}
    assert {"basics-field", "work", "education", "skill", "language"} <= kinds
    assert "certificate" not in kinds  # stopped proposing (DevPR31)


def test_upload_rejects_pasted_source_type_422(client: TestClient) -> None:
    assert _upload(client, source_type="pasted").status_code == 422


def test_upload_rejects_non_pdf_422(client: TestClient) -> None:
    res = _upload(client, content=b"hello", filename="notes.txt", content_type="text/plain")
    assert res.status_code == 422


def test_upload_rejects_unreadable_pdf_422(client: TestClient) -> None:
    # Declared a PDF (by name + type) but not a parseable one → 422, never a raw 500.
    assert _upload(client, content=b"not a pdf at all").status_code == 422


def test_upload_rejects_too_many_pages_413(client: TestClient) -> None:
    assert _upload(client, content=_make_pdf(pages=pdf_text.MAX_PDF_PAGES + 1)).status_code == 413


def test_upload_rejects_oversize_413(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    # The route's chunked read aborts at the byte cap before materializing the whole body.
    monkeypatch.setattr("app.routes.ingest.MAX_PDF_BYTES", 8)
    assert _upload(client).status_code == 413  # a real (blank) PDF is well over 8 bytes


def test_upload_non_member_denied_403(client: TestClient) -> None:
    app.dependency_overrides[current_user] = lambda: STRANGER
    assert _upload(client).status_code == 403


def test_upload_one_open_run_409(client: TestClient) -> None:
    assert _start(client).status_code == 200  # a paste run is now open
    assert _upload(client).status_code == 409  # the workspace allows only one open run


def test_503_after_run_row_marks_run_failed(client: TestClient) -> None:
    """A provider config error raised when the client builds (AFTER the run row exists, the resolver
    pre-flight having passed) → 503 AND the run marked `failed` — not a wedged, forever-open run.
    Guards the shared `_ingest_pipeline` mark-failed path used by both arms."""
    app.dependency_overrides[get_runner] = _raising_runner(ProviderKeyMissing(Provider.anthropic))
    assert _start(client).status_code == 503
    runs = client.get("/workspaces/default/ingest").json()
    assert runs and runs[0]["status"] == "failed"
    app.dependency_overrides[get_runner] = _fake_runner
    assert _start(client).status_code == 200  # the failed run doesn't block the next import


# --- PR-C: the native→text-only extraction fallback (`_extract`) -------------------------------


async def _ok_resolve(provider: Provider, tier: Tier) -> str:
    return "fake-model-id"


def test_extract_passes_through_without_a_document() -> None:
    """The paste path (`document is None`) is a plain single `run_extract` — no fallback logic."""
    profile = asyncio.run(
        _extract("cv text", runner=_fake_runner(), resolve=_ok_resolve, document=None)
    )
    assert profile.basics.name == "Imported Candidate"


def test_extract_falls_back_to_text_only_on_parse_error() -> None:
    """Native (document) parse fails → retry text-only over the pypdf text → succeeds. The native
    attempt's prompt is the NEUTRAL placeholder (not the pypdf text); only the text-only fallback
    reads the doc_text (ADR 0007: pypdf is evidence/fallback only)."""
    calls: list[tuple[object, str]] = []

    async def runner(
        *, user: str = "", output: type[_TOut], document: object = None, **_: object
    ) -> _TOut:
        calls.append((document, user))
        if document is not None:
            raise AgentParseError("native parse failed")
        return output.model_validate(_extracted_slice_dict(output))

    profile = asyncio.run(
        _extract(
            "real cv text", runner=runner, resolve=_ok_resolve, document=Document(data_b64="x")
        )
    )
    neutral = f"### DOCUMENT\n{NATIVE_PDF_INPUT}"
    assert profile.basics.name == "Imported Candidate"
    assert calls[0][0] is not None  # native attempt carried the document
    assert calls[0][1] == neutral  # …with the neutral prompt, not doc_text
    assert [doc for doc, _ in calls[1:]] == [None, None, None]  # retries dropped the document
    assert all("real cv text" in user for _, user in calls[1:])  # fallback reads doc_text


def test_extract_propagates_when_text_fallback_also_fails() -> None:
    async def runner(*, output: type[_TOut], document: object = None, **_: object) -> _TOut:
        raise AgentParseError("always fails")

    with pytest.raises(AgentParseError):
        asyncio.run(
            _extract("real cv", runner=runner, resolve=_ok_resolve, document=Document(data_b64="x"))
        )


def test_extract_does_not_retry_on_empty_doc_text() -> None:
    """A scanned PDF (empty pypdf text) has nothing to retry over → re-raise the native error."""
    calls: list[object] = []

    async def runner(*, output: type[_TOut], document: object = None, **_: object) -> _TOut:
        calls.append(document)
        if document is not None:
            raise AgentParseError("native parse failed")
        return output.model_validate(_extracted_slice_dict(output))

    with pytest.raises(AgentParseError):
        asyncio.run(
            _extract("   ", runner=runner, resolve=_ok_resolve, document=Document(data_b64="x"))
        )
    assert len(calls) == 1  # only the native attempt; no text-only retry


@pytest.mark.parametrize("exc_type", [AgentRefusal, AgentTruncated])
def test_extract_does_not_fall_back_on_refusal_or_truncation(exc_type: type[Exception]) -> None:
    """Refusal (a real decline) and truncation (an output-token limit) must surface loudly, not
    trigger a pointless text-only retry (invariant 5)."""
    calls: list[object] = []

    async def runner(*, output: type[_TOut], document: object = None, **_: object) -> _TOut:
        calls.append(document)
        raise exc_type("nope")

    with pytest.raises(exc_type):
        asyncio.run(
            _extract("real cv", runner=runner, resolve=_ok_resolve, document=Document(data_b64="x"))
        )
    assert len(calls) == 1  # no retry


def test_native_extract_uses_neutral_prompt_not_pypdf_text() -> None:
    """On the (succeeding) native-PDF path every section call's prompt is the neutral placeholder,
    never the pypdf doc_text — the PDF is the input, the pypdf text is evidence/fallback only
    (ADR 0007). A real multi-column LinkedIn export would otherwise feed two rival readings."""
    prompts: list[str] = []

    async def runner(
        *, user: str = "", output: type[_TOut], document: object = None, **_: object
    ) -> _TOut:
        prompts.append(user)
        return output.model_validate(_extracted_slice_dict(output))

    asyncio.run(
        _extract(
            "PYPDF-GARBLED-SENTINEL",
            runner=runner,
            resolve=_ok_resolve,
            document=Document(data_b64="x"),
        )
    )
    neutral = f"### DOCUMENT\n{NATIVE_PDF_INPUT}"
    assert prompts == [neutral] * 3  # basics / work / quals — all neutral
    assert all("PYPDF-GARBLED-SENTINEL" not in p for p in prompts)  # pypdf text never in the prompt


def test_basics_whitespace_only_maps_to_none_and_yields_no_proposal() -> None:
    """A model-emitted " " / "\\t" basics value reads as ABSENT (invariant 2): `_to_basics` maps it
    to None and `build_net_new_proposals` emits no basics proposal, so a stray space can't fill a
    required MasterProfile identity field unseen and slip past the first-run gate."""
    raw = RawBasics(
        name=" ",
        label="",
        email="\t",
        phone="",
        url="",
        summary="  ",
        city="",
        region="",
        country_code="",
        profiles=[],
        evidence="",
    )
    basics = _to_basics(raw)
    assert basics.name is None
    assert basics.email is None
    assert basics.summary is None

    profile = ExtractedProfile(basics=basics)
    proposals = build_net_new_proposals(profile, "some document text")
    assert not any(p.unit_kind is IngestUnitKind.basics_field for p in proposals)


def test_language_proposal_is_built_net_new() -> None:
    """A first-run extraction emits one `language` proposal per language, carrying the language
    content (name + fluency) for the owner to accept (D2a)."""
    profile = ExtractedProfile(
        basics=ExtractedBasics(name="Jane", email="j@example.test", evidence="Jane"),
        languages=[ExtractedLanguage(language="German", fluency="B2", evidence="German B2")],
    )
    langs = [
        p
        for p in build_net_new_proposals(profile, "German B2")
        if p.unit_kind is IngestUnitKind.language
    ]
    assert len(langs) == 1
    assert langs[0].relationship is IngestRelationship.net_new
    assert langs[0].content.language is not None
    assert langs[0].content.language.language == "German"
    assert langs[0].content.language.fluency == "B2"


def test_apply_dedups_languages_by_name_and_fills_blank_fluency() -> None:
    """Apply-time dedup by name (the skills pattern): a re-imported language (any case) doesn't
    duplicate, and a later import with a fluency fills a previously-blank one."""
    profile = ExtractedProfile(
        basics=ExtractedBasics(name="Jane", email="j@example.test", evidence="Jane"),
        languages=[
            ExtractedLanguage(language="English", evidence="English"),
            ExtractedLanguage(language="english", fluency="Native", evidence="english native"),
        ],
    )
    master, conflicts, _ = apply_accepted(None, build_net_new_proposals(profile, "doc"))
    assert not conflicts
    assert [lang.language for lang in master.languages] == ["English"]  # one entry, first casing
    assert master.languages[0].fluency == "Native"  # the later import filled the blank fluency


def test_run_ingest_skips_reconciler_without_extracted_work() -> None:
    """No extracted work → run_ingest makes NO agent call even though the master has work (nothing
    to match); the deterministic basics path still reconciles. Guards a wasted Claude call (and a
    model fault on an empty match list)."""
    master = sample_master_profile()  # has one work entry
    extracted = ExtractedProfile(basics=ExtractedBasics(name="Changed Name", evidence="s"))

    async def runner(*, output: type[_TOut], **_: object) -> _TOut:
        # The Reconciler must NOT be called (no work to match); the advisory Judge still runs.
        if output is WorkReconciliation:
            raise AssertionError("Reconciler must not be called with no work to match")
        return output.model_validate(_extracted_slice_dict(output))

    proposals = asyncio.run(
        run_ingest(extracted, master, "doc", runner=runner, resolve=_ok_resolve)
    )
    assert any(p.relationship is IngestRelationship.correction for p in proposals)


def test_judge_join_defaults_missing_proposals_to_needs_review() -> None:
    """The advisory Judge's verdict is echoed per proposalId; a proposal the Judge omitted (or an
    unknown id) defaults to needs-review."""
    proposals = build_net_new_proposals(sample_extracted(), "doc")
    assert len(proposals) >= 2
    judged = proposals[0]

    async def runner(*, output: type[_TOut], **_: object) -> _TOut:
        report = JudgeReport(
            decisions=[
                JudgeDecision(
                    proposal_id=judged.proposal_id, verdict=IngestVerdict.exclude, reason="noise"
                )
            ]
        )
        return output.model_validate(report.model_dump(by_alias=True))

    asyncio.run(_attach_judge(proposals, runner=runner, resolve=_ok_resolve))
    assert judged.decision is not None and judged.decision.verdict is IngestVerdict.exclude
    assert all(
        p.decision is not None and p.decision.verdict is IngestVerdict.needs_review
        for p in proposals[1:]
    )


@pytest.mark.parametrize(
    "exc",
    [AgentRefusal("judge declined"), RuntimeError("raw openai SDK error")],
    ids=["normalized-AgentError", "raw-SDK-error"],
)
def test_judge_degrades_visibly_on_any_error(exc: Exception) -> None:
    """ANY Judge error — a normalized `AgentError` OR a raw provider/network SDK error (e.g. an
    `openai.APIError` raised before `run_openai` normalizes it) — degrades every proposal to a
    VISIBLE needs-review. The run still reaches review; an OpenAI outage can't block the owner
    (invariant 6)."""
    proposals = build_net_new_proposals(sample_extracted(), "doc")

    async def runner(*, output: type[_TOut], **_: object) -> _TOut:
        raise exc

    asyncio.run(_attach_judge(proposals, runner=runner, resolve=_ok_resolve))
    assert proposals and all(
        p.decision is not None
        and p.decision.verdict is IngestVerdict.needs_review
        and p.decision.reason == JUDGE_UNAVAILABLE
        for p in proposals
    )


def test_judge_outage_does_not_fail_the_run(client: TestClient) -> None:
    """End-to-end: a raw OpenAI SDK error from the advisory Judge does NOT fail the run — it reaches
    review (200) with degraded verdicts, never 502/`failed` (invariant 6: adjudication never
    blocks)."""
    client.put("/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True))

    def runner_judge_down() -> ProviderRunner:
        async def runner(*, output: type[_TOut], **_: object) -> _TOut:
            if output is JudgeReport:
                raise RuntimeError("raw openai sdk error")  # the Judge is down
            return output.model_validate(_extracted_slice_dict(output))

        return runner

    app.dependency_overrides[get_runner] = runner_judge_down
    try:
        res = _start(client)
    finally:
        app.dependency_overrides[get_runner] = _fake_runner
    assert res.status_code == 200, res.text  # NOT 502/failed
    body = res.json()
    assert body["run"]["status"] == "review"
    assert body["proposals"] and all(
        p["decision"]["verdict"] == "needs-review" for p in body["proposals"]
    )


# --- PR-C: pdf_text guard ----------------------------------------------------------------------


def test_extract_pdf_text_reads_a_valid_pdf() -> None:
    assert isinstance(pdf_text.extract_pdf_text(_make_pdf(pages=2)), str)  # no raise; may be empty


def test_extract_pdf_text_rejects_too_many_pages() -> None:
    with pytest.raises(pdf_text.PdfTooManyPages):
        pdf_text.extract_pdf_text(_make_pdf(pages=pdf_text.MAX_PDF_PAGES + 1))


def test_extract_pdf_text_rejects_unreadable_bytes() -> None:
    with pytest.raises(pdf_text.PdfUnreadable):
        pdf_text.extract_pdf_text(b"not a pdf at all")


def test_extract_pdf_text_rejects_oversize(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pdf_text, "MAX_PDF_BYTES", 8)
    with pytest.raises(pdf_text.PdfTooLarge):
        pdf_text.extract_pdf_text(b"x" * 9)


# ---- F3a: SSE streaming progress (Accept: text/event-stream) ----


def _stream_events(client: TestClient, url: str, **post_kwargs: Any) -> list[dict[str, Any]]:
    """POST with `Accept: text/event-stream` and collect the parsed SSE `data:` events up to and
    including `run_done`. Asserts the 200 + content-type, so a non-streamed error fails loudly."""
    events: list[dict[str, Any]] = []
    with client.stream("POST", url, headers={"accept": "text/event-stream"}, **post_kwargs) as res:
        assert res.status_code == 200, res.read()
        assert res.headers["content-type"].startswith("text/event-stream")
        for line in res.iter_lines():
            if line.startswith("data:"):
                event = json.loads(line[len("data:") :].strip())
                events.append(event)
                if event["type"] == "run_done":
                    break
    return events


def test_paste_stream_first_run_emits_extractor_events_then_run_done(client: TestClient) -> None:
    """First run (no master): the stream carries one agent_started/agent_done pair per Extractor
    section in order, then run_done{ok, resultRef}; the run lands in `review`, bundle reloadable."""
    events = _stream_events(client, "/workspaces/default/ingest", json={"text": "My CV"})
    starts = [e["agentId"] for e in events if e["type"] == "agent_started"]
    dones = [e["agentId"] for e in events if e["type"] == "agent_done" and e["ok"]]
    assert starts == ["extractor-basics", "extractor-work", "extractor-qualifications"]
    assert dones == ["extractor-basics", "extractor-work", "extractor-qualifications"]
    # No reconciler/judge on a first run (master is None → net-new, OpenAI-free).
    assert not any(e.get("agentId") in {"reconciler-work", "judge"} for e in events)
    done = events[-1]
    assert done["type"] == "run_done" and done["ok"] is True
    bundle = client.get(f"/workspaces/default/ingest/{done['resultRef']}")
    assert bundle.status_code == 200 and bundle.json()["run"]["status"] == "review"


def test_stream_with_master_emits_reconciler_and_judge_events(client: TestClient) -> None:
    """Reconcile path: with an existing master that has work, the stream adds reconciler-work and
    judge events (the canonical Agent.id vocabulary, shared with the F1 logs and UI checklist)."""
    client.put("/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True))
    events = _stream_events(client, "/workspaces/default/ingest", json={"text": "My CV"})
    agent_ids = {e["agentId"] for e in events if "agentId" in e}
    assert {"reconciler-work", "judge"} <= agent_ids
    assert events[-1]["type"] == "run_done" and events[-1]["ok"] is True


# ---- DevPR33: agent_progress status notes on the ingest stream ----


def test_run_extract_emits_progress_note_after_each_pass() -> None:
    """DevPR33 emission ordering, unit-level: each extractor pass is started -> progress note ->
    terminal done (AgentDone STAYS each agent's terminal event — the documented contract), and the
    run's FIRST event is agent_started — a note may never precede it (the ImportModal's Stop escape
    hatch gates on a non-empty checklist)."""
    events: list[SseEvent] = []

    async def progress(ev: SseEvent) -> None:
        events.append(ev)

    async def resolve(provider: Provider, tier: Tier) -> str:
        return "fake-model-id"

    asyncio.run(
        run_extract("some cv text", runner=_fake_runner(), resolve=resolve, progress=progress)
    )
    assert isinstance(events[0], AgentStarted)  # never a note before the first agent_started
    shape = [(type(e).__name__, getattr(e, "agent_id", None)) for e in events]
    assert shape == [
        ("AgentStarted", "extractor-basics"),
        ("AgentProgress", "extractor-basics"),
        ("AgentDone", "extractor-basics"),
        ("AgentStarted", "extractor-work"),
        ("AgentProgress", "extractor-work"),
        ("AgentDone", "extractor-work"),
        ("AgentStarted", "extractor-qualifications"),
        ("AgentProgress", "extractor-qualifications"),
        ("AgentDone", "extractor-qualifications"),
    ]
    notes = [e.note for e in events if isinstance(e, AgentProgress)]
    # Owner-facing label voice, rendered verbatim in the aria-live status line — no build jargon.
    assert notes == [
        "Contact details captured",
        "Found 1 role in your work history",  # sample_extracted has exactly one role
        "Education, skills & languages captured",
    ]


def test_paste_stream_carries_progress_notes_after_first_started(client: TestClient) -> None:
    """DevPR33, route-level (first run): the SSE stream now carries agent_progress notes; the first
    frame stays agent_started and every note follows it."""
    events = _stream_events(client, "/workspaces/default/ingest", json={"text": "My CV"})
    assert events[0]["type"] == "agent_started"
    notes = [e["note"] for e in events if e["type"] == "agent_progress"]
    assert "Contact details captured" in notes
    assert "Education, skills & languages captured" in notes


def test_stream_with_master_carries_reconciler_and_judge_notes(client: TestClient) -> None:
    """DevPR33, route-level (reconcile path): the reconciler and Judge legs each contribute an
    owner-facing note; the Judge's follows its agent_started (it precedes the Judge's terminal
    AgentDone — an in-flight note)."""
    client.put("/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True))
    events = _stream_events(client, "/workspaces/default/ingest", json={"text": "My CV"})
    notes = [e["note"] for e in events if e["type"] == "agent_progress"]
    assert "Checked your document against your master" in notes
    assert any(n == "Reviewed 1 suggestion" or n.startswith("Reviewed ") for n in notes)
    types = [e["type"] for e in events]
    assert types[0] == "agent_started"
    judge_started = next(
        i for i, e in enumerate(events) if e["type"] == "agent_started" and e["agentId"] == "judge"
    )
    judge_note = next(
        i for i, e in enumerate(events) if e["type"] == "agent_progress" and e["agentId"] == "judge"
    )
    assert judge_started < judge_note


def test_stream_judge_degrade_emits_owner_facing_note(client: TestClient) -> None:
    """DevPR33: a Judge outage still yields an owner-facing note on the stream (the same quiet
    voice as the JUDGE_UNAVAILABLE badge line), and AgentDone stays the Judge's terminal event."""
    client.put("/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True))

    def runner_judge_down() -> ProviderRunner:
        async def runner(*, output: type[_TOut], **_: object) -> _TOut:
            if output is JudgeReport:
                raise RuntimeError("raw openai sdk error")  # the Judge is down
            return output.model_validate(_extracted_slice_dict(output))

        return runner

    app.dependency_overrides[get_runner_factory] = lambda: lambda _s: runner_judge_down()
    try:
        events = _stream_events(client, "/workspaces/default/ingest", json={"text": "My CV"})
    finally:
        app.dependency_overrides[get_runner_factory] = lambda: lambda _s: _fake_runner()
    notes = [e["note"] for e in events if e["type"] == "agent_progress"]
    assert "Suggestions unavailable — everything is ready for your review" in notes
    judge_events = [e["type"] for e in events if e.get("agentId") == "judge"]
    assert judge_events == ["agent_started", "agent_progress", "agent_done"]


def test_paste_stream_failure_emits_run_done_false_and_marks_failed(client: TestClient) -> None:
    """A model refusal mid-stream can't become an HTTP status (the 200 is committed): it surfaces as
    run_done{ok:false}, and the run is marked failed (its kind/reason readable via the bundle)."""
    app.dependency_overrides[get_runner_factory] = lambda: (
        lambda _s: _raising_runner(AgentRefusal("model declined"))()
    )
    events = _stream_events(client, "/workspaces/default/ingest", json={"text": "My CV"})
    # The failing agent gets a terminal AgentDone(ok=false) so the client can name it.
    failed = [e for e in events if e["type"] == "agent_done" and not e["ok"]]
    assert failed and failed[0]["agentId"] == "extractor-basics"
    done = events[-1]
    assert done["type"] == "run_done" and done["ok"] is False
    runs = client.get("/workspaces/default/ingest").json()
    assert runs and runs[0]["status"] == "failed"


def test_stream_preflight_tier_unset_is_503_not_a_stream(client: TestClient) -> None:
    """A pre-flight failure (unset tier) still returns a real HTTP 503 — it happens in the handler
    before the StreamingResponse is constructed, so it's never a 200 stream."""
    app.dependency_overrides.pop(
        get_model_resolver, None
    )  # real resolver, empty DB → ModelTierUnset
    res = client.post(
        "/workspaces/default/ingest",
        json={"text": "My CV"},
        headers={"accept": "text/event-stream"},
    )
    assert res.status_code == 503


def test_stream_open_run_conflict_is_409_not_a_stream(client: TestClient) -> None:
    """The one-open-run guard fires pre-stream too: an open run → 409, not a 200 stream."""
    assert _start(client).status_code == 200  # opens a run (status review)
    res = client.post(
        "/workspaces/default/ingest",
        json={"text": "again"},
        headers={"accept": "text/event-stream"},
    )
    assert res.status_code == 409


def test_blocking_failure_still_maps_to_http_422(client: TestClient) -> None:
    """The blocking arm (no Accept) is byte-for-byte unchanged: the same refusal that streams as
    run_done{ok:false} re-raises to the global 422 mapping when not streaming."""
    app.dependency_overrides[get_runner] = _raising_runner(AgentRefusal("model declined"))
    assert _start(client).status_code == 422


def test_stream_sets_x_run_id_header(client: TestClient) -> None:
    """The stream carries X-Run-Id (available before the body) so a client whose stream drops before
    run_done can load the EXACT run — even a terminal `failed` one the open-run list would miss."""
    run_id: str | None = None
    with client.stream(
        "POST",
        "/workspaces/default/ingest",
        json={"text": "My CV"},
        headers={"accept": "text/event-stream"},
    ) as res:
        assert res.status_code == 200
        run_id = res.headers.get("x-run-id")
        for _ in res.iter_lines():  # drain so the run reaches review before we read it back
            pass
    assert run_id
    bundle = client.get(f"/workspaces/default/ingest/{run_id}")
    assert bundle.status_code == 200 and bundle.json()["run"]["id"] == run_id


def test_education_dedups_by_institution_area_type_on_apply() -> None:
    """A re-imported degree (same institution / area / study-type) must not duplicate the master
    education row — education had no apply-time dedup before, unlike skills and certificates."""
    extracted = sample_extracted()  # education: Example University / Computer Science / BSc
    proposals = build_net_new_proposals(extracted, "doc")
    master, _, _ = apply_accepted(None, proposals)
    assert len(master.education) == 1
    edu_props = [p for p in proposals if p.unit_kind is IngestUnitKind.education]
    again, _, _ = apply_accepted(master, edu_props)
    assert len(again.education) == 1  # deduped, not appended


def test_profile_links_are_proposed_applied_and_url_deduped() -> None:
    """LinkedIn/GitHub profile URLs are extracted into basics.profiles; they must become reviewable
    `profile` proposals, land in the master on apply, and dedup by url on re-import."""
    basics = sample_extracted().basics.model_copy(
        update={
            "profiles": [
                ExtractedProfileLink(network="LinkedIn", url="https://example.com/profile/imported")
            ]
        }
    )
    extracted = sample_extracted().model_copy(update={"basics": basics})
    proposals = build_net_new_proposals(extracted, "https://example.com/profile/imported")
    assert sum(p.unit_kind is IngestUnitKind.profile for p in proposals) == 1
    master, _, _ = apply_accepted(None, proposals)
    assert [p.url for p in master.basics.profiles] == ["https://example.com/profile/imported"]
    profile_props = [p for p in proposals if p.unit_kind is IngestUnitKind.profile]
    again, _, _ = apply_accepted(master, profile_props)
    assert [p.url for p in again.basics.profiles] == [
        "https://example.com/profile/imported"
    ]  # url dedup
