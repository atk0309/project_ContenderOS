"""PR-E reconciliation unit tests — `build_reconciled_proposals` (re-grounding, enrich/correction
derivation) and `apply_accepted` (enrich append, correction overwrite). Pure functions: no DB, no
runner. The work-matching model output is supplied directly as a `WorkReconciliation`."""

from __future__ import annotations

from app.ai.agents.ingest import build_reconciled_proposals
from app.ai.agents.reconciler import WorkMatch, WorkReconciliation
from app.ai.ingest_apply import apply_accepted
from app.ai.provenance import derive_provenance
from app.schema import (
    TailoredBullet,
    TailoredCV,
    TailoredItem,
    TailoredSection,
)
from app.schema.common import Origin, SectionType
from app.schema.ingest import (
    ExtractedBasics,
    ExtractedProfile,
    ExtractedWork,
    IngestionProposal,
    IngestRelationship,
    IngestUnitKind,
)
from app.schema.master import Basics, Highlight, Location, MasterProfile, WorkEntry

from tests.factories import sample_master_profile


def _basics(**over: str) -> Basics:
    base: dict[str, object] = {
        "name": "Sample",
        "label": "Engineer",
        "email": "s@example.com",
        "phone": "+1",
        "location": Location(city="Example City", region="Example Region", country_code="ZZ"),
        "summary": "Master summary.",
    }
    base.update(over)
    return Basics(**base)  # type: ignore[arg-type]


def _master(work: list[WorkEntry] | None = None, **basics_over: str) -> MasterProfile:
    return MasterProfile(schema_version="1", basics=_basics(**basics_over), work=work or [])


def _ework(
    highlights: list[str], company: str = "ExampleCo", position: str = "Eng"
) -> ExtractedWork:
    return ExtractedWork(
        company=company, position=position, start_date="2019", highlights=highlights
    )


def _profile(
    *, basics: ExtractedBasics | None = None, work: list[ExtractedWork] | None = None
) -> ExtractedProfile:
    return ExtractedProfile(basics=basics or ExtractedBasics(), work=work or [])


def _no_matches() -> WorkReconciliation:
    return WorkReconciliation(matches=[])


# --- re-grounding / proposal derivation --------------------------------------------------------


def test_unmatched_role_is_net_new_work() -> None:
    extracted = _profile(work=[_ework(["Did a thing."])])
    proposals = build_reconciled_proposals(extracted, _master(), _no_matches(), "doc")
    work = [p for p in proposals if p.unit_kind is IngestUnitKind.work]
    assert len(work) == 1
    assert work[0].relationship is IngestRelationship.net_new
    assert not any(p.unit_kind is IngestUnitKind.highlight for p in proposals)


def test_matched_role_enriches_only_new_highlights() -> None:
    master = _master(
        work=[
            WorkEntry(
                id="w1",
                company="ExampleCo",
                position="Eng",
                start_date="2019",
                highlights=[Highlight(id="h1", text="Led the migration.")],
            )
        ]
    )
    extracted = _profile(work=[_ework(["Led the migration.", "Cut costs 30%."])])
    recon = WorkReconciliation(matches=[WorkMatch(extracted_index=0, master_work_id="w1")])
    proposals = build_reconciled_proposals(extracted, master, recon, "doc")
    enrich = [p for p in proposals if p.unit_kind is IngestUnitKind.highlight]
    assert [p.content.highlight.text for p in enrich if p.content.highlight] == ["Cut costs 30%."]
    assert enrich[0].relationship is IngestRelationship.enrich
    assert enrich[0].target_work_id == "w1"
    assert enrich[0].target_label == "ExampleCo · Eng"
    # The matched role itself is NOT re-proposed as a net-new work entry.
    assert not any(p.unit_kind is IngestUnitKind.work for p in proposals)


def test_pure_duplicate_role_yields_no_proposals() -> None:
    master = _master(
        work=[
            WorkEntry(
                id="w1",
                company="ExampleCo",
                position="Eng",
                start_date="2019",
                highlights=[Highlight(id="h1", text="Led the migration.")],
            )
        ]
    )
    extracted = _profile(work=[_ework(["led   the migration."])])  # normalised-equal
    recon = WorkReconciliation(matches=[WorkMatch(extracted_index=0, master_work_id="w1")])
    proposals = build_reconciled_proposals(extracted, master, recon, "doc")
    assert proposals == []


