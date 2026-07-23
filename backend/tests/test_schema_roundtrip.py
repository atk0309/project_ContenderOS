"""Schema is the source of truth: camelCase wire JSON survives a round-trip, and the
provenance/sign-off gate is computed correctly."""

from __future__ import annotations

from datetime import datetime

from app.schema import TailoredCV
from app.schema.cv import CvSummary
from app.schema.ingest import IngestionRun, IngestRunStatus, IngestSourceType

from tests.factories import sample_tailored_cv

# A tz-NAIVE timestamp, exactly what a `DateTime(timezone=True)` column yields when re-read from
# SQLite (the tzinfo is stripped). Pre-fix this serialized without an offset and browsers parsed it
# as local time → wall-clock skew. `UtcDateTime` must normalise it to a UTC offset on the wire.
_NAIVE = datetime(2026, 6, 25, 19, 42, 40, 493696)


def test_roundtrip_preserves_data() -> None:
    cv = sample_tailored_cv()
    wire = cv.model_dump(by_alias=True)
    again = TailoredCV.model_validate(wire)
    assert again == cv


def test_wire_json_is_camel_case() -> None:
    cv = sample_tailored_cv()
    wire = cv.model_dump(by_alias=True)
    assert "jobSpecRef" in wire
    bullet = wire["sections"][0]["items"][0]["highlights"][0]
    assert set(bullet) == {"bulletId", "sourceId", "text", "origin", "needsSignoff"}


def test_net_new_bullet_blocks_export() -> None:
    assert sample_tailored_cv(with_net_new=True).needs_signoff() is True


def test_clean_cv_is_exportable() -> None:
    assert sample_tailored_cv(with_net_new=False).needs_signoff() is False


# Pydantic v2 spells an aware UTC datetime with a trailing `Z`; what matters is that the wire value
# carries a timezone at all, so a browser can't misread it as local time. Assert tz-awareness rather
# than the exact spelling (robust to `Z` vs `+00:00`).
def _wire_is_tz_aware(value: str) -> bool:
    return datetime.fromisoformat(value).tzinfo is not None


def test_ingestion_run_timestamps_serialize_tz_aware() -> None:
    run = IngestionRun(
        id="r1",
        source_type=IngestSourceType.pasted,
        status=IngestRunStatus.review,
        created_at=_NAIVE,
        updated_at=_NAIVE,
    )
    wire = run.model_dump(mode="json", by_alias=True)
    assert _wire_is_tz_aware(wire["createdAt"])
    assert _wire_is_tz_aware(wire["updatedAt"])


def test_cv_summary_timestamps_serialize_tz_aware() -> None:
    summary = CvSummary(
        id="c1",
        version=1,
        needs_signoff=False,
        summary="s",
        created_at=_NAIVE,
        updated_at=_NAIVE,
    )
    wire = summary.model_dump(mode="json", by_alias=True)
    assert _wire_is_tz_aware(wire["createdAt"])
    assert _wire_is_tz_aware(wire["updatedAt"])
