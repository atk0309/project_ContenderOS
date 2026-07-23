"""Request bodies for the AI routes. Kept in the schema package so they're part of the single
source of truth and emitted into the OpenAPI document (and thus the generated frontend types)."""

from __future__ import annotations

from app.schema.common import CamelModel


class ParseRequest(CamelModel):
    raw_text: str  # the pasted job posting
