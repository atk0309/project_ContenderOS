"""Apply accepted ingestion proposals to the master — the spine-protection analogue of
provenance.py.

The server, never the model or client, builds the master here: it mints every stable id, validates
required fields and id rules, and merges accepted proposals additively. PR-B1 handles **net-new**
units (build a first-run master from scratch, or append to an existing one); PR-E adds the
in-place enrich/conflict edits. A unit that can't be applied (malformed, unknown field path) is
returned as an `ApplyConflict` so the rest of the accepted set still lands — apply is partial.

`master_hash` is the staleness comparator: `apply` re-hashes the run's stored master snapshot with
the current serializer and refuses (409) if the live master's hash differs (a concurrent edit, or a
master created where the run assumed none). Re-hashing the snapshot — rather than trusting a hash
frozen at create — keeps an additive schema change (a new field defaulting `[]`/None) from falsely
staling a run open across the deploy, since both sides go through the same `master_hash`.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from pydantic import ValidationError

from app.persistence.master_store import MasterIdError, validate_master_ids
from app.schema import MasterProfile
from app.schema.ingest import (
    ApplyConflict,
    IngestionProposal,
    IngestRelationship,
    IngestUnitKind,
)

_SCHEMA_VERSION = "1"

# Wire `fieldPath` → (target, snake_key). The allowlist is the authority: an unknown path is a
# conflict, never a reflective `setattr` on a model-controlled string (invariant 8).
_FIELD_PATHS: dict[str, tuple[str, str]] = {
    "basics.name": ("basics", "name"),
    "basics.label": ("basics", "label"),
    "basics.email": ("basics", "email"),
    "basics.phone": ("basics", "phone"),
    "basics.url": ("basics", "url"),
    "basics.summary": ("basics", "summary"),
    "basics.location.city": ("location", "city"),
    "basics.location.region": ("location", "region"),
    "basics.location.countryCode": ("location", "country_code"),
}

# Owner-facing labels for the first-run identity gate, so a 422 reads "needs a name and an email"
# instead of "basics.name, basics.email". After the relax only `name`/`email` are mandatory, so
# only these two are ever reachable (both single-word, so the alias==field-name casing question is
# moot); the `.get(path, path)` fallback keeps any unexpected loc from `KeyError`-ing into a 500.
# Insertion order is the read order (name before email). Local here on purpose — editing
# `agents/ingest.py` would light the `ai-agent-change` doc-impact rule.
_FIELD_LABELS: dict[str, str] = {
    "basics.name": "a name",
    "basics.email": "an email",
}


def _join_and(items: list[str]) -> str:
    """Grammatical join: "a", "a and b", "a, b and c" (no Oxford comma)."""
    if len(items) <= 1:
        return items[0] if items else ""
    return ", ".join(items[:-1]) + " and " + items[-1]


class IngestApplyError(Exception):
    """An accepted set couldn't be applied in a way the owner must fix (→ 422)."""


class IncompleteIdentity(IngestApplyError):
    """A first-run build is missing required identity fields (→ 422 with the field list)."""


class _InvalidUnit(Exception):
    """One proposal's content is malformed for its kind — recorded as an `ApplyConflict`, the rest
    of the accepted set still applies."""


