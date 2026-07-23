"""Application — a tracked job. Carries (a reference to) the exact CV version that was sent.

An application **locks** its CV: once applied, the CV's `{master, cv}` snapshot is immutable and the
CV is moved out of the active workspace into the tracker (invariant 2 stays satisfied — apply
requires full sign-off, so the frozen bundle is forever export-clear). The lock is *derived* from
the existence of the `stored_applications` row (no column on `stored_cvs`); see ADR 0009.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Final

from pydantic import Field, field_validator

from app.schema.common import CamelModel, NonBlank, UtcDateTime

DEFAULT_STAGES: Final[list[str]] = [
    "applied",
    "acknowledged",
    "screen",
    "interview",
    "final",
    "offer",
    "rejected",
    "withdrawn",
]


class StageEvent(CamelModel):
    """One entry in an application's status timeline. `at` is server-set (UTC offset on wire)."""

    at: UtcDateTime
    stage: str
    note: str | None = None


class Application(CamelModel):
    """A tracked job application. `tailored_cv_ref` is the locked `StoredCV.id`; `job_title` is
    server-resolved (request title, else the CV's `cv_labels` title) so it's never blank. `stage` is
    the current stage (one of `stages`); `events` is the append-only timeline."""

    id: str
    job_title: NonBlank
    company: str | None = None
    job_url: str | None = None
    tailored_cv_ref: str  # the exact CV version sent (the locked StoredCV.id)
    applied_at: UtcDateTime
    stage: str  # current stage (one of `stages`)
    stages: list[str] = DEFAULT_STAGES  # editable per application
    events: list[StageEvent] = []
    # Optional recruiter contact (owner-editable via PATCH …/recruiter). Default `None` so old
    # stored blobs (no recruiter keys) validate unchanged — additive, no migration (ADR 0006/0009).
    recruiter_name: str | None = None
    recruiter_email: str | None = None


class ApplyRequest(CamelModel):
    """Body for `POST /workspaces/{id}/applications` — lock a finished CV against a job.

    Only the CV id + display/tracking metadata cross the wire; the server re-reads the CV, re-checks
    the sign-off gate, and resolves the title (this request, else the CV's `cv_labels` title — so a
    keyless draft, which has no label, must supply one here, else 422). `base_version` is the CV
    version the client was viewing — a stale apply is rejected (409 `stale`)."""

    cv_id: str
    job_title: NonBlank | None = None
    company: str | None = None
    job_url: str | None = None
    note: str | None = None
    base_version: int = Field(ge=1)


class ApplicationSummary(CamelModel):
    """A lightweight row for the tracker list — enough to label, badge the stage, and open the
    detail without shipping the full timeline. `applied_at` is the stored time (UTC on the wire)."""

    id: str
    job_title: str
    company: str | None = None
    stage: str
    applied_at: UtcDateTime
    cv_id: str


class StageUpdateRequest(CamelModel):
    """Body for `PATCH /workspaces/{id}/applications/{id}/stage` — advance the status pipeline. The
    stage must be one of the application's `stages` (else 422); the optional note joins the timeline
    event the server appends."""

    stage: str
    note: str | None = None


# Pragmatic email charset that EXCLUDES URI/mailto metacharacters (`? # & % ,` + whitespace) so a
# stored address can't inject `mailto:` headers (e.g. `hr@example.test?bcc=…` would otherwise add
# a Bcc).
# One `@`, a dotted domain, a 2+ alpha TLD. The frontend `isLikelyEmail` MUST mirror this regex
# verbatim (frontend ⊆ backend → a client-accepted value never 422s here); it also gates the
# render-time `mailto:`, so the charset restriction IS the injection guard.
_RECRUITER_EMAIL_RE: Final = re.compile(r"^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def _blank_to_none(v: str | None) -> str | None:
    """Trim; treat `None`/blank as absent. Short-circuits on `None` so `.strip()` never 500s the
    clear-to-null path."""
    if v is None:
        return None
    v = v.strip()
    return v or None


class RecruiterUpdateRequest(CamelModel):
    """Body for `PATCH …/applications/{id}/recruiter` — sets the WHOLE recruiter contact (a full
    replace). Both keys are **required** (`Field(...)`) but nullable, so an *omitted* key is a 422
    rather than a silent clear; send `null`/`""` to clear a field. A non-empty email must look like
    one (coarse `_RECRUITER_EMAIL_RE`) → 422; the name is free-form."""

    recruiter_name: str | None = Field(...)
    recruiter_email: str | None = Field(...)

    @field_validator("recruiter_name")
    @classmethod
    def _clean_name(cls, v: str | None) -> str | None:
        return _blank_to_none(v)

    @field_validator("recruiter_email")
    @classmethod
    def _clean_email(cls, v: str | None) -> str | None:
        v = _blank_to_none(v)
        if v is not None and not _RECRUITER_EMAIL_RE.match(v):
            raise ValueError("recruiter_email must be a valid email address")
        return v


class ConflictCode(StrEnum):
    """Machine-distinguishable 409 reason on the apply / CV-mutation paths, so the client branches
    on a code rather than fragile prose. (The needs-sign-off 409 stays `ExportBlocked`, which
    already carries `blockedBulletIds`.)"""

    stale = "stale"  # the CV moved since the client read it — reload and retry
    already_applied = "alreadyApplied"  # this CV is already tracked
    cv_locked = "cvLocked"  # the CV is applied/locked — edit/sign-off/delete refused


class ApplicationConflict(CamelModel):
    """409 body carrying a `ConflictCode` discriminator + a human detail."""

    code: ConflictCode
    detail: str
