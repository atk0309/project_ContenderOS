"""Schema-export surface.

`GET /meta/schema` returns a bundle that references every wire model. Its only job is to force
FastAPI to register all of them as OpenAPI components, so `openapi-typescript` emits the full
type set for the frontend. As real typed routes land in later phases, those will reference these
models directly; the bundle stays as the canonical "all types" anchor for codegen.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.schema import (
    AdminStatus,
    AgentDone,
    AgentFailure,
    AgentProgress,
    AgentReport,
    AgentStarted,
    Application,
    ApplyFeedbackRequest,
    EditorReport,
    FactCheckReport,
    GatekeeperVerdict,
    JobSpec,
    MasterProfile,
    Membership,
    ProviderKeyStatus,
    ProviderModelStatus,
    ReviewBundle,
    ReviewRequest,
    RunDone,
    SlopReport,
    SyncModelsResponse,
    TailoredCV,
    Thread,
    Workspace,
)
from app.schema.common import CamelModel

router = APIRouter(prefix="/meta", tags=["meta"])


class SchemaBundle(CamelModel):
    """Not a runtime payload — a codegen anchor that pins every model into the OpenAPI document."""

    master_profile: MasterProfile
    job_spec: JobSpec
    tailored_cv: TailoredCV
    editor_report: EditorReport
    fact_check_report: FactCheckReport
    slop_report: SlopReport
    gatekeeper_verdict: GatekeeperVerdict
    review_bundle: ReviewBundle
    review_request: ReviewRequest
    apply_feedback_request: ApplyFeedbackRequest
    thread: Thread
    application: Application
    workspace: Workspace
    membership: Membership
    agent_started: AgentStarted
    agent_progress: AgentProgress
    agent_done: AgentDone
    agent_report: AgentReport
    agent_failure: AgentFailure
    run_done: RunDone
    admin_status: AdminStatus
    provider_key_status: ProviderKeyStatus
    provider_model_status: ProviderModelStatus
    sync_models_response: SyncModelsResponse


@router.get("/schema", response_model=SchemaBundle)
def schema_bundle() -> None:  # pragma: no cover - codegen anchor, not called at runtime
    """Never invoked; exists so every model is part of the OpenAPI schema for TS generation."""
    raise NotImplementedError
