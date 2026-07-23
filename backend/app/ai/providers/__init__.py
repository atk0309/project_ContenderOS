"""Thin per-provider wrappers. Agents/routes never import an SDK directly — they go through a
ProviderRunner (see base.py). Authoring → Anthropic; adjudication → OpenAI (P3)."""
