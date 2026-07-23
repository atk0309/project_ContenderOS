"""Extractor agents (Claude) — one CV/LinkedIn document → an id-less `ExtractedProfile`.

The authoring/extraction side of ingestion (invariant 6). Extract-only, like the Parser: read what
the document literally states, attach a verbatim evidence snippet per unit; never mint ids, never
deduplicate, never invent. PR-C feeds a native PDF document block; PR-B1 feeds text.

**Why three agents, not one:** a single `messages.parse(output_format=ExtractedProfile)` is rejected
by the real Anthropic API (400 "Schema is too complex" / "Grammar compilation timed out", confirmed
by the ADR-0007 live spike). The driver is **optionality, not raw size**: the structured-output
grammar compiler must encode every presence-subset of an object's OPTIONAL fields (~2^N), so a
profile dense with optional fields blows its time budget — sections with MORE props/defs but
mostly-REQUIRED fields compile fine. Extraction therefore splits into three section-scoped calls,
run SEQUENTIALLY in `run_ingest.run_extract` and merged there; `RawBasics` keeps all fields REQUIRED
(the model emits "" for absent — see `_basics_system`) because it's the optional-dense section.
The containers are INTERNAL agent I/O — kept out of `app/schema/` so they never reach the OpenAPI/TS
wire surface — but they are `CamelModel` (`extra="forbid"`) so a section call can't silently absorb
another section's fields (invariant 5).
"""

from __future__ import annotations

from app.ai.agents.types import Agent
from app.schema.common import CamelModel, Provider, Tier
from app.schema.ingest import (
    ExtractedEducation,
    ExtractedLanguage,
    ExtractedProfileLink,
    ExtractedSkill,
    ExtractedWork,
)


class RawBasics(CamelModel):
    """Identity/contact fields, ALL REQUIRED (no defaults). Optionality — not property/def/anyOf
    count — is the structured-output grammar compiler's cost driver: an object with ~11 OPTIONAL
    keys forces it to encode ~2^11 presence-subsets, which it rejects/times-out ("Schema is too
    complex" / "Grammar compilation timed out", confirmed live, ADR 0007) — even though basics has
    FEWER props and defs than schemas the API accepts (qualifications, TailoredCV). Required fields
    collapse the grammar to one fixed shape; the model emits "" / [] for anything absent (see
    `_basics_system`), and `run_extract` maps `"" → None` into the wire `ExtractedBasics`."""

    name: str
    label: str
    email: str
    phone: str
    url: str
    summary: str
    city: str
    region: str
    country_code: str
    profiles: list[ExtractedProfileLink]
    evidence: str


class ExtractedWorkList(CamelModel):
    """The work section on its own — one structured-output call."""

    work: list[ExtractedWork] = []


class ExtractedQualifications(CamelModel):
    """Education + skills + languages in one structured-output call (all flat-ish, low anyOf).
    `languages` (`ExtractedLanguage`: name + optional fluency) folds in here rather than as a fourth
    Extractor call — its single optional scalar keeps the grammar budget well under the cliff that
    400'd the optional-dense basics (live-spiked D2a; see ADR 0007). No `certificates` since
    DevPR31: nothing renders or edits them, so ingestion stopped proposing them (dropping a
    defaulted list field only NARROWS the grammar — re-spiked live on the final schema)."""

    education: list[ExtractedEducation] = []
    skills: list[ExtractedSkill] = []
    languages: list[ExtractedLanguage] = []


_RULES = (
    "Rules:\n"
    "- Extract ONLY what the document literally states. Never invent, infer, or embellish.\n"
    "- Do NOT deduplicate, merge, or reorder; emit what you see. NEVER mint ids.\n"
    "- Omit any field the document does not state.\n"
    "- Set `evidence` to a short VERBATIM quote from the document that supports what you extracted."
)


def _build_input(text: str) -> str:
    return f"### DOCUMENT\n{text}"


def _basics_system() -> str:
    # Basics fields are REQUIRED (RawBasics, to keep the grammar compilable), so the model can't
    # omit; it must return "" / [] for absent. A basics-specific rule replaces _RULES' "omit" line.
    return (
        "You read ONE CV / LinkedIn document and extract ONLY the candidate's identity and contact "
        "details: name, headline/title, email, phone, website, professional summary, city, region, "
        "country, and profile links. IGNORE work history, education, skills, and certificates.\n"
        "Rules:\n"
        "- Extract ONLY what the document literally states. Never invent, infer, or embellish.\n"
        "- EVERY field is required: for any field the document does not state, return an "
        'empty string "" (and an empty list for `profiles`). Do NOT guess.\n'
        "- NEVER mint ids.\n"
        "- Set `evidence` to a short VERBATIM quote from the document supporting the identity."
    )


def _work_system() -> str:
    return (
        "You read ONE CV / LinkedIn document and extract ONLY the candidate's work history: "
        "one entry per role (company, position, dates) with each bullet point copied VERBATIM "
        "into `highlights`. IGNORE identity/contact details, education, skills, and certificates.\n"
        + _RULES
    )


def _qualifications_system() -> str:
    return (
        "You read ONE CV / LinkedIn document and extract ONLY the candidate's education, skills, "
        "and languages (spoken/written — set `fluency` to the stated proficiency, e.g. 'Native', "
        "'Professional working', 'B2', when given). IGNORE identity/contact details, work "
        "history, and certificates.\n" + _RULES
    )


basics_extractor: Agent[str, RawBasics] = Agent(
    id="extractor-basics",
    description="CV/LinkedIn document -> identity/contact fields (extract-only, with evidence).",
    provider=Provider.anthropic,
    tier=Tier.strong,
    output=RawBasics,
    system=_basics_system,
    build_input=_build_input,
    max_tokens=4000,
)

work_extractor: Agent[str, ExtractedWorkList] = Agent(
    id="extractor-work",
    description="CV/LinkedIn document -> work history with verbatim highlights (extract-only).",
    provider=Provider.anthropic,
    tier=Tier.strong,
    output=ExtractedWorkList,
    system=_work_system,
    build_input=_build_input,
    # A full multi-page work history is the largest structured output (most likely to truncate).
    max_tokens=16000,
)

qualifications_extractor: Agent[str, ExtractedQualifications] = Agent(
    id="extractor-qualifications",
    description="CV/LinkedIn doc -> education, skills, languages (extract-only).",
    provider=Provider.anthropic,
    tier=Tier.strong,
    output=ExtractedQualifications,
    system=_qualifications_system,
    build_input=_build_input,
    max_tokens=8000,
)
