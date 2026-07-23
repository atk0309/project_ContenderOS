"""Shared schema primitives.

Every model emits **camelCase** JSON (matching the design prototype, JSON Resume, and the
original TS harness) while staying snake_case in Python. The frontend's TypeScript types are
generated from the OpenAPI document these models produce, so camelCase here == camelCase there.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Base for every wire model: camelCase aliases, populate-by-name, reject extras."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


def _assume_utc(value: datetime) -> datetime:
    """Treat a tz-naive datetime as UTC. `DateTime(timezone=True)` columns are tz-aware on write
    (`datetime.now(UTC)`), but SQLite drops the tzinfo on read, so a re-read row arrives naive in
    dev. Without this the API would emit a bare ISO string (no offset) that browsers parse as
    *local* time → a wall-clock skew (e.g. "1h ago" for a just-now run). Aware values (Postgres)
    pass through unchanged."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


UtcDateTime = Annotated[datetime, AfterValidator(_assume_utc)]
"""Wire datetime that always serializes with a UTC offset (`…+00:00`), naive-safe. Use for every
response datetime field so clients never parse a bare timestamp as local time. Stays a `datetime`
(OpenAPI `format: date-time` unchanged); only the serialized value gains the offset."""


NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
"""A required, non-empty trimmed string. `""`/whitespace fail validation (→ a 422 at the request
boundary, a `ValidationError` under `model_validate`) — because Pydantic "required" only means
*present*, and `""` satisfies a plain `str`. Mirrors the bounded-text idiom in `cv.py`. Stays
`string` in OpenAPI/TS (gains `minLength: 1`)."""


MAX_BULLET_LEN = 1000
"""Max trimmed length of one tailored bullet's text. Shared by the manual-edit request
(`EditBulletRequest`) and the Corrector apply path (`cv_store._validate_bullet_text`) so a
model-authored correction is bounded exactly like a hand edit (a blank/oversized one is a 422)."""


class Seniority(StrEnum):
    junior = "junior"
    mid = "mid"
    senior = "senior"
    lead = "lead"
    principal = "principal"
    manager = "manager"


class Tone(StrEnum):
    corporate = "corporate"
    startup = "startup"
    technical = "technical"
    formal = "formal"


class Origin(StrEnum):
    """Provenance of a tailored bullet — net-new always requires sign-off (invariant 2)."""

    verbatim = "verbatim"
    reworded = "reworded"
    net_new = "net-new"


class SectionType(StrEnum):
    work = "work"
    projects = "projects"
    skills = "skills"
    education = "education"


class Severity(StrEnum):
    info = "info"
    minor = "minor"
    major = "major"


class AnchorKind(StrEnum):
    """What a review thread is pinned to. Anchors are *stable ids*, never array indices."""

    bullet = "bullet"
    item = "item"
    section = "section"
    summary = "summary"


class FactVerdict(StrEnum):
    supported = "supported"
    unsupported = "unsupported"
    overstated = "overstated"


class SlopFlag(StrEnum):
    generic_phrasing = "generic-phrasing"
    llm_tell = "llm-tell"
    cliche = "cliche"
    tonal_blandness = "tonal-blandness"
    off_voice = "off-voice"


class Decision(StrEnum):
    pass_ = "pass"
    borderline = "borderline"
    reject = "reject"


class Provider(StrEnum):
    anthropic = "anthropic"
    openai = "openai"


class Tier(StrEnum):
    """Model capability tier an agent asks for. The Admin Menu maps each tier to a real model id
    (from the live provider list); agents declare a tier, not a pinned model string."""

    strong = "strong"
    fast = "fast"
    cheap = "cheap"
