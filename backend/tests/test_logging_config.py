"""JsonFormatter: structured-JSON vs console output (see app/logging_config.py).

Guards the observability contract — Railway needs a `level` in the JSON payload (it colours by
stream otherwise), and tracebacks must survive into the log line."""

from __future__ import annotations

import json
import logging
import sys

import pytest
from app.logging_config import JsonFormatter


def _record(
    msg: str, args: tuple[object, ...] | None = None, *, level: int = logging.INFO
) -> logging.LogRecord:
    return logging.LogRecord("contender.test", level, __file__, 1, msg, args, None)


def test_json_output_has_core_fields() -> None:
    payload = json.loads(JsonFormatter(output="json").format(_record("hi %s", ("there",))))
    assert payload["level"] == "INFO"
    assert payload["message"] == "hi there"
    assert payload["logger"] == "contender.test"
    assert "time" in payload


def test_json_includes_traceback() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        rec = logging.LogRecord(
            "contender.test", logging.ERROR, __file__, 1, "failed", None, sys.exc_info()
        )
    payload = json.loads(JsonFormatter(output="json").format(rec))
    assert "ValueError: boom" in payload["exc_info"]


def test_console_output_is_plain_text() -> None:
    line = JsonFormatter(output="console").format(_record("watch out", level=logging.WARNING))
    assert line == "WARNING  contender.test: watch out"
    with pytest.raises(json.JSONDecodeError):
        json.loads(line)
