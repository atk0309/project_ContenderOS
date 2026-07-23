"""Liveness probe."""

from __future__ import annotations

from fastapi import APIRouter

from app.schema.common import CamelModel

router = APIRouter(tags=["meta"])


class Health(CamelModel):
    status: str
    service: str


@router.get("/health")
def health() -> Health:
    return Health(status="ok", service="contender-backend")