def master_hash(master: MasterProfile | None) -> str | None:
    """A stable content hash of the master (or None when there is none yet) — the staleness
    token."""
    if master is None:
        return None
    blob = json.dumps(master.model_dump(mode="json", by_alias=True), sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def _mint_id(taken: set[str]) -> str:
    """A fresh charset-safe stable id (uuid hex matches ^[A-Za-z0-9_-]+$), unique within `taken`."""
    while True:
        candidate = uuid.uuid4().hex
        if candidate not in taken:
            taken.add(candidate)
            return candidate


def _norm(value: str) -> str:
    """Whitespace-collapse + casefold — the SAME normalisation `agents.ingest._norm` uses at
    reconcile time, so an enrich highlight suppressed during reconciliation and the apply-time dedup
    here agree on what counts as 'already present'."""
    return " ".join(value.split()).casefold()


def apply_accepted(
    master: MasterProfile | None, proposals: list[IngestionProposal]
) -> tuple[MasterProfile, list[ApplyConflict], dict[str, str]]:
    """Build the next master from the current one (or nothing) plus the accepted proposals.

    Returns `(new_master, conflicts, applied_master_ids)` where `applied_master_ids` maps each
    applied
    proposal id → the master id (or field path) it landed as, for the audit trail. Raises
    `IncompleteIdentity`/`IngestApplyError` (→ 422) when the result isn't a valid master."""
    conflicts: list[ApplyConflict] = []
    applied: dict[str, str] = {}

    m: dict[str, Any]
    if master is not None:
        m = master.model_dump(mode="python", by_alias=False)
    else:
        m = {
            "schema_version": _SCHEMA_VERSION,
            "basics": {"profiles": []},
            "work": [],
            "education": [],
            "skills": [],
            "languages": [],
            "certificates": [],
        }
    basics: dict[str, Any] = m["basics"]
    location: dict[str, Any] = dict(basics.get("location") or {})
    work_ids = {w["id"] for w in m.get("work", [])}
    edu_ids = {e["id"] for e in m.get("education", [])}
    # institution/area/study-type key → id, so a re-imported degree dedups instead of duplicating
    # (education had no apply-time dedup, unlike skills-by-name and certs-by-name/issuer/date).
    edu_by_key: dict[tuple[str, str, str], str] = {
        (
            str(e.get("institution") or "").strip().casefold(),
            str(e.get("area") or "").strip().casefold(),
            str(e.get("study_type") or "").strip().casefold(),
        ): e["id"]
        for e in m.get("education", [])
    }
    skill_names = {str(s["name"]).strip().casefold() for s in m.get("skills", [])}
    lang_names = {str(x.get("language") or "").strip().casefold() for x in m.get("languages", [])}
    cert_keys = {
        (str(c["name"]).strip().casefold(), str(c["issuer"]).strip().casefold(), c["date"])
        for c in (m.get("certificates") or [])
    }
    profile_urls = {
        str(pl.get("url") or "").strip().casefold() for pl in (basics.get("profiles") or [])
    }

    for p in proposals:
        content = p.edited or p.content
        try:
            if p.unit_kind is IngestUnitKind.basics_field:
                # The target field path is SERVER-OWNED (read from p.content, never the editable
                # `edited` copy): an owner edits the value, not which field it writes (invariant 2).
                if p.content.field is None or content.field is None:
                    raise _InvalidUnit("basics-field proposal carries no field")
                field_path = p.content.field.field_path
                target = _FIELD_PATHS.get(field_path)
                if target is None:
                    raise _InvalidUnit(f"unknown basics fieldPath {field_path!r}")
                where, key = target
                target_dict = basics if where == "basics" else location
                # The apply boundary is the authoritative invariant-2 gate: strip and reject a blank
                # value so neither a model "" / " " sentinel NOR an owner edit (which lands in
                # `p.edited`, bypassing the proposal-build strip) can fill a required identity field
                # with whitespace — a `str`-typed MasterProfile field would otherwise accept it and
                # slip past the first-run identity gate.
                value = content.field.value.strip()
                if not value:
                    raise _InvalidUnit(f"{field_path} is blank")
                live = str(target_dict.get(key) or "").strip()
                if p.relationship is IngestRelationship.correction:
                    # Overwrite an already-set field, but only if it still holds the value the
                    # proposal was reconciled against — never clobber a value the owner never saw
                    # (per-field stale-overwrite guard, defense-in-depth atop the run-level snapshot
                    # staleness 409).
                    if live != str(p.current_value or "").strip():
                        raise _InvalidUnit(
                            f"{field_path} changed since import — re-import to correct it"
                        )
                elif live:
                    # net-new is additive: fill an EMPTY field, never overwrite a set one (a changed
                    # value comes through as a `correction`; an equal one was suppressed).
                    raise _InvalidUnit(f"{field_path} is already set — re-import to update it")
                target_dict[key] = value
                applied[p.proposal_id] = field_path
            elif p.unit_kind is IngestUnitKind.work:
                if content.work is None:
                    raise _InvalidUnit("work proposal carries no work entry")
                w = content.work
                wid = _mint_id(work_ids)
                hl_ids: set[str] = set()
                m["work"].append(
                    {
                        "id": wid,
                        "company": w.company,
                        "position": w.position,
                        "start_date": w.start_date,
                        "end_date": w.end_date,
                        "highlights": [{"id": _mint_id(hl_ids), "text": t} for t in w.highlights],
                        "tags": list(w.tags),
                    }
                )
                applied[p.proposal_id] = wid
            elif p.unit_kind is IngestUnitKind.education:
                if content.education is None:
                    raise _InvalidUnit("education proposal carries no education entry")
                e = content.education
                edu_key = (
                    str(e.institution or "").strip().casefold(),
                    str(e.area or "").strip().casefold(),
                    str(e.study_type or "").strip().casefold(),
                )
                if edu_key in edu_by_key:
                    # Already present — idempotent (no duplicate degree on re-import).
                    applied[p.proposal_id] = edu_by_key[edu_key]
                else:
                    eid = _mint_id(edu_ids)
                    edu_by_key[edu_key] = eid
                    m["education"].append(
                        {
                            "id": eid,
                            "institution": e.institution,
                            "area": e.area,
                            "study_type": e.study_type,
                            "start_date": e.start_date,
                            "end_date": e.end_date,
                        }
                    )
                    applied[p.proposal_id] = eid
            elif p.unit_kind is IngestUnitKind.skill:
                if content.skill is None:
                    raise _InvalidUnit("skill proposal carries no skill")
                s = content.skill
                norm = s.name.strip().casefold()
                if norm in skill_names:
                    # Dedup: merge keywords into the existing skill rather than add a duplicate.
                    for existing in m["skills"]:
                        if str(existing["name"]).strip().casefold() == norm:
                            existing["keywords"] = list(
                                dict.fromkeys([*existing.get("keywords", []), *s.keywords])
                            )
                            break
                else:
                    skill_names.add(norm)
                    m["skills"].append(
                        {"name": s.name, "level": s.level, "keywords": list(s.keywords)}
                    )
                applied[p.proposal_id] = s.name
            elif p.unit_kind is IngestUnitKind.language:
                if content.language is None:
                    raise _InvalidUnit("language proposal carries no language")
                lang = content.language
                name = lang.language.strip()
                if not name:
                    raise _InvalidUnit("language name is blank")
                fluency = (lang.fluency or "").strip() or None
                norm = name.casefold()
                if norm in lang_names:
                    # Dedup by name (the skills pattern): idempotent on re-import. Fill a blank
                    # fluency from the new one so a later, more-detailed import enriches it (a SET
                    # fluency is never overwritten — like skills' `level`).
                    for existing in m["languages"]:
                        if str(existing.get("language") or "").strip().casefold() == norm:
                            if not str(existing.get("fluency") or "").strip() and fluency:
                                existing["fluency"] = fluency
                            break
                else:
                    lang_names.add(norm)
                    m["languages"].append({"language": name, "fluency": fluency})
                applied[p.proposal_id] = name
            elif p.unit_kind is IngestUnitKind.certificate:
                if content.certificate is None:
                    raise _InvalidUnit("certificate proposal carries no certificate")
                c = content.certificate
                cert_key = (c.name.strip().casefold(), c.issuer.strip().casefold(), c.date)
                if cert_key not in cert_keys:
                    cert_keys.add(cert_key)
                    m.setdefault("certificates", [])
                    if m["certificates"] is None:
                        m["certificates"] = []
                    m["certificates"].append({"name": c.name, "issuer": c.issuer, "date": c.date})
                applied[p.proposal_id] = c.name
            elif p.unit_kind is IngestUnitKind.profile:
                if content.profile is None:
                    raise _InvalidUnit("profile proposal carries no profile link")
                pl = content.profile
                url_key = pl.url.strip().casefold()
                if not url_key:
                    raise _InvalidUnit("profile link is blank")
                if url_key not in profile_urls:
                    profile_urls.add(url_key)
                    basics.setdefault("profiles", []).append({"network": pl.network, "url": pl.url})
                applied[p.proposal_id] = pl.network
            elif p.unit_kind is IngestUnitKind.highlight:
                # Enrich: append a NEW bullet to an existing work entry, preserving the entry id and
                # every existing highlight id (append-only — ADR 0003 / invariant 7). The target is
                # the server-owned envelope id, never the editable content (invariant 2).
                if content.highlight is None:
                    raise _InvalidUnit("highlight proposal carries no text")
                text = content.highlight.text.strip()
                if not text:
                    raise _InvalidUnit("highlight proposal is blank")
                if p.target_work_id is None:
                    raise _InvalidUnit("enrich proposal has no target work entry")
                entry = next((w for w in m["work"] if w["id"] == p.target_work_id), None)
                if entry is None:
                    raise _InvalidUnit("enrich target work entry no longer exists")
                # Read the IN-PROGRESS entry so two enrich proposals to the same role both land
                # without a duplicate bullet or a colliding id (live-set discipline, like skills).
                if _norm(text) in {_norm(h["text"]) for h in entry["highlights"]}:
                    applied[p.proposal_id] = p.target_work_id  # already present — idempotent no-op
                else:
                    hid = _mint_id({h["id"] for h in entry["highlights"]})
                    entry["highlights"].append({"id": hid, "text": text})
                    applied[p.proposal_id] = f"{p.target_work_id}:{hid}"
            else:
                raise _InvalidUnit(f"unhandled unit kind {p.unit_kind.value}")
        except _InvalidUnit as exc:
            conflicts.append(ApplyConflict(proposal_id=p.proposal_id, reason=str(exc)))

    if location:
        basics["location"] = location

    try:
        new_master = MasterProfile.model_validate(m)
    except ValidationError as exc:
        missing = {".".join(str(x) for x in err["loc"]) for err in exc.errors()}
        # Ordered friendly labels first (name before email), then any unmapped loc raw (defensive).
        labels = [lbl for path, lbl in _FIELD_LABELS.items() if path in missing]
        labels += sorted(p for p in missing if p not in _FIELD_LABELS)
        raise IncompleteIdentity(
            f"Your import needs {_join_and(labels)} to build a profile. "
            "Add it in Edit your CV, then import again."
        ) from exc
    try:
        validate_master_ids(new_master)
    except MasterIdError as exc:  # minted ids shouldn't collide, but never store an invalid master
        raise IngestApplyError(str(exc)) from exc
    return new_master, conflicts, applied
