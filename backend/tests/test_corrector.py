"""Corrector apply route (`POST /workspaces/{id}/cv/{cv_id}/apply`) — server authority (DevPR29).

Offline: SQLite stands in for Postgres, the membership store is in-memory so per-workspace
authorization (invariant 8) is exercised, and the AI is faked at TWO seams — the Tailor (seeding a
CV at `create`) via `get_runner`/`get_model_resolver`, and the Corrector via the injectable
`get_authoring_runner_builder` (the route calls `build_authoring_runner` directly, bypassing
`Depends`, exactly like the review fan-out — so the whole builder is faked).

DevPR29 shrank the Corrector to PER-BULLET: its output is `{bulletId -> revised text}` for exactly
the accepted bullets, never a whole CV. So the fake specifies revisions directly (`_set_corrector`),
and `apply_corrections` splices ONLY the accepted bullets' text onto the STORED CV, preserving each
stored `sourceId`/`origin` and re-grounding — server truth persists. Because the model returns text
keyed by an id (never structure), there is no whole-CV structural tripwire anymore: a MISSING
revision for an accepted bullet, or blank/oversized text, is a 422 at splice time, and a
DUPLICATE revision id is a 422 at the route. The lock/concurrency guarantee is Postgres-only (live
drive); here the optimistic-version + provenance authority is what's covered.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, TypeVar

import httpx
import pytest
from app.ai.agents.registry import (
    get_authoring_runner_builder,
    get_model_resolver,
    get_runner,
)
from app.auth.deps import current_user
from app.main import app
from app.persistence import cv_store, get_membership_store
from app.schema import (
    AuthUser,
    Membership,
    TailoredBullet,
    TailoredCV,
    TailoredItem,
    TailoredSection,
)
from app.schema.common import MAX_BULLET_LEN, Origin, Provider, SectionType, Tier
from fastapi.testclient import TestClient
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
    """The Tailor output that seeds the CV at `create`.

    It has a grounded bullet `b1` (source `exampleco-1`) and a bogus-source bullet `b2` the server
    turns net-new (so the CV needs sign-off). The Corrector no longer returns a CV — this is now
    only the create-time template, not a correction seam.
    """
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


def _b2(cv: TailoredCV) -> TailoredBullet:
    return cv.sections[0].items[0].highlights[1]


def _tailor_runner() -> object:
    """`get_runner` override for the Tailor at `create` (only ever asked for a TailoredCV)."""

    async def runner(*, output: type[TOut], **_: object) -> TOut:
        return output.model_validate(_model_cv().model_dump(by_alias=True))

    return runner


def _fixed_resolver() -> object:
    async def resolve(provider: Provider, tier: Tier) -> str:
        return "fake-model-id"

    return resolve


def _authoring_builder(
    revisions: dict[str, str] | None = None,
    *,
    extra: list[tuple[str, str]] | None = None,
    calls: dict[str, int] | None = None,
) -> object:
    """A `get_authoring_runner_builder` override whose runner returns crafted per-bullet revisions
    as the Corrector output (DevPR29 — text keyed by `bulletId`, NOT a CV). `revisions` maps
    `bulletId -> text`; `extra` appends raw `(bulletId, text)` pairs AFTER them (to inject a
    duplicate / unknown id or force ordering). `calls` (if given) counts runner invocations, so a
    preflight-rejection test can assert the billed LLM was NOT reached."""

    async def build(
        _session: AsyncSession, _provider: Provider, _tier: Tier
    ) -> tuple[object, object]:
        async def resolve(provider: Provider, tier: Tier) -> str:
            return "fake-model-id"

        async def runner(*, output: type[TOut], **_: object) -> TOut:
            if calls is not None:
                calls["n"] += 1
            revs = [{"bulletId": k, "text": v} for k, v in (revisions or {}).items()]
            revs += [{"bulletId": b, "text": t} for b, t in (extra or [])]
            return output.model_validate({"revisions": revs})

        return runner, resolve

    return build


@pytest.fixture
def client(sqlite_maker: async_sessionmaker[AsyncSession]) -> Iterator[TestClient]:
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_membership_store] = lambda: _STORE
    app.dependency_overrides[get_runner] = _tailor_runner
    app.dependency_overrides[get_model_resolver] = _fixed_resolver
    # Default Corrector seam: no revisions (only the auth/tenancy tests use it — they reject before
    # the LLM). Tests that reach the Corrector override it per case via `_set_corrector`.
    app.dependency_overrides[get_authoring_runner_builder] = lambda: _authoring_builder()
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


def _read(client: TestClient, cv_id: str, workspace: str = "default") -> dict[str, Any]:
    return dict(client.get(f"/workspaces/{workspace}/cv/{cv_id}").json()["cv"])


def _version(client: TestClient, cv_id: str, workspace: str = "default") -> int:
    return int(_read(client, cv_id, workspace)["version"])


def _bullets(cv: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {b["bulletId"]: b for s in cv["sections"] for it in s["items"] for b in it["highlights"]}


def _thread(anchor_id: str = "b1", kind: str = "bullet", **extra: object) -> dict[str, object]:
    return {
        "anchorId": anchor_id,
        "anchorKind": kind,
        "severity": "minor",
        "comment": "tighten this",
        "suggestedRevision": "A crisper line.",
        **extra,
    }


def _apply(
    client: TestClient,
    cv_id: str,
    threads: list[dict[str, object]],
    *,
    base_version: int | None = None,
    workspace: str = "default",
) -> httpx.Response:
    bv = _version(client, cv_id, workspace) if base_version is None else base_version
    res: httpx.Response = client.post(
        f"/workspaces/{workspace}/cv/{cv_id}/apply",
        json={"threads": threads, "baseVersion": bv},
    )
    return res


def _set_corrector(
    revisions: dict[str, str] | None = None,
    *,
    extra: list[tuple[str, str]] | None = None,
    calls: dict[str, int] | None = None,
) -> None:
    """Override the Corrector seam so the model returns `revisions` (+ optional `extra` pairs)."""
    app.dependency_overrides[get_authoring_runner_builder] = lambda: _authoring_builder(
        revisions, extra=extra, calls=calls
    )


# --- happy path -------------------------------------------------------------------------------


def test_apply_rewords_accepted_bullet_only(client: TestClient) -> None:
    """Accepting `b1` rewrites only its text (still grounded → no sign-off); `b2` is untouched and
    stays net-new; the version bumps with `parentVersion` set."""
    cv_id = _create(client)
    _set_corrector({"b1": "Cut EDI partner onboarding from weeks to days across 40 integrations."})

    res = _apply(client, cv_id, [_thread("b1")], base_version=1)
    assert res.status_code == 200, res.text
    cv = res.json()["cv"]
    bullets = _bullets(cv)
    assert bullets["b1"]["text"].startswith("Cut EDI partner onboarding")
    assert bullets["b1"]["needsSignoff"] is False  # grounded reword
    assert bullets["b2"]["text"] == _b2(_model_cv()).text  # untouched (stored text)
    assert bullets["b2"]["needsSignoff"] is True  # still net-new
    assert cv["version"] == 2 and cv["parentVersion"] == 1


def test_apply_ignores_report_only_thread_fields(client: TestClient) -> None:
    """A thread echoed verbatim from a SlopThread / FactCheckThread (extra `flag`/`claim`/`verdict`/
    `sourceId` + the frontend's `key`/`source`) is accepted, not 422'd at the boundary."""
    cv_id = _create(client)
    _set_corrector({"b1": "Tighter, human phrasing for the EDI migration."})

    fat_thread = _thread(
        "b1",
        flag="llm-tell",
        claim="40 partners",
        verdict="supported",
        sourceId="exampleco-1",
        key="b1:editor",
        source="editor",
    )
    res = _apply(client, cv_id, [fat_thread], base_version=1)
    assert res.status_code == 200, res.text
    assert _bullets(res.json()["cv"])["b1"]["text"].startswith("Tighter, human phrasing")


# --- provenance: re-ground only the accepted bullets ------------------------------------------


def test_signed_off_net_new_unaccepted_bullet_stays_signed_off(client: TestClient) -> None:
    """The cv-wide-derive regression: with `b2` (net-new) already SIGNED OFF, correcting a DIFFERENT
    bullet must not re-gate it — only accepted bullets are re-grounded."""
    cv_id = _create(client)
    signed = client.post(
        f"/workspaces/default/cv/{cv_id}/signoff",
        json={"bulletIds": ["b2"], "baseVersion": 1},
    )
    assert signed.status_code == 200, signed.text  # version now 2, b2 needsSignoff False

    _set_corrector({"b1": "Reworded b1 while b2 stays signed off."})
    res = _apply(client, cv_id, [_thread("b1")], base_version=2)
    assert res.status_code == 200, res.text
    bullets = _bullets(res.json()["cv"])
    assert bullets["b2"]["needsSignoff"] is False  # NOT re-gated
    assert bullets["b1"]["text"].startswith("Reworded b1")


def test_correction_cannot_ground_a_net_new_bullet_past_signoff(client: TestClient) -> None:
    """Rewording an accepted net-new (unsigned) bullet KEEPS it net-new + `needsSignoff`: the splice
    is text-only and preserves the STORED `sourceId`/`origin` (a revision carries no `sourceId` to
    abuse), so a correction can't silently ground an unbacked claim past the gate (invariant 2)."""
    cv_id = _create(client)  # b2 is net-new (bogus source nulled), needsSignoff True
    assert _bullets(_read(client, cv_id))["b2"]["needsSignoff"] is True
    _set_corrector({"b2": "Now claiming this is backed by a real highlight."})

    res = _apply(client, cv_id, [_thread("b2")], base_version=1)
    assert res.status_code == 200, res.text
    bullets = _bullets(res.json()["cv"])
    assert bullets["b2"]["text"].startswith("Now claiming")  # text DID change
    assert bullets["b2"]["needsSignoff"] is True  # but it's STILL gated (provenance preserved)


def test_overstatement_on_real_source_does_not_re_gate(client: TestClient) -> None:
    """Overstatement on a grounded bullet stays grounded (no sign-off): the reword keeps the stored
    `sourceId`, so re-ground leaves it backed — text-vs-source is the Fact-Checker's advisory job,
    NOT this gate's (it never text-diffs the source)."""
    cv_id = _create(client)
    _set_corrector({"b1": "Single-handedly migrated 4000 EDI partners overnight."})  # overstated

    res = _apply(client, cv_id, [_thread("b1")], base_version=1)
    assert res.status_code == 200, res.text
    assert _bullets(res.json()["cv"])["b1"]["needsSignoff"] is False


# --- per-bullet splice guards (422) -----------------------------------------------------------


def test_missing_revision_for_accepted_bullet_is_422(client: TestClient) -> None:
    """The model omits a revision for an accepted bullet → 422 (`StructureViolation` at splice time,
    never a bare KeyError → 500)."""
    cv_id = _create(client)
    _set_corrector({})  # b1 is accepted below, but the model returns nothing for it
    assert _apply(client, cv_id, [_thread("b1")], base_version=1).status_code == 422


def test_duplicate_revision_id_is_422(client: TestClient) -> None:
    """Two revisions for the same bulletId → 422 at the route's `_revisions_map` (a dict would
    silently last-win)."""
    cv_id = _create(client)
    _set_corrector({"b1": "first"}, extra=[("b1", "second")])
    assert _apply(client, cv_id, [_thread("b1")], base_version=1).status_code == 422


def test_blank_corrected_text_is_422(client: TestClient) -> None:
    cv_id = _create(client)
    _set_corrector({"b1": "   "})  # blank after trimming
    assert _apply(client, cv_id, [_thread("b1")], base_version=1).status_code == 422


def test_oversized_corrected_text_is_422(client: TestClient) -> None:
    cv_id = _create(client)
    _set_corrector({"b1": "x" * (MAX_BULLET_LEN + 1)})
    assert _apply(client, cv_id, [_thread("b1")], base_version=1).status_code == 422


# --- extra / unknown revisions are ignored, not fatal -----------------------------------------


def test_extra_revision_for_unaccepted_bullet_is_ignored(client: TestClient) -> None:
    """The splice owns the stored CV, so an EXTRA revision for a real-but-UNACCEPTED bullet (`b2`)
    is discarded, not 422'd — only accepted ids are spliced; b2 keeps its stored text."""
    cv_id = _create(client)
    _set_corrector({"b1": "Accepted reword for b1."}, extra=[("b2", "drifted b2, ignore me")])

    res = _apply(client, cv_id, [_thread("b1")], base_version=1)
    assert res.status_code == 200, res.text
    bullets = _bullets(res.json()["cv"])
    assert bullets["b1"]["text"] == "Accepted reword for b1."
    assert bullets["b2"]["text"] == _b2(_model_cv()).text  # stored, not the drift


def test_unknown_revision_id_ignored(client: TestClient) -> None:
    """A revision for a bulletId that isn't in the CV at all (`b99`) is silently ignored — it never
    matches an accepted stored bullet, so only `b1` is spliced. 200, not 422."""
    cv_id = _create(client)
    _set_corrector({"b1": "Accepted reword for b1."}, extra=[("b99", "ghost bullet text")])

    res = _apply(client, cv_id, [_thread("b1")], base_version=1)
    assert res.status_code == 200, res.text
    assert _bullets(res.json()["cv"])["b1"]["text"] == "Accepted reword for b1."


# --- preflight rejections BEFORE the billed LLM -----------------------------------------------


def test_stale_base_version_is_409_before_the_llm(client: TestClient) -> None:
    cv_id = _create(client)
    calls = {"n": 0}
    _set_corrector({}, calls=calls)
    assert _apply(client, cv_id, [_thread("b1")], base_version=99).status_code == 409
    assert calls["n"] == 0  # the Corrector was never called


def test_applied_cv_is_409_before_the_llm(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    cv_id = _create(client)
    calls = {"n": 0}
    _set_corrector({}, calls=calls)

    async def _always_applied(*_a: object, **_k: object) -> bool:
        return True

    monkeypatch.setattr(cv_store, "is_applied", _always_applied)
    assert _apply(client, cv_id, [_thread("b1")], base_version=1).status_code == 409
    assert calls["n"] == 0


def test_no_correctable_bullet_threads_is_422(client: TestClient) -> None:
    """Empty threads, or only non-bullet anchors, or a dead bullet anchor → 422 before the LLM."""
    cv_id = _create(client)
    calls = {"n": 0}
    _set_corrector({}, calls=calls)

    assert _apply(client, cv_id, [], base_version=1).status_code == 422
    item_only = [_thread("i1", kind="item")]
    assert _apply(client, cv_id, item_only, base_version=1).status_code == 422
    ghost = [_thread("does-not-exist")]
    assert _apply(client, cv_id, ghost, base_version=1).status_code == 422
    assert calls["n"] == 0


# --- auth / tenancy ---------------------------------------------------------------------------


def test_apply_denies_non_member(client: TestClient) -> None:
    cv_id = _create(client)
    app.dependency_overrides[current_user] = lambda: STRANGER
    assert _apply(client, cv_id, [_thread("b1")], base_version=1).status_code == 403


def test_apply_cross_tenant_404(client: TestClient) -> None:
    cv_id = _create(client, workspace="default")
    assert (
        _apply(client, cv_id, [_thread("b1")], workspace="ws2", base_version=1).status_code == 404
    )
