"""Server-side provenance derivation + stable-id validation (invariant 2). Pure functions, offline.

The server — never the model or client — decides `origin`/`needsSignoff`. The safety-critical line:
a bullet not grounded in a real master Highlight is forced to net-new and must be signed off, with
its (false) `sourceId` nulled. Stable-id uniqueness is enforced before anything is persisted.
"""

from __future__ import annotations

import pytest
from app.ai.provenance import (
    BlankStableId,
    DuplicateStableId,
    derive_provenance,
    ground_thread_anchors,
    validate_stable_ids,
)
from app.schema import (
    Basics,
    Highlight,
    Location,
    MasterProfile,
    TailoredBullet,
    TailoredCV,
    TailoredItem,
    TailoredSection,
    Thread,
    WorkEntry,
)
from app.schema.common import AnchorKind, Origin, SectionType, Severity

from tests.factories import sample_master_profile, sample_tailored_cv


def _only_bullet(cv: TailoredCV) -> TailoredBullet:
    return cv.sections[0].items[0].highlights[0]


def _cv_with(bullet: TailoredBullet) -> TailoredCV:
    return TailoredCV(
        job_spec_ref="j",
        master_version="1",
        version=1,
        summary="s",
        sections=[
            TailoredSection(
                section_id="s1",
                type=SectionType.work,
                items=[
                    TailoredItem(
                        item_id="i1", source_id="exampleco-integration-mgr", highlights=[bullet]
                    )
                ],
            )
        ],
    )


def test_valid_source_keeps_origin_and_clears_signoff() -> None:
    cv = derive_provenance(sample_tailored_cv(with_net_new=False), sample_master_profile())
    for section in cv.sections:
        for item in section.items:
            for bullet in item.highlights:
                assert bullet.source_id is not None
                assert bullet.needs_signoff is False
                assert bullet.origin in (Origin.verbatim, Origin.reworded)


def test_net_new_bullet_requires_signoff() -> None:
    cv = derive_provenance(sample_tailored_cv(with_net_new=True), sample_master_profile())
    net_new = [
        b
        for s in cv.sections
        for it in s.items
        for b in it.highlights
        if b.origin is Origin.net_new
    ]
    assert len(net_new) == 1
    assert net_new[0].needs_signoff is True
    assert net_new[0].source_id is None


def test_unknown_source_id_is_nulled_and_forced_net_new() -> None:
    bullet = TailoredBullet(
        bullet_id="b1", source_id="does-not-exist", text="x", origin=Origin.verbatim
    )
    cv = derive_provenance(_cv_with(bullet), sample_master_profile())
    out = _only_bullet(cv)
    assert out.source_id is None
    assert out.origin is Origin.net_new
    assert out.needs_signoff is True


def test_none_source_id_is_forced_net_new() -> None:
    bullet = TailoredBullet(bullet_id="b1", source_id=None, text="x", origin=Origin.reworded)
    out = _only_bullet(derive_provenance(_cv_with(bullet), sample_master_profile()))
    assert out.origin is Origin.net_new
    assert out.needs_signoff is True