def test_dangling_match_demotes_to_net_new() -> None:
    """A match pointing at a master_work_id that doesn't exist is re-grounded away (D1) — the role
    becomes net-new, never an enrich against a phantom entry."""
    master = _master(
        work=[
            WorkEntry(
                id="w1", company="ExampleCo", position="Eng", start_date="2019", highlights=[]
            )
        ]
    )
    extracted = _profile(work=[_ework(["A bullet."])])
    recon = WorkReconciliation(matches=[WorkMatch(extracted_index=0, master_work_id="ghost")])
    proposals = build_reconciled_proposals(extracted, master, recon, "doc")
    assert [p.unit_kind for p in proposals] == [IngestUnitKind.work]
    assert proposals[0].relationship is IngestRelationship.net_new


def test_out_of_range_and_duplicate_index_demote() -> None:
    """An out-of-range extractedIndex, and a second match claiming an already-taken index or master
    id, are dropped — those roles fall through to net-new."""
    master = _master(
        work=[
            WorkEntry(id="w1", company="A", position="Eng", start_date="2019", highlights=[]),
            WorkEntry(id="w2", company="B", position="Eng", start_date="2018", highlights=[]),
        ]
    )
    extracted = _profile(work=[_ework(["x"], company="A"), _ework(["y"], company="B")])
    recon = WorkReconciliation(
        matches=[
            WorkMatch(extracted_index=5, master_work_id="w1"),  # out of range
            WorkMatch(extracted_index=0, master_work_id="w1"),  # ok
            WorkMatch(extracted_index=1, master_work_id="w1"),  # duplicate master id
        ]
    )
    proposals = build_reconciled_proposals(extracted, master, recon, "doc")
    # index 0 → enrich on w1; index 1's match is dropped (w1 already claimed) → net-new work.
    assert any(
        p.unit_kind is IngestUnitKind.highlight and p.target_work_id == "w1" for p in proposals
    )
    assert any(p.unit_kind is IngestUnitKind.work for p in proposals)


def test_basics_fill_suppress_correct() -> None:
    master = _master(
        name="Old Name", email="old@example.test"
    )  # label/phone/summary/location match
    extracted = _profile(
        basics=ExtractedBasics(
            name="New Name",  # differs → correction
            label="Engineer",  # equal → suppress
            url="https://example.com/profile",  # master url is None → net-new fill
            evidence="src",
        )
    )
    proposals = build_reconciled_proposals(extracted, master, _no_matches(), "doc")
    by_path = {p.content.field.field_path: p for p in proposals if p.content.field is not None}
    assert by_path["basics.name"].relationship is IngestRelationship.correction
    assert by_path["basics.name"].current_value == "Old Name"
    assert by_path["basics.url"].relationship is IngestRelationship.net_new
    assert "basics.label" not in by_path  # equal → suppressed


# --- apply: enrich + correction ----------------------------------------------------------------


def _enrich_proposals(
    master: MasterProfile, extracted_highlights: list[str]
) -> list[IngestionProposal]:
    extracted = _profile(work=[_ework(extracted_highlights)])
    recon = WorkReconciliation(matches=[WorkMatch(extracted_index=0, master_work_id="w1")])
    return [
        p
        for p in build_reconciled_proposals(extracted, master, recon, "doc")
        if p.unit_kind is IngestUnitKind.highlight
    ]


def _one_entry_master() -> MasterProfile:
    return _master(
        work=[
            WorkEntry(
                id="w1",
                company="ExampleCo",
                position="Eng",
                start_date="2019",
                highlights=[Highlight(id="h1", text="Existing bullet.")],
            )
        ]
    )


def test_apply_enrich_appends_preserving_ids() -> None:
    master = _one_entry_master()
    proposals = _enrich_proposals(master, ["A new bullet."])
    new_master, conflicts, applied = apply_accepted(master, proposals)
    entry = new_master.work[0]
    assert entry.id == "w1"
    assert [h.text for h in entry.highlights] == ["Existing bullet.", "A new bullet."]
    assert entry.highlights[0].id == "h1"  # existing id preserved
    new_hid = entry.highlights[1].id
    assert conflicts == []
    assert applied[proposals[0].proposal_id] == f"w1:{new_hid}"


def test_apply_multi_enrich_same_entry_both_land() -> None:
    master = _one_entry_master()
    proposals = _enrich_proposals(master, ["Bullet one.", "Bullet two."])
    assert len(proposals) == 2
    new_master, conflicts, _ = apply_accepted(master, proposals)
    texts = [h.text for h in new_master.work[0].highlights]
    assert texts == ["Existing bullet.", "Bullet one.", "Bullet two."]
    ids = [h.id for h in new_master.work[0].highlights]
    assert len(set(ids)) == 3  # no colliding minted ids
    assert conflicts == []


