"""Auth wire models: the session user (returned by /auth/me), the magic-link request, and a generic
ok ack. camelCase on the wire (CamelModel), so the frontend's generated types match."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from app.schema.common import CamelModel


class AuthUser(CamelModel):
    email: str
    # Deploy-skew shim: the frontend and backend deploy as separate services, and the OLD client
    # reads `role` off /auth/me — a role-less response would lock it out during the skew window.
    # Post-pivot every allowlisted account is the owner, so the field is a constant. The `Literal`
    # regenerates as a TS literal type, so any stale `=== "reviewer"` comparison is a compile
    # error. Removed next release (the named follow-up).
    role: Literal["owner"] = Field(
        "owner", deprecated=True, description="Vestigial — always 'owner'; removed next release"
    )


class MagicRequest(CamelModel):
    email: str


class OkResponse(CamelModel):
    ok: bool = True
