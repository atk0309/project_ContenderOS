"""JobSpec — the parsed posting plus owner-supplied additions.

`ParsedJobSpec` is what the Parser extracts (extract-only; `redFlags` captures vague language).
`JobSpec` adds owner-supplied bits (the posting URL); it's the wire + persisted model. Splitting
them keeps the Parser's output schema free of owner-only fields, so the model can never produce one.
"""

from __future__ import annotations

from app.schema.common import CamelModel, Seniority, Tone


class ParsedJobSpec(CamelModel):
    """What the Parser agent extracts from a pasted posting — no owner input."""

    raw_text: str  # keep the original posting, always
    title: str
    company: str | None = None
    seniority: Seniority
    must_haves: list[str] = []
    nice_to_haves: list[str] = []
    ats_keywords: list[str] = []  # exact tokens an ATS likely screens for
    tone: Tone
    red_flags: list[str] = []


class JobSpec(ParsedJobSpec):
    """The wire + persisted posting: parsed fields PLUS owner-supplied additions. `postingUrl` is
    owner-supplied (the new-application modal) — NOT on `ParsedJobSpec`, so the Parser can't produce
    it. Optional + defaulted so legacy `cv_job_specs` blobs (pre-field) still validate."""

    posting_url: str | None = None