def test_apply_enrich_target_gone_is_conflict_and_partial() -> None:
    """An enrich whose target work entry no longer exists is an ApplyConflict; a co-accepted net-new
    skill in the same set still lands (partial apply)."""
    master = _one_entry_master()
    enrich = _enrich_proposals(master, ["A new bullet."])
    # Drop the target entry from the master the set is applied against.
    master_without_target = _master(work=[])
    _, conflicts, applied = apply_accepted(master_without_target, enrich)
    assert len(conflicts) == 1
    assert "no longer exists" in conflicts[0].reason
    assert enrich[0].proposal_id not in applied


def test_apply_correction_overwrites_when_current_matches() -> None:
    master = _master(name="Old Name")
    extracted = _profile(basics=ExtractedBasics(name="New Name", evidence="src"))
    proposals = build_reconciled_proposals(extracted, master, _no_matches(), "doc")
    new_master, conflicts, _ = apply_accepted(master, proposals)
    assert new_master.basics.name == "New Name"
    assert conflicts == []


def test_apply_correction_stale_current_is_conflict() -> None:
    """If the live field no longer holds the value the correction was reconciled against, the
    overwrite is refused (stale-overwrite guard) — the field is left untouched."""
    master = _master(name="Old Name")
    extracted = _profile(basics=ExtractedBasics(name="New Name", evidence="src"))
    proposals = build_reconciled_proposals(extracted, master, _no_matches(), "doc")
    # The master moved on after reconciliation (different live value than current_value).
    live_master = _master(name="Manually Changed")
    new_master, conflicts, _ = apply_accepted(live_master, proposals)
    assert new_master.basics.name == "Manually Changed"  # not clobbered
    assert any("changed since import" in c.reason for c in conflicts)


def test_apply_correction_edited_field_path_cannot_retarget() -> None:
    """An owner edit may change the value but NOT which field a correction writes: apply reads the
    field path from server-built `content`, never from `edited` (invariant 2)."""
    master = _master(name="Old Name", email="keep@example.test")
    extracted = _profile(basics=ExtractedBasics(name="New Name", evidence="src"))
    [correction] = [
        p
        for p in build_reconciled_proposals(extracted, master, _no_matches(), "doc")
        if p.content.field and p.content.field.field_path == "basics.name"
    ]
    # Forge an edit that tries to retarget to basics.email with a new value.
    tampered = correction.model_copy(update={"edited": correction.content.model_copy(deep=True)})
    assert tampered.edited is not None and tampered.edited.field is not None
    tampered.edited.field.field_path = "basics.email"
    tampered.edited.field.value = "Edited Value"
    new_master, conflicts, _ = apply_accepted(master, [tampered])
    assert new_master.basics.name == "Edited Value"  # value applied to the SERVER-owned path
    assert new_master.basics.email == "keep@example.test"  # the retarget was ignored
    assert conflicts == []


# --- re-tailor regression ----------------------------------------------------------------------


def test_enriched_highlight_is_a_valid_tailor_source() -> None:
    """An enrich appended via ingestion is a real provenance anchor: a tailored bullet citing its
    freshly-minted highlight id stays grounded (not demoted to net-new) — closing the loop between
    PR-E enrich and the invariant-2 provenance gate."""
    master = sample_master_profile()  # work entry "exampleco-integration-mgr"
    new_text = "Owned the partner SLA dashboard end to end."
    extracted = _profile(work=[_ework([new_text], position="Integration Manager")])
    recon = WorkReconciliation(
        matches=[WorkMatch(extracted_index=0, master_work_id="exampleco-integration-mgr")]
    )
    enrich = [
        p
        for p in build_reconciled_proposals(extracted, master, recon, new_text)
        if p.unit_kind is IngestUnitKind.highlight
    ]
    assert len(enrich) == 1
    new_master, conflicts, _ = apply_accepted(master, enrich)
    assert conflicts == []
    entry = next(w for w in new_master.work if w.id == "exampleco-integration-mgr")
    new_hid = next(h.id for h in entry.highlights if h.text == new_text)

    bullet = TailoredBullet(
        bullet_id="b9", source_id=new_hid, text=new_text, origin=Origin.verbatim
    )
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
                        item_id="i1", source_id="exampleco-integration-mgr", highlights=[bullet]
                    )
                ],
            )
        ],
    )
    derive_provenance(cv, new_master)
    assert bullet.source_id == new_hid
    assert bullet.origin is Origin.verbatim
    assert not bullet.needs_signoff
