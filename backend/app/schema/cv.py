"""Wire models for the Tailor + CV-persistence routes.

These cross the wire (so they live in the schema package, the OpenAPI source of truth), unlike the
agent's internal input shape (`TailorContext`, in `app/ai/agents/tailor.py`). The provenance gate
(invariant 2) is server-side: the client supplies only the job (the master is loaded server-side),
never `origin`/`needsSignoff`.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import Field, StringConstraints

from app.schema.common import MAX_BULLET_LEN, CamelModel, UtcDateTime
from app.schema.job import JobSpec
from app.schema.master import MasterProfile
from app.schema.tailored import TailoredCV


class WorkspaceTailorRequest(CamelModel):
    """Body for `POST /workspaces/{id}/cv` — tailor the workspace's **stored** master to a job. Only
    the job is client-supplied; the master is loaded server-side so provenance is always grounded in
    stored truth, never arbitrary client JSON (invariant 2)."""

    job_spec: JobSpec


class SignoffRequest(CamelModel):
    """Owner approval of net-new bullets — clears their `needsSignoff`, unblocking export.
    `baseVersion` is the CV version the client was viewing: the write is rejected (409) if the CV
    has changed since, so a stale tab can't approve text it never saw (optimistic concurrency)."""

    bullet_ids: list[str]
    base_version: int = Field(ge=1)


class ReviewRequest(CamelModel):
    """Body for `POST /workspaces/{id}/cv/{cvId}/review`. `baseVersion` is the CV version the client
    is viewing: the (billed) review is rejected (409) if the stored CV changed since, so a stale tab
    never pays for a verdict of a row it isn't showing (matches the export/apply guard)."""

    base_version: int = Field(ge=1)


class EditBulletRequest(CamelModel):
    """Body for `POST /workspaces/{id}/cv/{cvId}/edit` — a manual text edit of one tailored bullet.
    The server owns provenance (invariant 2): only the bullet text is client-supplied; `origin` /
    `sourceId` / `needsSignoff` are re-derived server-side. Text is trimmed + bounded, so a blank or
    whitespace-only edit is a 422. `baseVersion` is the CV version the client was editing — a write
    against a stale version is rejected (409) rather than silently clobbering a newer one."""

    bullet_id: str = Field(min_length=1)
    text: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_BULLET_LEN)
    ]
    base_version: int = Field(ge=1)


class RenderBundle(CamelModel):
    """The `{master, cv}` the renderer needs (dates/company resolve off master), plus the stored
    `jobSpec` this CV was tailored to (None for a keyless draft). The client uses `jobSpec` for the
    posting drawer + Gatekeeper present/met derivation — NOT a render/provenance input (invariant 2;
    the renderer ignores it)."""

    master: MasterProfile
    cv: TailoredCV
    # Required + nullable (no default): the read path always sets it (null for a keyless draft), so
    # the key is never absent and a client can't silently drop it.
    job_spec: JobSpec | None


class CreatedCV(CamelModel):
    """Result of persisting a tailored CV: its server-generated id + the derived CV."""

    id: str
    cv: TailoredCV


class CvSummary(CamelModel):
    """A lightweight row for the dashboard CV list — enough to label, badge, and open a CV without
    shipping the whole `{master, cv}` bundle. `needsSignoff` is derived from the CV; `jobTitle` /
    `company` come from the separate `cv_labels` row (None for a keyless draft). The timestamps are
    the stored-row times, not anything inside `cv`."""

    id: str
    version: int
    needs_signoff: bool
    summary: str
    job_title: str | None = None
    company: str | None = None
    created_at: UtcDateTime
    updated_at: UtcDateTime


class ExportBlocked(CamelModel):
    """409 body when export is gated: the bullets still awaiting sign-off (invariant 2)."""

    blocked_bullet_ids: list[str]