def test_source_id_valid_for_another_item_is_forced_net_new() -> None:
    """A bullet whose `sourceId` is a real highlight of a DIFFERENT work entry than its item must
    not pass as grounded — the renderer would misattribute employer/dates. It becomes net-new."""
    master = MasterProfile(
        schema_version="1",
        basics=Basics(
            name="C",
            label="L",
            email="c@example.com",
            phone="0",
            location=Location(city="Example City", region="Example City", country_code="ZZ"),
            summary="s",
        ),
        work=[
            WorkEntry(
                id="acme",
                company="Acme",
                position="Eng",
                start_date="2021",
                highlights=[Highlight(id="acme-1", text="Acme work.")],
            ),
            WorkEntry(
                id="globex",
                company="Globex",
                position="Eng",
                start_date="2018",
                highlights=[Highlight(id="globex-1", text="Globex work.")],
            ),
        ],
    )
    # Item belongs to Acme, but the bullet claims Globex's highlight id.
    cv = TailoredCV(
        job_spec_ref="j",
        master_version="1",
        version=1,
        summary="s",
        sections=[
            TailoredSection(
                section_id="s1",
                type=SectionType.work,
                items=[
                    TailoredItem(
                        item_id="i1",
                        source_id="acme",
                        highlights=[
                            TailoredBullet(
                                bullet_id="b1",
                                source_id="globex-1",  # valid id, wrong employer
                                text="Misattributed.",
                                origin=Origin.verbatim,
                            )
                        ],
                    )
                ],
            )
        ],
    )
    out = _only_bullet(derive_provenance(cv, master))
    assert out.source_id is None
    assert out.origin is Origin.net_new
    assert out.needs_signoff is True


def test_validate_stable_ids_rejects_blank_bullet_id() -> None:
    cv = sample_tailored_cv()
    cv.sections[0].items[0].highlights[0].bullet_id = "   "  # whitespace-only → unanchored
    with pytest.raises(BlankStableId) as exc:
        validate_stable_ids(cv)
    assert exc.value.kind == "bullet"


def test_validate_stable_ids_rejects_duplicate_bullets() -> None:
    cv = sample_tailored_cv()
    cv.sections[0].items[0].highlights[1].bullet_id = "b1"  # collide with the first bullet
    with pytest.raises(DuplicateStableId) as exc:
        validate_stable_ids(cv)
    assert exc.value.kind == "bullet"


def test_validate_stable_ids_passes_on_unique_ids() -> None:
    validate_stable_ids(sample_tailored_cv())  # no raise


def _anchor(aid: str, kind: AnchorKind) -> Thread:
    return Thread(anchor_id=aid, anchor_kind=kind, severity=Severity.minor, comment="c")


def test_ground_thread_anchors_keeps_each_kind_matched_to_its_own_ids() -> None:
    """A thread is kept only when its id is real AND of the matching kind. `sample_tailored_cv` has
    section `s1`, item `i1`, bullets `b1`/`b2`/`b3`, and a non-empty summary."""
    cv = sample_tailored_cv()
    threads = [
        _anchor("b1", AnchorKind.bullet),
        _anchor("i1", AnchorKind.item),
        _anchor("s1", AnchorKind.section),
        _anchor("summary", AnchorKind.summary),
    ]
    kept = {(t.anchor_id, t.anchor_kind) for t in ground_thread_anchors(threads, cv)}
    assert kept == {
        ("b1", AnchorKind.bullet),
        ("i1", AnchorKind.item),
        ("s1", AnchorKind.section),
        ("summary", AnchorKind.summary),
    }


def test_ground_thread_anchors_drops_miskinded_and_unknown() -> None:
    """A real section id under `anchorKind: bullet` (mis-pinned) and a hallucinated id are both
    dropped — they would orphan in the renderer."""
    cv = sample_tailored_cv()
    threads = [
        _anchor("s1", AnchorKind.bullet),  # s1 is a section, not a bullet
        _anchor("ghost", AnchorKind.bullet),
        _anchor("b1", AnchorKind.section),  # b1 is a bullet, not a section
    ]
    assert ground_thread_anchors(threads, cv) == []


def test_ground_thread_anchors_drops_summary_when_summary_is_empty() -> None:
    """The summary line only renders when the CV has summary text, so a summary anchor on an empty
    summary is orphaned and must be dropped."""
    cv = sample_tailored_cv()
    summary_thread = _anchor("summary", AnchorKind.summary)
    cv.summary = "   "  # whitespace-only → no summary line renders
    assert ground_thread_anchors([summary_thread], cv) == []
    cv.summary = "A real summary."
    assert ground_thread_anchors([summary_thread], cv) == [summary_thread]
