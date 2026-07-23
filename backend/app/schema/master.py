"""MasterProfile — the canonical truth about the operator.

JSON Resume superset. Every work bullet carries a stable `id`; that id is what makes
provenance possible (a tailored bullet's `sourceId` points back to one of these).
"""

from __future__ import annotations

from app.schema.common import CamelModel, NonBlank


class Highlight(CamelModel):
    id: str  # stable bullet id — the anchor for provenance
    text: str


class WorkEntry(CamelModel):
    id: str  # stable, e.g. "exampleco-integration-mgr"
    company: str
    position: str
    start_date: str
    end_date: str | None = None
    highlights: list[Highlight]
    tags: list[str] = []  # skill/domain tags for matching


class EducationEntry(CamelModel):
    id: str
    institution: str
    area: str
    study_type: str
    start_date: str
    end_date: str | None = None


class Skill(CamelModel):
    name: str
    level: str | None = None
    keywords: list[str] = []


class Certificate(CamelModel):
    name: str
    issuer: str
    date: str


class Language(CamelModel):
    # JSON Resume `languages[]`: the language name + optional fluency ("Native speaker", "B2").
    # Mirrors `Skill` — no stable id (not a provenance anchor), one optional field, so it stays a
    # small low-optionality shape (the Extractor's grammar budget — see agents/extractor.py).
    language: str
    fluency: str | None = None


class ProfileLink(CamelModel):
    network: str  # LinkedIn, GitHub
    url: str


class Location(CamelModel):
    # All optional — a CV may give an unstructured address the extractor can't split into
    # city/region/country. The renderer filters empties (it composes city/region).
    city: str = ""
    region: str = ""
    country_code: str = ""


class Basics(CamelModel):
    # Only name + email are mandatory (and non-blank — "" satisfies a plain `str`,
    # so a required field alone wouldn't reject a blank PUT). The rest are recommended: they default
    # empty and the import nudges (yellow) rather than blocking. `location` defaults to an empty
    # Location (a plain `= Location()` default, NOT default_factory, so it stays non-optional in the
    # generated TS — see the plan) so every consumer can read `basics.location.*` unguarded.
    name: NonBlank
    email: NonBlank
    label: str = ""
    phone: str = ""
    url: str | None = None
    location: Location = Location()
    profiles: list[ProfileLink] = []
    summary: str = ""


class MasterProfile(CamelModel):
    schema_version: str
    basics: Basics
    work: list[WorkEntry] = []
    education: list[EducationEntry] = []
    skills: list[Skill] = []
    # Present list (mirrors `skills`), never optional — defaults empty so consumers read it plainly.
    languages: list[Language] = []
    certificates: list[Certificate] | None = None
