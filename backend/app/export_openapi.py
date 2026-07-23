"""Dump the OpenAPI document to a file the frontend turns into TypeScript types.

Pydantic is the single source of truth (ADR 0004). This runs WITHOUT a server or a database —
it builds the `FastAPI` object and serialises its schema. The committed artifact lives at
`frontend/openapi.json`; the frontend's `gen:types` consumes it. A `schema-contract` doc-impact
rule + a no-diff gate step keep Python and TS in lockstep.

Usage:  python -m app.export_openapi [output_path]   (default: ../frontend/openapi.json)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.main import app

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "frontend" / "openapi.json"


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    schema = app.openapi()
    out.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
