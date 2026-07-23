"""JSON log formatting for the backend.

Why this exists: Railway colours each log line by which *stream* it came from, and uvicorn writes
every level to **stderr** — so routine `INFO` lifecycle lines ("Application startup complete",
"Started server process", ...) render as red "error". Emitting structured JSON lets Railway read
the real level from the payload instead of guessing from the stream.

The single source of truth for the logging dictConfig is `backend/log_config.json` (loaded by
uvicorn via `--log-config`, so even uvicorn's earliest boot lines are formatted). This module only
provides the `JsonFormatter` that file references. JSON-vs-console is the `LOG_FORMAT` knob
(`app.config.settings.log_format_resolved`); local dev defaults to readable `console`.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from app.config import settings

# Plain, human-readable line for local dev (LOG_FORMAT=console).
_CONSOLE = logging.Formatter("%(levelname)-8s %(name)s: %(message)s")


class JsonFormatter(logging.Formatter):
    """Render a `LogRecord` as one-line JSON (`time`/`level`/`logger`/`message`), or as a readable
    plain line when the resolved log format is `console`. `output` forces a mode (used by tests);
    when `None` the mode is read from settings at format time."""

    def __init__(self, output: str | None = None) -> None:
        super().__init__()
        self._output = output

    def _mode(self) -> str:
        return self._output or settings.log_format_resolved

    def format(self, record: logging.LogRecord) -> str:
        if self._mode() == "console":
            return _CONSOLE.format(record)
        payload: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack_info"] = self.formatStack(record.stack_info)
        return json.dumps(payload, ensure_ascii=False)
