"""Workspace-scoped CV routes: create -> read -> sign off -> export, the gate, and tenant isolation.

Offline: SQLite stands in for Postgres (sqlite_maker), the Tailor runner/resolver are faked, and
the membership store is in-memory so per-workspace authorization (invariant 8) is exercised without
a key or the network."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import TypeVar

import httpx
import pytest
from app.ai.agents.registry import get_model_resolver, get_runner
from app.auth.deps import current_user
from app.main import app
from app.persistence import StoredCvLabel, cv_store, get_membership_store
from app.persistence.models import StoredCvJobSpec
from app.schema import (
    AuthUser,
    JobSpec,
    Membership,
    TailoredBullet,
    TailoredCV,
    TailoredItem,
    TailoredSection,
)
from app.schema.common import Origin, Provider, SectionType, Tier
from fastapi.testclient import TestClient
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.factories import InMemoryMembershipStore, sample_job_spec, sample_master_profile

TOut = TypeVar("TOut", bound=BaseModel)

OWNER = AuthUser(email="owner@example.com")
STRANGER = AuthUser(email="stranger@example.com")

# Owner owns two workspaces; the store denies everyone else everywhere — so STRANGER (a member of
# nothing) exercises the deny path.
_STORE = InMemoryMembershipStore(
    [
        Membership(workspace_id="default", email=OWNER.email),
        Membership(workspace_id="ws2", email=OWNER.email),
    ]
)


def _model_cv() -> TailoredCV:
    """A grounded bullet + a bullet with a bogus source the server turns into a net-new (so export
    is blocked until sign-off)."""
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


def _fake_runner() -> object:
    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[TOut],
        **_: object,
    ) -> TOut:
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
    app.dependency_overrides[get_runner] = _fake_runner
    app.dependency_overrides[get_model_resolver] = _fixed_resolver
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
    # The persisting tailor route loads the STORED master server-side, so seed it first.
    _put_master(client, workspace)
    res = client.post(
        f"/workspaces/{workspace}/cv",
        json={"jobSpec": sample_job_spec().model_dump(by_alias=True)},
    )
    assert res.status_code == 200, res.text
    return str(res.json()["id"])


def _version(client: TestClient, cv_id: str, workspace: str = "default") -> int:
    """The CV's current version — the `baseVersion` a client viewing it would send."""
    return int(client.get(f"/workspaces/{workspace}/cv/{cv_id}").json()["cv"]["version"])


def _signoff(
    client: TestClient,
    cv_id: str,
    bullet_ids: list[str],
    *,
    base_version: int | None = None,
    workspace: str = "default",
) -> httpx.Response:
    bv = _version(client, cv_id, workspace) if base_version is None else base_version
    res: httpx.Response = client.post(
        f"/workspaces/{workspace}/cv/{cv_id}/signoff",
        json={"bulletIds": bullet_ids, "baseVersion": bv},
    )
    return res


def _edit(
    client: TestClient,
    cv_id: str,
    bullet_id: str,
    text: str,
    *,
    base_version: int | None = None,
    workspace: str = "default",
) -> httpx.Response:
    bv = _version(client, cv_id, workspace) if base_version is None else base_version
    res: httpx.Response = client.post(
        f"/workspaces/{workspace}/cv/{cv_id}/edit",
        json={"bulletId": bullet_id, "text": text, "baseVersion": bv},
    )
    return res


def _label(maker: async_sessionmaker[AsyncSession], cv_id: str) -> StoredCvLabel | None:
    """Read the cv_labels row for a CV directly from the test DB (no read endpoint exists yet)."""

    async def _q() -> StoredCvLabel | None:
        async with maker() as session:
            return (
                await session.execute(select(StoredCvLabel).where(StoredCvLabel.cv_id == cv_id))
            ).scalar_one_or_none()

    return asyncio.run(_q())


def _job_spec(
    maker: async_sessionmaker[AsyncSession], cv_id: str, workspace: str = "default"
) -> JobSpec | None:
    """The full JobSpec persisted for a CV (via the store reader), or None — read straight from the
    test DB so the cv_job_specs round-trip is exercised without a route."""

    async def _q() -> JobSpec | None:
        async with maker() as session:
            return await cv_store.get_job_spec(session, workspace, cv_id)

    return asyncio.run(_q())


