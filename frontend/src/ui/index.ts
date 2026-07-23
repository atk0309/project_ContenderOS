// Shared presentational UI primitives for the authed app chrome. One canonical source for the button /
// card / header / field / banner / tag styles the screens used to re-declare inline. Chrome tokens
// only — never import these from src/render/** (the deterministic render path stays self-contained).

export { AgentBadge } from "./AgentBadge";
export { AgentChecklist } from "./AgentChecklist";
export { Banner } from "./Banner";
export { Button, buttonStyle, IconButton } from "./Button";
export { Card, cardStyle } from "./Card";
export { AGENT_IDENTITY, type AgentKey, agentIdentity, DECISION_META } from "./colors";
export { Field, fieldLabel, inputStyle, TextArea, textareaStyle } from "./Field";
export { Gauge } from "./Gauge";
export { PageHeader } from "./PageHeader";
export { Segmented, type SegmentOption } from "./Segmented";
export { type Stage, StageDots, type StageTone } from "./StageDots";
export { Switch } from "./Switch";
export { tagStyle } from "./Tag";
export { VerdictPill } from "./VerdictPill";
