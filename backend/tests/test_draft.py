"""The deterministic verbatim draft (`build_verbatim_draft`) + the keyless `POST /cv/from-master`.

No provider key, no AI: every bullet is a verbatim copy of a master highlight, so the draft is zero
net-new and exports without sign-off. Offline: SQLite + an in-memory membership store."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from app.ai.draft import build_verbatim_draft
from app.ai.provenance import validate_stable_ids
from app.auth.deps import current_user
from app.main import app
from app.persistence import get_membership_store
from app.schema import AuthUser, EducationEntry, Highlight, Membership, WorkEntry
from app.schema.common import Origin
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.factories import InMemoryMembershipStore, sample_master_profile

OWNER = AuthUser(email="owner@example.com")
_STORE = InMemoryMembershipStore([Membership(workspace_id="default", email=OWNER.email)])


# --- Unit: build_verbatim_draft -------------------------------------------------------------------


def test_draft_all_verbatim_zero_net_new() -> None:
    cv = build_verbatim_draft(sample_master_profile())
    bullets = [b for s in cv.sections for it in s.items for b in it.highlights]
    assert bullets, "expected at least one work bullet"
    assert all(b.origin is Origin.verbatim for b in bullets)
    assert all(not b.needs_signoff for b in bullets)
    assert cv.needs_signoff() is False


def test_draft_emits_work_skills_education_sections() -> None:
    master = sample_master_profile()
    master.education = [
        EducationEntry(
            id="bsc-cs",
            institution="Example University",
            area="Computer Science",
            study_type="BSc",
            start_date="2008",
        )
    ]
    cv = build_verbatim_draft(master)
    assert {s.type.value for s in cv.sections} == {"work", "skills", "education"}
    skills = next(s for s in cv.sections if s.type.value == "skills")
    assert skills.items == []  # empty -> renderer falls back to master.skills
    education = next(s for s in cv.sections if s.type.value == "education")
    assert [it.source_id for it in education.items] == ["bsc-cs"]


def test_draft_namespacing_survives_work_eq_education_id() -> None:
    """A work id equal to an education id would collide without item-id namespacing."""
    master = sample_master_profile()
    master.education = [
        EducationEntry(
            id="exampleco-integration-mgr",  # same string as work[0].id
            institution="X",
            area="CS",
            study_type="BSc",
            start_date="2010",
        )
    ]
    validate_stable_ids(build_verbatim_draft(master))  # must not raise


def test_draft_namespacing_survives_repeated_highlight_id_across_entries() -> None:
    """A highlight id reused across work entries stays unique once bullet ids are namespaced."""
    master = sample_master_profile()
    master.work.append(
        WorkEntry(
            id="globex",
            company="Globex",
            position="Engineer",
            start_date="2015",
            highlights=[Highlight(id="exampleco-1", text="A highlight id reused across entries.")],
        )
    )
    validate_stable_ids(build_verbatim_draft(master))  # must not raise


# --- Route: POST /workspaces/{id}/cv/from-master --------------------------------------------------


@pytest.fixture
def client(sqlite_maker: async_sessionmaker[AsyncSession]) -> Iterator[TestClient]:
    app.dependency_overrides[current_user] = lambda: OWNER
    app.dependency_overrides[get_membership_store] = lambda: _STORE
    try:
        yield TestClient(app, base_url="https://testserver")
    finally:
        app.dependency_overrides.clear()


def _put_master(client: TestClient) -> None:
    res = client.put(
        "/workspaces/default/master", json=sample_master_profile().model_dump(by_alias=True)
    )
    assert res.status_code == 200, res.text


def test_from_master_persists_and_exports_without_signoff(client: TestClient) -> None:
    _put_master(client)
    res = client.post("/workspaces/default/cv/from-master")
    assert res.status_code == 200, res.text
    cv_id = res.json()["id"]
    # Zero net-new -> the export gate (invariant 2) is clear immediately, no sign-off needed.
    exported = client.get(f"/workspaces/default/cv/{cv_id}/export")
    assert exported.status_code == 200
    body = exported.json()
    assert "master" in body and "cv" in body


def test_from_master_404_without_master(client: TestClient) -> None:
    assert client.post("/workspaces/default/cv/from-master").status_code == 404