def test_create_writes_cv_label(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """The AI tailor route persists the parsed job's title/company in a separate cv_labels row —
    the dashboard label, set server-side from the trusted JobSpec, not the model (invariant 5)."""
    cv_id = _create(client)
    label = _label(sqlite_maker, cv_id)
    assert label is not None
    assert label.workspace_id == "default"
    assert label.job_title == sample_job_spec().title
    assert label.company == sample_job_spec().company


def test_create_writes_cv_job_spec(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """The tailor route persists the FULL owner-supplied JobSpec in a `cv_job_specs` row (not just
    the title/company the label keeps) so the review panel's Gatekeeper/Editor judge against the
    same stored posting the CV targeted — the review target, server-side and tenant-isolated."""
    cv_id = _create(client)
    spec = _job_spec(sqlite_maker, cv_id)
    assert spec is not None
    # The fields cv_labels does NOT carry — proving the whole posting is stored, not just the label.
    assert spec.must_haves == sample_job_spec().must_haves
    assert spec.ats_keywords == sample_job_spec().ats_keywords
    assert spec.title == sample_job_spec().title


def test_keyless_draft_writes_no_job_spec(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """A keyless verbatim draft has no job, so it writes no `cv_job_specs` row — its review will run
    only the job-independent agents (Fact-Checker + Spotter)."""
    _put_master(client)
    cv_id = str(client.post("/workspaces/default/cv/from-master").json()["id"])
    assert _job_spec(sqlite_maker, cv_id) is None


def test_delete_removes_cv_job_spec(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """Deleting a CV removes its `cv_job_specs` row in the same commit (no orphan posting)."""
    cv_id = _create(client)
    assert _job_spec(sqlite_maker, cv_id) is not None
    assert client.delete(f"/workspaces/default/cv/{cv_id}").status_code == 200
    assert _job_spec(sqlite_maker, cv_id) is None


def test_job_spec_is_workspace_scoped(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """The job-spec reader filters on `(workspace, cv)` — a cross-tenant cv id reads as None, and a
    delete via the wrong workspace (404) leaves the real row intact (invariant 8)."""
    cv_id = _create(client, workspace="default")
    assert _job_spec(sqlite_maker, cv_id, workspace="ws2") is None
    assert client.delete(f"/workspaces/ws2/cv/{cv_id}").status_code == 404
    assert _job_spec(sqlite_maker, cv_id, workspace="default") is not None


def test_read_cv_includes_job_spec(client: TestClient) -> None:
    """BE-1: the read bundle now carries the stored `jobSpec` (for the posting drawer + Gatekeeper
    present/met), and is null for a keyless draft."""
    cv_id = _create(client)
    bundle = client.get(f"/workspaces/default/cv/{cv_id}").json()
    assert bundle["jobSpec"] is not None
    assert bundle["jobSpec"]["title"] == sample_job_spec().title
    assert bundle["jobSpec"]["mustHaves"] == sample_job_spec().must_haves

    _put_master(client)
    draft_id = str(client.post("/workspaces/default/cv/from-master").json()["id"])
    assert client.get(f"/workspaces/default/cv/{draft_id}").json()["jobSpec"] is None


def test_legacy_job_spec_blob_without_posting_url_validates(
    sqlite_maker: async_sessionmaker[AsyncSession],
) -> None:
    """Legacy `cv_job_specs` blob (pre-`postingUrl`) still validates; `get_job_spec` returns it with
    `posting_url` None (BE-1 back-compat — the field is optional)."""
    legacy = sample_job_spec().model_dump(by_alias=True)
    legacy.pop("postingUrl", None)  # simulate a pre-field stored row

    async def _seed_and_read() -> JobSpec | None:
        async with sqlite_maker() as session:
            session.add(StoredCvJobSpec(cv_id="legacy-cv", workspace_id="default", job_spec=legacy))
            await session.commit()
        async with sqlite_maker() as session:
            return await cv_store.get_job_spec(session, "default", "legacy-cv")

    spec = asyncio.run(_seed_and_read())
    assert spec is not None
    assert spec.posting_url is None
    assert spec.title == sample_job_spec().title


def test_keyless_draft_writes_no_label(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """A keyless verbatim draft has no job, so it writes no cv_labels row (the dashboard shows
    'Draft' for it)."""
    _put_master(client)
    res = client.post("/workspaces/default/cv/from-master")
    assert res.status_code == 200, res.text
    cv_id = str(res.json()["id"])
    assert _label(sqlite_maker, cv_id) is None


def test_list_returns_all_owner_cvs(client: TestClient) -> None:
    id1 = _create(client)
    id2 = _create(client)
    res = client.get("/workspaces/default/cv")
    assert res.status_code == 200, res.text
    rows = res.json()
    assert {r["id"] for r in rows} == {id1, id2}
    # The AI-route CVs surface the parsed job as the label (joined from cv_labels).
    for r in rows:
        assert r["jobTitle"] == sample_job_spec().title
        assert r["company"] == sample_job_spec().company


def test_list_empty_when_no_cvs(client: TestClient) -> None:
    _put_master(client)
    res = client.get("/workspaces/default/cv")
    assert res.status_code == 200, res.text
    assert res.json() == []


def test_list_keyless_draft_has_no_label(client: TestClient) -> None:
    """A keyless draft has no cv_labels row, so the LEFT JOIN yields null job fields (→ 'Draft')."""
    _put_master(client)
    cv_id = str(client.post("/workspaces/default/cv/from-master").json()["id"])
    rows = {r["id"]: r for r in client.get("/workspaces/default/cv").json()}
    assert rows[cv_id]["jobTitle"] is None
    assert rows[cv_id]["company"] is None


def test_list_denies_non_member(client: TestClient) -> None:
    _create(client)
    app.dependency_overrides[current_user] = lambda: STRANGER
    assert client.get("/workspaces/default/cv").status_code == 403


def test_list_is_workspace_scoped(client: TestClient) -> None:
    """A CV (and its label) in one workspace never appears when listing another — even for an owner
    who is a member of both (invariant 8)."""
    id_default = _create(client, workspace="default")
    id_ws2 = _create(client, workspace="ws2")
    default_ids = {r["id"] for r in client.get("/workspaces/default/cv").json()}
    ws2_ids = {r["id"] for r in client.get("/workspaces/ws2/cv").json()}
    assert default_ids == {id_default}
    assert ws2_ids == {id_ws2}


def test_list_needs_signoff_reflects_state(client: TestClient) -> None:
    """A fresh CV carries the fake runner's net-new bullet (b2) → needsSignoff True; signing it off
    flips the summary flag to False."""
    cv_id = _create(client)
    before = {r["id"]: r for r in client.get("/workspaces/default/cv").json()}
    assert before[cv_id]["needsSignoff"] is True
    assert _signoff(client, cv_id, ["b2"]).status_code == 200
    after = {r["id"]: r for r in client.get("/workspaces/default/cv").json()}
    assert after[cv_id]["needsSignoff"] is False


def test_delete_removes_cv(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    cv_id = _create(client)
    res = client.delete(f"/workspaces/default/cv/{cv_id}")
    assert res.status_code == 200, res.text
    assert res.json() == {"ok": True}
    # The CV, its label row, and its list entry are all gone.
    assert client.get(f"/workspaces/default/cv/{cv_id}").status_code == 404
    assert _label(sqlite_maker, cv_id) is None
    assert client.get("/workspaces/default/cv").json() == []


def test_delete_denied_for_non_member(client: TestClient) -> None:
    """Delete is deny-by-default: a non-member is 403 and the real row survives (invariant 8)."""
    cv_id = _create(client)  # as OWNER (create is owner-only)
    app.dependency_overrides[current_user] = lambda: STRANGER  # not a member of any workspace
    assert client.delete(f"/workspaces/default/cv/{cv_id}").status_code == 403
    # The denied delete left the CV intact.
    app.dependency_overrides[current_user] = lambda: OWNER
    assert client.get(f"/workspaces/default/cv/{cv_id}").status_code == 200


def test_delete_cross_tenant_404_and_row_survives(client: TestClient) -> None:
    """Deleting via the wrong workspace is a 404 (the store filters on `(workspace, cv)`) and must
    NOT delete the real row — even though OWNER is a member of both workspaces (invariant 8)."""
    cv_id = _create(client, workspace="default")
    assert client.delete(f"/workspaces/ws2/cv/{cv_id}").status_code == 404
    assert client.get(f"/workspaces/default/cv/{cv_id}").status_code == 200


def test_create_read_signoff_export_happy_path(client: TestClient) -> None:
    cv_id = _create(client)

    # Read (preview) works for the member and shows the net-new bullet still flagged.
    bundle = client.get(f"/workspaces/default/cv/{cv_id}").json()
    flagged = [
        b
        for s in bundle["cv"]["sections"]
        for it in s["items"]
        for b in it["highlights"]
        if b["needsSignoff"]
    ]
    assert [b["bulletId"] for b in flagged] == ["b2"]

    # Export is gated: 409 listing the blocking bullet.
    blocked = client.get(f"/workspaces/default/cv/{cv_id}/export")
    assert blocked.status_code == 409
    assert blocked.json()["blockedBulletIds"] == ["b2"]

    # Owner signs off -> export now succeeds with the full render bundle.
    signed = _signoff(client, cv_id, ["b2"])
    assert signed.status_code == 200
    ok = client.get(f"/workspaces/default/cv/{cv_id}/export")
    assert ok.status_code == 200
    assert "master" in ok.json() and "cv" in ok.json()


def test_signoff_is_idempotent(client: TestClient) -> None:
    cv_id = _create(client)
    assert _signoff(client, cv_id, ["b2"]).status_code == 200
    # Signing off the same bullet again is a no-op, not an error (fetches the bumped version).
    assert _signoff(client, cv_id, ["b2"]).status_code == 200
    assert client.get(f"/workspaces/default/cv/{cv_id}/export").status_code == 200


def test_signoff_unknown_bullet_422(client: TestClient) -> None:
    cv_id = _create(client)
    assert _signoff(client, cv_id, ["nope"]).status_code == 422


def test_non_member_is_denied(client: TestClient) -> None:
    cv_id = _create(client)
    app.dependency_overrides[current_user] = lambda: STRANGER  # not in the store for any workspace
    assert client.get(f"/workspaces/default/cv/{cv_id}").status_code == 403


def test_cross_workspace_id_is_not_found(client: TestClient) -> None:
    """A CV created in `default` is invisible from `ws2` even to a `ws2` member — 404, no leak."""
    cv_id = _create(client, workspace="default")
    assert client.get(f"/workspaces/ws2/cv/{cv_id}").status_code == 404


def test_read_unknown_cv_404(client: TestClient) -> None:
    assert client.get("/workspaces/default/cv/does-not-exist").status_code == 404


def test_create_requires_stored_master_404(client: TestClient) -> None:
    """The tailor route grounds provenance in the STORED master — with none saved it's a 404, not a
    tailor against client-supplied JSON."""
    res = client.post(
        "/workspaces/default/cv",
        json={"jobSpec": sample_job_spec().model_dump(by_alias=True)},
    )
    assert res.status_code == 404


def test_create_normalizes_version_token(client: TestClient) -> None:
    """Even if the model emits version 0, the persisted CV starts at 1 — so the client's
    `baseVersion` (≥1) is always valid and a gated CV can never become un-signable."""

    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[TOut],
        **_: object,
    ) -> TOut:
        cv = _model_cv()
        cv.version = 0
        return output.model_validate(cv.model_dump(by_alias=True))

    app.dependency_overrides[get_runner] = lambda: runner
    cv_id = _create(client)
    assert _version(client, cv_id) == 1
    assert _signoff(client, cv_id, ["b2"]).status_code == 200


# --- Inline bullet editing (POST /workspaces/{id}/cv/{cv_id}/edit) -----------------------------
# `_create` yields b1 (grounded in exampleco-1, verbatim) and b2 (bogus source → net-new, gated).


def _highlights(bundle: dict[str, object]) -> list[dict[str, object]]:
    cv = bundle["cv"]
    assert isinstance(cv, dict)
    return [b for s in cv["sections"] for it in s["items"] for b in it["highlights"]]


def _bullet(bundle: dict[str, object], bullet_id: str) -> dict[str, object]:
    return next(b for b in _highlights(bundle) if b["bulletId"] == bullet_id)


def test_edit_grounded_bullet_becomes_reworded(client: TestClient) -> None:
    cv_id = _create(client)
    res = _edit(client, cv_id, "b1", "Reworked the EDI migration across 40 partners.")
    assert res.status_code == 200, res.text
    b1 = _bullet(res.json(), "b1")
    assert b1["text"] == "Reworked the EDI migration across 40 partners."
    assert b1["origin"] == "reworded"  # a hand-edited copy is no longer verbatim
    assert b1["needsSignoff"] is False
    assert _bullet(res.json(), "b2")["needsSignoff"] is True  # the net-new bullet is untouched


def test_edit_net_new_bullet_stays_gated(client: TestClient) -> None:
    cv_id = _create(client)
    res = _edit(client, cv_id, "b2", "Owned the SLA dashboard for every partner.")
    assert res.status_code == 200, res.text
    b2 = _bullet(res.json(), "b2")
    assert b2["origin"] == "net-new"
    assert b2["needsSignoff"] is True
    assert client.get(f"/workspaces/default/cv/{cv_id}/export").status_code == 409


def test_edit_signed_off_net_new_re_requires_signoff(client: TestClient) -> None:
    cv_id = _create(client)
    assert _signoff(client, cv_id, ["b2"]).status_code == 200
    assert client.get(f"/workspaces/default/cv/{cv_id}/export").status_code == 200
    # Editing the approved net-new bullet re-flags it: the new text needs fresh approval.
    res = _edit(client, cv_id, "b2", "Reframed SLA ownership end to end.")
    assert res.status_code == 200
    assert _bullet(res.json(), "b2")["needsSignoff"] is True
    assert client.get(f"/workspaces/default/cv/{cv_id}/export").status_code == 409


def test_edit_does_not_clobber_other_bullet_signoff(client: TestClient) -> None:
    """Core regression guard: editing one bullet must NOT re-flag a *different* signed-off net-new
    bullet (a cv-wide re-derive would). The edit re-grounds only the edited bullet."""
    cv_id = _create(client)
    assert _signoff(client, cv_id, ["b2"]).status_code == 200
    assert client.get(f"/workspaces/default/cv/{cv_id}/export").status_code == 200
    res = _edit(client, cv_id, "b1", "Tightened the EDI rollout.")
    assert res.status_code == 200
    assert _bullet(res.json(), "b2")["needsSignoff"] is False  # still signed off
    assert client.get(f"/workspaces/default/cv/{cv_id}/export").status_code == 200


def test_edit_unknown_bullet_422(client: TestClient) -> None:
    cv_id = _create(client)
    assert _edit(client, cv_id, "nope", "x").status_code == 422


@pytest.mark.parametrize("text", ["", "   ", "x" * 1001])
def test_edit_rejects_blank_or_oversized_text_422(client: TestClient, text: str) -> None:
    cv_id = _create(client)
    assert _edit(client, cv_id, "b1", text).status_code == 422


def test_edit_cross_workspace_404(client: TestClient) -> None:
    cv_id = _create(client, workspace="default")
    # base_version explicit: a GET against ws2 would 404 before we could read a version.
    res = _edit(client, cv_id, "b1", "x is valid", base_version=1, workspace="ws2")
    assert res.status_code == 404


def test_edit_non_owner_denied(client: TestClient) -> None:
    cv_id = _create(client)
    app.dependency_overrides[current_user] = lambda: STRANGER  # not a member of any workspace
    assert _edit(client, cv_id, "b1", "x is valid", base_version=1).status_code == 403


def test_edit_stale_base_version_conflicts(client: TestClient) -> None:
    """The stale-tab guard: a first edit bumps the version; a second writer still on the old
    `baseVersion` is rejected with 409 (client-visible optimistic concurrency), not a silent
    clobber. Without a client `baseVersion` this race would be invisible to the server."""
    cv_id = _create(client)
    assert _edit(client, cv_id, "b1", "First tab's edit.", base_version=1).status_code == 200
    # A second tab still showing version 1 (now stale after the bump above) tries to edit -> 409.
    assert _edit(client, cv_id, "b1", "Stale tab's edit.", base_version=1).status_code == 409


def test_signoff_stale_base_version_conflicts(client: TestClient) -> None:
    """Sign-off is version-guarded too: a tab that edited a net-new bullet bumps the version, so a
    different tab can't approve the bullet's old text against the stale version."""
    cv_id = _create(client)
    edited = _edit(client, cv_id, "b2", "Net-new, reworded by tab one.", base_version=1)
    assert edited.status_code == 200
    # A tab still on version 1 tries to sign off the (now-changed) net-new bullet -> 409.
    assert _signoff(client, cv_id, ["b2"], base_version=1).status_code == 409
