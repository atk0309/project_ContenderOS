"""Server-Sent-Event envelopes for the streaming agent routes — the event *vocabulary*, not a
statement of which route emits what (emission points live with the emitters: ai/agents/review.py,
ai/agents/ingest.py and their routes).

The union covers a run's lifecycle: `AgentStarted` / `AgentProgress` (an optional in-flight note) /
`AgentDone` per agent, `AgentReport` to carry an adjudicator's result the moment it lands, and a
terminal `RunDone` for the whole run.
"""

from __future__ import annotations

from typing import Literal

from app.schema.common import CamelModel
from app.schema.reviews import (
    EditorReport,
    FactCheckReport,
    GatekeeperVerdict,
    SlopReport,
)


class AgentStarted(CamelModel):
    type: Literal["agent_started"] = "agent_started"
    agent_id: str


class AgentProgress(CamelModel):
    type: Literal["agent_progress"] = "agent_progress"
    agent_id: str
    note: str


class AgentDone(CamelModel):
    type: Literal["agent_done"] = "agent_done"
    agent_id: str
    ok: bool
    detail: str | None = None  # error category on failure (refusal / truncation / parse-fail)


class AgentReport(CamelModel):
    """One adjudicator's result, streamed the moment it lands. A concrete envelope (NOT a bare
    union) so codegen emits one stable type: `agentId` identifies which agent, and exactly ONE
    report field is populated (others null). The client merges it into its `ReviewBundle`."""

    type: Literal["agent_report"] = "agent_report"
    agent_id: str
    editor: EditorReport | None = None
    fact_check: FactCheckReport | None = None
    gatekeeper: GatekeeperVerdict | None = None
    slop: SlopReport | None = None


class RunDone(CamelModel):
    type: Literal["run_done"] = "run_done"
    ok: bool
    result_ref: str | None = None  # e.g. persisted ingestion run id (ingest); null for a review
    detail: str | None = None  # failure category when there's no result_ref to load (e.g. a review)


SseEvent = AgentStarted | AgentProgress | AgentDone | AgentReport | RunDone
