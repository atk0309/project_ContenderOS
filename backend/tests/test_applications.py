"""Application tracking: apply (lock a CV to a job) -> list/read -> advance stage -> delete, the
apply gate, CV locking, and tenant isolation (invariant 8).

Offline: SQLite stands in for Postgres (sqlite_maker), the Tailor runner/resolver are faked, and the
membership store is in-memory so per-workspace authorization is exercised without a key or network.
The advisory `lock_cv` is a no-op on SQLite (cross-process serialization is a Postgres-only
guarantee, exercised against Postgres, never claimed from this gate — AGENTS §4); the apply gate,
the derived lock, the unique-constraint backstop, and the cascade are all testable here.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any, TypeVar

import httpx2
import pytest
from app.ai.agents.registry import get_model_resolver, get_runner
from app.auth.deps import current_user
from app.main import app
from app.persistence import cv_store, get_membership_store
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
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.factories import InMemoryMembershipStore, sample_job_spec, sample_master_profile

TOut = TypeVar("TOut", bound=BaseModel)

OWNER = AuthUser(email="owner@example.com")
STRANGER = AuthUser(email="stranger@example.com")

# Owner owns `default` + `ws2`; everyone else is denied everywhere — so STRANGER (a member of
# nothing) exercises the deny path.
_STORE = InMemoryMembershipStore(
    [
        Membership(workspace_id="default", email=OWNER.email),
        Membership(workspace_id="ws2", email=OWNER.email),
    ]
)


def _model_cv() -> TailoredCV:
    """A grounded bullet + a bullet with a bogus source the server turns into a net-new (so export —
    and apply — is blocked until sign-off)."""
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


# --- helpers ---------------------------------------------------------------------------------


def _put_master(client: TestClient, workspace: str = "default") -> None:
    res = client.put(
        f"/workspaces/{workspace}/master",
        json=sample_master_profile().model_dump(by_alias=True),
    )
    assert res.status_code == 200, res.text


def _create_ai(client: TestClient, workspace: str = "default") -> str:
    """An AI-tailored CV — one net-new bullet (gated until signed off) + a cv_labels row."""
    _put_master(client, workspace)
    res = client.post(
        f"/workspaces/{workspace}/cv",
        json={"jobSpec": sample_job_spec().model_dump(by_alias=True)},
    )
    assert res.status_code == 200, res.text
    return str(res.json()["id"])


def _create_draft(client: TestClient, workspace: str = "default") -> str:
    """A keyless verbatim draft — zero net-new bullets (appliable) + NO cv_labels row."""
    _put_master(client, workspace)
    res = client.post(f"/workspaces/{workspace}/cv/from-master")
    assert res.status_code == 200, res.text
    return str(res.json()["id"])


def _read_cv(client: TestClient, cv_id: str, workspace: str = "default") -> dict[str, Any]:
    return dict(client.get(f"/workspaces/{workspace}/cv/{cv_id}").json()["cv"])


def _version(client: TestClient, cv_id: str, workspace: str = "default") -> int:
    return int(_read_cv(client, cv_id, workspace)["version"])


def _signoff_all(client: TestClient, cv_id: str, workspace: str = "default") -> None:
    cv = _read_cv(client, cv_id, workspace)
    unsigned = [
        b["bulletId"]
        for s in cv["sections"]
        for i in s["items"]
        for b in i["highlights"]
        if b["needsSignoff"]
    ]
    if not unsigned:
        return
    res = client.post(
        f"/workspaces/{workspace}/cv/{cv_id}/signoff",
        json={"bulletIds": unsigned, "baseVersion": cv["version"]},
    )
    assert res.status_code == 200, res.text


def _apply(
    client: TestClient,
    cv_id: str,
    *,
    workspace: str = "default",
    base_version: int | None = None,
    jobTitle: str | None = None,
    company: str | None = None,
    jobUrl: str | None = None,
    note: str | None = None,
) -> httpx2.Response:
    bv = _version(client, cv_id, workspace) if base_version is None else base_version
    body: dict[str, object] = {"cvId": cv_id, "baseVersion": bv}
    extras = (("jobTitle", jobTitle), ("company", company), ("jobUrl", jobUrl), ("note", note))
    for key, val in extras:
        if val is not None:
            body[key] = val
    res: httpx2.Response = client.post(f"/workspaces/{workspace}/applications", json=body)
    return res


def _apply_ok(
    client: TestClient,
    cv_id: str,
    *,
    jobTitle: str | None = None,
    company: str | None = None,
    jobUrl: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    res = _apply(client, cv_id, jobTitle=jobTitle, company=company, jobUrl=jobUrl, note=note)
    assert res.status_code == 200, res.text
    return dict(res.json())


# --- apply: happy paths ----------------------------------------------------------------------


def test_apply_ai_cv_locks_and_carries_label(client: TestClient) -> None:
    """Applying a signed-off AI CV creates the application (title/company from the cv_labels row),
    seeds the timeline at 'applied', and locks the CV out of the work area."""
    cv_id = _create_ai(client)
    _signoff_all(client, cv_id)
    app_ = _apply_ok(client, cv_id)
    assert app_["jobTitle"] == sample_job_spec().title
    assert app_["company"] == sample_job_spec().company
    assert app_["tailoredCvRef"] == cv_id
    assert app_["stage"] == "applied"
    assert [e["stage"] for e in app_["events"]] == ["applied"]
    # Locked + moved out of the work area.
    assert cv_id not in {r["id"] for r in client.get("/workspaces/default/cv").json()}


def test_apply_keyless_draft_with_dialog_title(client: TestClient) -> None:
    """A keyless draft has no label, so the dialog-supplied title is used."""
    cv_id = _create_draft(client)
    app_ = _apply_ok(
        client,
        cv_id,
        jobTitle="Staff Engineer",
        company="Acme",
        jobUrl="https://jobs.example.test/role",
    )
    assert app_["jobTitle"] == "Staff Engineer"
    assert app_["company"] == "Acme"
    assert app_["jobUrl"] == "https://jobs.example.test/role"


def test_apply_first_event_carries_note(client: TestClient) -> None:
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="PM", note="applied via referral")
    assert app_["events"][0]["note"] == "applied via referral"


# --- apply: gate + validation ----------------------------------------------------------------


def test_apply_blocked_needs_signoff(client: TestClient) -> None:
    """A CV with an unsigned net-new bullet is refused with the export-gate body (invariant 2)."""
    cv_id = _create_ai(client)  # not signed off
    res = _apply(client, cv_id, jobTitle="X")
    assert res.status_code == 409, res.text
    assert "b2" in res.json()["blockedBulletIds"]


def test_apply_stale_version_conflict(client: TestClient) -> None:
    cv_id = _create_ai(client)
    _signoff_all(client, cv_id)  # bumps version to 2
    res = _apply(client, cv_id, base_version=1, jobTitle="X")
    assert res.status_code == 409, res.text
    assert res.json()["code"] == "stale"


def test_apply_already_applied_conflict(client: TestClient) -> None:
    cv_id = _create_draft(client)
    assert _apply(client, cv_id, jobTitle="One").status_code == 200
    res = _apply(client, cv_id, base_version=1, jobTitle="Two")
    assert res.status_code == 409, res.text
    assert res.json()["code"] == "alreadyApplied"


def test_apply_keyless_draft_without_title_422(client: TestClient) -> None:
    """No label and no supplied title → 422, not a 500."""
    cv_id = _create_draft(client)
    res = _apply(client, cv_id)  # no jobTitle
    assert res.status_code == 422, res.text


def test_apply_whitespace_title_422(client: TestClient) -> None:
    """A whitespace-only title is rejected (NonBlank), never stored."""
    cv_id = _create_draft(client)
    res = _apply(client, cv_id, jobTitle="   ")
    assert res.status_code == 422, res.text


def test_apply_unknown_cv_404(client: TestClient) -> None:
    res = _apply(client, "does-not-exist", base_version=1, jobTitle="X")
    assert res.status_code == 404, res.text


# --- locking: applied CV is immutable + hidden -----------------------------------------------


def test_applied_cv_blocks_edit_signoff_delete(client: TestClient) -> None:
    """Once applied, the CV is locked: edit/sign-off/delete are refused with code 'cvLocked'."""
    cv_id = _create_draft(client)
    _apply_ok(client, cv_id, jobTitle="X")
    edit = client.post(
        f"/workspaces/default/cv/{cv_id}/edit",
        json={"bulletId": "b1", "text": "new text here", "baseVersion": 1},
    )
    assert edit.status_code == 409 and edit.json()["code"] == "cvLocked", edit.text
    signoff = client.post(
        f"/workspaces/default/cv/{cv_id}/signoff",
        json={"bulletIds": ["b1"], "baseVersion": 1},
    )
    assert signoff.status_code == 409 and signoff.json()["code"] == "cvLocked", signoff.text
    delete = client.delete(f"/workspaces/default/cv/{cv_id}")
    assert delete.status_code == 409 and delete.json()["code"] == "cvLocked", delete.text


def test_list_cvs_excludes_applied(client: TestClient) -> None:
    keep = _create_ai(client)
    applied = _create_draft(client)
    _apply_ok(client, applied, jobTitle="X")
    ids = {r["id"] for r in client.get("/workspaces/default/cv").json()}
    assert keep in ids
    assert applied not in ids


# --- list / read / by-cv ---------------------------------------------------------------------


def test_list_and_get(client: TestClient) -> None:
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="Lead")
    rows = client.get("/workspaces/default/applications").json()
    assert {r["id"] for r in rows} == {app_["id"]}
    assert rows[0]["cvId"] == cv_id
    full = client.get(f"/workspaces/default/applications/{app_['id']}")
    assert full.status_code == 200
    assert full.json()["jobTitle"] == "Lead"


def test_by_cv_lookup(client: TestClient) -> None:
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="Lead")
    hit = client.get(f"/workspaces/default/applications/by-cv/{cv_id}")
    assert hit.status_code == 200 and hit.json()["id"] == app_["id"]
    # Unapplied CV → 200 with a JSON `null` body (NOT 404): the workspace probes this on every load,
    # so a miss must not log a red console error. `null` is information-equivalent to the old 404.
    other = _create_ai(client)
    miss = client.get(f"/workspaces/default/applications/by-cv/{other}")
    assert miss.status_code == 200 and miss.json() is None


def test_get_unknown_application_404(client: TestClient) -> None:
    assert client.get("/workspaces/default/applications/nope").status_code == 404


# --- stage pipeline --------------------------------------------------------------------------


def test_stage_update_appends_and_persists(client: TestClient) -> None:
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    res = client.patch(
        f"/workspaces/default/applications/{app_['id']}/stage",
        json={"stage": "interview", "note": "phone screen booked"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["stage"] == "interview"
    assert [e["stage"] for e in res.json()["events"]] == ["applied", "interview"]
    # Persisted: a fresh read sees the new stage + timeline.
    reread = client.get(f"/workspaces/default/applications/{app_['id']}").json()
    assert reread["stage"] == "interview"
    assert reread["events"][-1]["note"] == "phone screen booked"


def test_stage_update_invalid_422(client: TestClient) -> None:
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    res = client.patch(
        f"/workspaces/default/applications/{app_['id']}/stage",
        json={"stage": "not-a-stage"},
    )
    assert res.status_code == 422, res.text


# --- recruiter contact -----------------------------------------------------------------------


def test_recruiter_update_persists(client: TestClient) -> None:
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    res = client.patch(
        f"/workspaces/default/applications/{app_['id']}/recruiter",
        json={"recruiterName": "Dana Lee", "recruiterEmail": "dana@acme.test"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["recruiterName"] == "Dana Lee"
    assert res.json()["recruiterEmail"] == "dana@acme.test"
    reread = client.get(f"/workspaces/default/applications/{app_['id']}").json()
    assert reread["recruiterName"] == "Dana Lee"
    assert reread["recruiterEmail"] == "dana@acme.test"


def test_recruiter_clear_to_null(client: TestClient) -> None:
    """Blank/whitespace or explicit null trims to `None` — a full-replace clear, not an omit."""
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    client.patch(
        f"/workspaces/default/applications/{app_['id']}/recruiter",
        json={"recruiterName": "Dana", "recruiterEmail": "dana@acme.test"},
    )
    res = client.patch(
        f"/workspaces/default/applications/{app_['id']}/recruiter",
        json={"recruiterName": "  ", "recruiterEmail": None},
    )
    assert res.status_code == 200, res.text
    assert res.json()["recruiterName"] is None
    assert res.json()["recruiterEmail"] is None


def test_recruiter_invalid_email_422(client: TestClient) -> None:
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    # Plain garbage + values with URI/mailto metacharacters (must never reach a mailto href).
    for bad in (
        "not-an-email",
        "hr@example.test?bcc=attacker@example.test",
        "a@example.test#f",
        "a@example.test,c@example.test",
    ):
        res = client.patch(
            f"/workspaces/default/applications/{app_['id']}/recruiter",
            json={"recruiterName": "Dana", "recruiterEmail": bad},
        )
        assert res.status_code == 422, f"{bad}: {res.text}"


def test_recruiter_omitted_key_422(client: TestClient) -> None:
    """Both keys are required (full-replace) — an omitted field is a 422, never a silent clear."""
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    url = f"/workspaces/default/applications/{app_['id']}/recruiter"
    assert client.patch(url, json={"recruiterName": "Dana"}).status_code == 422
    assert client.patch(url, json={"recruiterEmail": "dana@acme.test"}).status_code == 422


def test_recruiter_accepts_islikelyemail_addresses(client: TestClient) -> None:
    """Lock frontend-subset-of-backend: what `isLikelyEmail` accepts must not 422 here."""
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    url = f"/workspaces/default/applications/{app_['id']}/recruiter"
    for email in ("a@example.test", "first.last@sub.example.com", "x+tag@example.test"):
        assert (
            client.patch(url, json={"recruiterName": None, "recruiterEmail": email}).status_code
            == 200
        ), email


def test_recruiter_update_unknown_404(client: TestClient) -> None:
    res = client.patch(
        "/workspaces/default/applications/nope/recruiter",
        json={"recruiterName": None, "recruiterEmail": None},
    )
    assert res.status_code == 404, res.text


# --- delete cascade --------------------------------------------------------------------------


def test_delete_removes_application_and_cv(client: TestClient) -> None:
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    assert client.delete(f"/workspaces/default/applications/{app_['id']}").status_code == 200
    assert client.get(f"/workspaces/default/applications/{app_['id']}").status_code == 404
    assert client.get(f"/workspaces/default/cv/{cv_id}").status_code == 404
    # by-cv now answers a missing/deleted application with 200 `null`, not 404.
    gone = client.get(f"/workspaces/default/applications/by-cv/{cv_id}")
    assert gone.status_code == 200 and gone.json() is None


def test_delete_application_removes_cv_job_spec(
    client: TestClient, sqlite_maker: async_sessionmaker[AsyncSession]
) -> None:
    """Deleting an application cascades the locked CV's `cv_job_specs` row too (no orphan posting).
    Uses an AI-tailored CV (which has a job-spec row), signed off so it can be applied."""

    async def _spec(cv_id: str) -> JobSpec | None:
        async with sqlite_maker() as session:
            return await cv_store.get_job_spec(session, "default", cv_id)

    cv_id = _create_ai(client)
    _signoff_all(client, cv_id)
    app_ = _apply_ok(client, cv_id)
    assert asyncio.run(_spec(cv_id)) is not None
    assert client.delete(f"/workspaces/default/applications/{app_['id']}").status_code == 200
    assert asyncio.run(_spec(cv_id)) is None


def test_delete_unknown_application_404(client: TestClient) -> None:
    assert client.delete("/workspaces/default/applications/nope").status_code == 404


# --- tenant isolation (invariant 8) ----------------------------------------------------------


def test_stranger_denied_every_verb(client: TestClient) -> None:
    """A member of nothing is 403 on the whole tracker surface — every read AND every mutating
    verb (invariant 8; the docs claim 'stranger 403 on every verb')."""
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    app.dependency_overrides[current_user] = lambda: STRANGER  # member of nothing
    assert client.get("/workspaces/default/applications").status_code == 403
    assert client.get(f"/workspaces/default/applications/{app_['id']}").status_code == 403
    assert client.get(f"/workspaces/default/applications/by-cv/{cv_id}").status_code == 403
    assert (
        client.post(
            "/workspaces/default/applications", json={"cvId": cv_id, "baseVersion": 1}
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/workspaces/default/applications/{app_['id']}/stage", json={"stage": "screen"}
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/workspaces/default/applications/{app_['id']}/recruiter",
            json={"recruiterName": "x", "recruiterEmail": None},
        ).status_code
        == 403
    )
    assert client.delete(f"/workspaces/default/applications/{app_['id']}").status_code == 403


def test_cross_tenant_application_invisible(client: TestClient) -> None:
    """An application created in `default` is a 404 from `ws2`, even to a ws2 owner — no leak. The
    `by-cv` probe is the one exception: a cross-tenant miss reads 200 `null` (the same
    information-free body an unapplied CV returns), which carries zero foreign data — so isolation
    is preserved exactly as the old 404 communicated it."""
    cv_id = _create_draft(client)
    app_ = _apply_ok(client, cv_id, jobTitle="X")
    assert client.get(f"/workspaces/ws2/applications/{app_['id']}").status_code == 404
    by_cv = client.get(f"/workspaces/ws2/applications/by-cv/{cv_id}")
    assert by_cv.status_code == 200 and by_cv.json() is None
    assert client.delete(f"/workspaces/ws2/applications/{app_['id']}").status_code == 404
    assert (
        client.patch(
            f"/workspaces/ws2/applications/{app_['id']}/recruiter",
            json={"recruiterName": None, "recruiterEmail": None},
        ).status_code
        == 404
    )
    assert app_["id"] not in {r["id"] for r in client.get("/workspaces/ws2/applications").json()}
