"""Tiny builders + test doubles for tests — a minimal, valid TailoredCV with one of each bullet
origin, sample master/job factories, and the in-memory membership store the suite wires for
per-workspace authorization (invariant 8)."""

from __future__ import annotations

from app.schema import (
    Basics,
    Highlight,
    JobSpec,
    Location,
    MasterProfile,
    Membership,
    TailoredBullet,
    TailoredCV,
    TailoredItem,
    TailoredSection,
    WorkEntry,
)
from app.schema.common import Origin, SectionType, Seniority, Tone


class InMemoryMembershipStore:
    """A `MembershipStore` backed by an explicit membership list — the test double the suite wires
    via `get_membership_store` overrides (app code always uses `AllowlistMembershipStore`).
    Deny-by-default: an unknown `(workspace, user)` pair resolves to `False`."""

    def __init__(self, memberships: list[Membership]) -> None:
        self._keys = {(m.workspace_id, m.email.strip().lower()) for m in memberships}

    def is_member(self, workspace_id: str, email: str) -> bool:
        return (workspace_id, email.strip().lower()) in self._keys


def sample_tailored_cv(*, with_net_new: bool = True) -> TailoredCV:
    bullets = [
        TailoredBullet(
            bullet_id="b1",
            source_id="exampleco-1",
            text="Led migration of 40 EDI partners to the new platform.",
            origin=Origin.verbatim,
        ),
        TailoredBullet(
            bullet_id="b2",
            source_id="exampleco-2",
            text="Cut onboarding time 60% by standardising the integration playbook.",
            origin=Origin.reworded,
        ),
    ]
    if with_net_new:
        bullets.append(
            TailoredBullet(
                bullet_id="b3",
                source_id=None,
                text="Owned the partner SLA dashboard end to end.",
                origin=Origin.net_new,
                needs_signoff=True,
            )
        )
    return TailoredCV(
        job_spec_ref="job-1",
        master_version="2026-06-18",
        version=1,
        summary="Integration manager focused on EDI and partner onboarding.",
        sections=[
            TailoredSection(
                section_id="s1",
                type=SectionType.work,
                items=[
                    TailoredItem(
                        item_id="i1",
                        source_id="exampleco-integration-mgr",
                        position="Integration Manager",
                        company="ExampleCo",
                        highlights=bullets,
                    )
                ],
            )
        ],
    )


def sample_master_profile() -> MasterProfile:
    """A master whose work highlights are the valid `sourceId`s `sample_tailored_cv` references —
    so provenance derivation keeps the grounded bullets and only the net-new one needs sign-off."""
    return MasterProfile(
        schema_version="1",
        basics=Basics(
            name="Sample Candidate",
            label="Integration Manager",
            email="sample@example.com",
            phone="+00 000 000 000",
            location=Location(city="Example City", region="Example Region", country_code="ZZ"),
            summary="Master summary.",
        ),
        work=[
            WorkEntry(
                id="exampleco-integration-mgr",
                company="ExampleCo",
                position="Integration Manager",
                start_date="2019",
                highlights=[
                    Highlight(id="exampleco-1", text="Led migration of 40 EDI partners."),
                    Highlight(id="exampleco-2", text="Cut onboarding time 60%."),
                ],
            )
        ],
    )


def sample_job_spec() -> JobSpec:
    return JobSpec(
        raw_text="We need a Senior Integration Engineer with strong EDI and REST API experience.",
        title="Senior Integration Engineer",
        company="Acme",
        seniority=Seniority.senior,
        must_haves=["EDI", "REST APIs"],
        nice_to_haves=["AS2"],
        ats_keywords=["EDI", "AS2", "REST", "Python"],
        tone=Tone.corporate,
    )
