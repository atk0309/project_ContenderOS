"""TailoredCV — a variant of the CV for one job (provenance-tracked, versioned).

Two stable-id rules make the review loop correct (see ADR 0003):
  * Every bullet/item/section carries a stable id (`bulletId`/`itemId`/`sectionId`) that the
    Corrector PRESERVES across rewrites — only net-new bullets get fresh ids. Review threads
    anchor to these ids, never to array indices, so a note tracks its bullet through reorders.
  * Every bullet also carries `sourceId` (-> master Highlight.id) for provenance, plus `origin`.
    `origin == net-new` forces `needsSignoff == True`, which BLOCKS export until the operator
    approves it (invariant 2). The client may never set `origin`/`needsSignoff`; the server does.
"""

from __future__ import annotations

from app.schema.common import CamelModel, Origin, SectionType


class TailoredBullet(CamelModel):
    bullet_id: str  # stable across versions; preserved by the Corrector on reword
    source_id: str | None  # -> master Highlight.id, or None if net-new
    text: str
    origin: Origin
    needs_signoff: bool = False  # True for net-new — blocks export until owner sign-off


class TailoredItem(CamelModel):
    item_id: str  # stable id for the work/project entry within this CV
    source_id: str  # -> master WorkEntry.id (or project id)
    position: str | None = None
    company: str | None = None
    highlights: list[TailoredBullet] = []


class TailoredSection(CamelModel):
    section_id: str  # stable id for the section
    type: SectionType
    items: list[TailoredItem] = []


class TailoredCV(CamelModel):
    job_spec_ref: str
    master_version: str
    version: int  # bumped on each applyFeedback (Corrector) or manual save
    parent_version: int | None = None  # for diffing against the prior snapshot
    summary: str
    sections: list[TailoredSection] = []

    def needs_signoff(self) -> bool:
        """True if any bullet is an unapproved net-new claim. Export is blocked while true."""
        return any(
            bullet.needs_signoff
            for section in self.sections
            for item in section.items
            for bullet in item.highlights
        )
