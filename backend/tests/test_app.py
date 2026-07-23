"""App smoke tests + the codegen-anchor guard (every model must reach the OpenAPI components)."""

from __future__ import annotations

from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_health() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "contender-backend"}


def test_openapi_includes_every_model() -> None:
    schemas = app.openapi()["components"]["schemas"]
    # If any of these is missing, the frontend type generation would silently lose a type.
    for name in (
        "MasterProfile",
        "JobSpec",
        "TailoredCV",
        "TailoredBullet",
        "EditorReport",
        "FactCheckReport",
        "SlopReport",
        "GatekeeperVerdict",
        "ReviewBundle",
        "ApplyFeedbackRequest",
        "AcceptedThread",
        "AgentReport",
        "AgentFailure",
        "Application",
        "Workspace",
        "Membership",
        "AdminStatus",
        "AdminProviderStatus",
        "ProviderKeyStatus",
        "ProviderModelStatus",
        "SyncModelsResponse",
        "SetProviderKeyRequest",
        "SetTiersRequest",
        # Ingestion (PR-B1) — the route-exposed wire models (internal Extractor I/O is NOT
        # anchored).
        "IngestionRunBundle",
        "IngestionRun",
        "IngestionProposal",
        "ApplyResult",
        "PasteIngestRequest",
        "DecideProposalRequest",
        "BulkDecideRequest",
    ):
        assert name in schemas, f"{name} missing from OpenAPI components"
