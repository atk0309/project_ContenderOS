"""Agent definitions + the run entrypoint (registry). Each agent is a pinned config exposed as a
typed function: provider + tier (model resolved at call time) + output schema + system prompt +
input builder."""
