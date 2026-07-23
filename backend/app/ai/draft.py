"""Deterministic "verbatim draft" — build a TailoredCV from a MasterProfile with NO model call.

This is the keyless path: no provider key, no AI. Every tailored bullet is a verbatim copy of a
master highlight, grounded by `sourceId`, so the server-side provenance pass keeps it grounded and
the result has **zero net-new bullets** — export is never blocked. It honours the same invariants as
the Tailor: judgment-vs-rendering (deterministic code emits the JSON; the renderer renders it,
invariant 1) and provenance (every bullet maps to a real master highlight, invariant 2). It runs the
exact same `derive_provenance` + `validate_stable_ids` pass the Tailor does, so a malformed master
surfaces loudly (422) rather than as a silently broken draft.
"""

from __future__ import annotations

from app.ai.provenance import derive_provenance, validate_stable_ids
from app.schema import MasterProfile, TailoredCV
from app.schema.common import Origin, SectionType
from app.schema.tailored import TailoredBullet, TailoredItem, TailoredSection


def build_verbatim_draft(master: MasterProfile) -> TailoredCV:
    """A TailoredCV that copies the master verbatim — the AI-free draft the workspace starts from.

    Emits `work` + `skills` + `education` sections: the renderer shows only sections present in
    `cv.sections`; the skills section is empty-items so the renderer falls back to `master.skills`,
    and education renders one item per master education entry. Item/bullet ids are **namespaced**
    (`work:{id}` / `education:{id}` and `{work.id}:{highlight.id}`) so a `work.id == education.id`
    collision, or a highlight id repeated across work entries, can't trip `validate_stable_ids`
    (which requires every id globally unique across the CV)."""
    work_section = TailoredSection(
        section_id="work",
        type=SectionType.work,
        items=[
            TailoredItem(
                item_id=f"work:{work.id}",
                source_id=work.id,
                position=work.position,
                company=work.company,
                highlights=[
                    TailoredBullet(
                        bullet_id=f"{work.id}:{highlight.id}",
                        source_id=highlight.id,
                        text=highlight.text,
                        origin=Origin.verbatim,
                    )
                    for highlight in work.highlights
                ],
            )
            for work in master.work
        ],
    )
    # Empty items -> the renderer pulls skill names off the master (see frontend render/model.ts).
    skills_section = TailoredSection(section_id="skills", type=SectionType.skills, items=[])
    education_section = TailoredSection(
        section_id="education",
        type=SectionType.education,
        items=[
            TailoredItem(item_id=f"education:{edu.id}", source_id=edu.id, highlights=[])
            for edu in master.education
        ],
    )
    cv = TailoredCV(
        job_spec_ref="verbatim-draft",
        master_version=master.schema_version,
        version=1,
        summary=master.basics.summary,
        sections=[work_section, skills_section, education_section],
    )
    cv = derive_provenance(cv, master)  # grounded verbatim bullets -> zero net-new
    validate_stable_ids(cv)
    return cv
