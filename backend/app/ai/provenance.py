"""Server-side provenance derivation + stable-id validation (invariant 2).

The model proposes `origin`/`sourceId` per bullet, but the SERVER is the authority — never the
model, never the client. Two pure passes run after every Tailor call (and before persistence):

* `derive_provenance` enforces the safety-critical line: a bullet is grounded only when its
  `sourceId` is a highlight of **its own item's** source work entry. A bullet pointing nowhere — or
  at a highlight that belongs to a *different* employer (the renderer attributes employer/dates from
  the item's `sourceId`, so that would silently misattribute experience) — is treated as a **net-new
  claim**: its `sourceId` is nulled (we never keep a false provenance pointer) and it is forced to
  `origin=net-new` + `needsSignoff=True`, which blocks export until the candidate signs off. We
  trust the verbatim-vs-reworded label only when the `sourceId` is real *and under the right item*,
  and do NOT text-diff against the master bullet, so an overstatement on a real source is out of
  scope here — that is the Fact-Checker/Editor layer's job (invariant 6).
* `validate_stable_ids` rejects blank or duplicate bullet/item/section ids: structured outputs
  guarantee types, not uniqueness or non-emptiness, and review threads anchor to these ids
  (ADR 0003), so a collision or an unanchored `""` must fail loud (422) before anything is stored.
"""

from __future__ import annotations

from app.schema.common import AnchorKind, Origin
from app.schema.master import MasterProfile
from app.schema.reviews import Thread
from app.schema.tailored import TailoredBullet, TailoredCV, TailoredItem

# The sentinel a review thread uses to anchor to the CV summary line — it has no minted id (the
# renderer marks it `data-line="summary"`; ADR 0003).
SUMMARY_ANCHOR = "summary"


class StableIdError(Exception):
    """Base for tailored-CV stable-id faults (→ 422). Review-thread anchoring (ADR 0003) depends on
    every section/item/bullet id being present and unique."""


class DuplicateStableId(StableIdError):
    """A bullet/item/section id appears more than once in a tailored CV (→ 422)."""

    def __init__(self, kind: str, dup_id: str) -> None:
        self.kind = kind
        self.dup_id = dup_id
        super().__init__(f"duplicate {kind} id {dup_id!r} in tailored CV")


class BlankStableId(StableIdError):
    """A bullet/item/section id is empty or whitespace-only (→ 422)."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        super().__init__(f"blank {kind} id in tailored CV")


def _apply_grounding(allowed: set[str], bullet: TailoredBullet) -> None:
    """The per-bullet grounding rule (invariant 2), given the set of highlight ids legitimately
    available to the bullet's item. Grounded → keep `sourceId`, sign-off only if labelled net-new;
    ungrounded → null the (false) `sourceId`, force net-new + sign-off. The single source of this
    rule, shared by the cv-wide pass and the single-bullet re-derive after a manual edit."""
    if bullet.source_id is None or bullet.source_id not in allowed:
        # Not grounded in a master bullet of THIS item → net-new, must be signed off.
        bullet.source_id = None
        bullet.origin = Origin.net_new
        bullet.needs_signoff = True
    else:
        # Grounded in a real master bullet: only a net-new label still needs sign-off.
        bullet.needs_signoff = bullet.origin is Origin.net_new


def allowed_highlight_ids_for_item(master: MasterProfile, source_id: str) -> set[str]:
    """The highlight ids of the master work entry this item sources from (empty if none). Public so
    the Fact-Checker can validate a thread's `sourceId` against the anchored item's source work."""
    return next(({h.id for h in w.highlights} for w in master.work if w.id == source_id), set())


def derive_provenance(cv: TailoredCV, master: MasterProfile) -> TailoredCV:
    """Re-derive each bullet's provenance from the master (mutates and returns `cv`). The model's
    `origin`/`needsSignoff` are advisory; this is the server's authoritative pass. A bullet is
    grounded only against the highlights of *its own item's* source work entry — a highlight from
    another entry would misattribute employer/dates in the renderer, so it is treated as net-new."""
    highlights_by_work = {work.id: {h.id for h in work.highlights} for work in master.work}
    for section in cv.sections:
        for item in section.items:
            allowed = highlights_by_work.get(item.source_id, set())
            for bullet in item.highlights:
                _apply_grounding(allowed, bullet)
    return cv


def reground_bullet(master: MasterProfile, item: TailoredItem, bullet: TailoredBullet) -> None:
    """Re-derive provenance for a SINGLE bullet after a manual text edit — touches only this bullet,
    so other bullets' sign-off state is preserved (the cv-wide `derive_provenance` would re-flag
    every net-new bullet, clobbering prior sign-offs). A grounded bullet stays grounded regardless
    of text (we never text-diff against the master — that's the Fact-Checker/Editor layer's job,
    invariant 6); a net-new bullet stays gated, so editing a signed-off one re-requires approval."""
    _apply_grounding(allowed_highlight_ids_for_item(master, item.source_id), bullet)


def valid_anchor_ids_by_kind(cv: TailoredCV) -> dict[AnchorKind, set[str]]:
    """The stable-id set a review thread may anchor to, **per `anchorKind`**: bullet → bullet ids,
    item → item ids, section → section ids, summary → the `"summary"` sentinel. Validating the id
    alone is not enough: `validate_stable_ids` only enforces uniqueness WITHIN a kind, so one string
    can be a legitimate bullet id AND item id; a thread must match its kind to the right set or it
    is mis-pinned (a 'bullet' anchor that is really a section id resolves to nothing in the render).
    The server is the authority on anchoring, never the model (ADR 0003 / invariant 7)."""
    bullets: set[str] = set()
    items: set[str] = set()
    sections: set[str] = set()
    for section in cv.sections:
        sections.add(section.section_id)
        for item in section.items:
            items.add(item.item_id)
            bullets.update(bullet.bullet_id for bullet in item.highlights)
    return {
        AnchorKind.bullet: bullets,
        AnchorKind.item: items,
        AnchorKind.section: sections,
        # The summary line renders only when the CV has summary text (`ResumeTemplate` gates the
        # `data-line="summary"` element on it), so a summary anchor on an empty summary would be
        # orphaned — drop it.
        AnchorKind.summary: {SUMMARY_ANCHOR} if cv.summary.strip() else set(),
    }


def ground_thread_anchors[ThreadT: Thread](threads: list[ThreadT], cv: TailoredCV) -> list[ThreadT]:
    """Keep only threads whose `anchorId` is a real id in this CV **of the matching `anchorKind`**
    (or the `"summary"` sentinel). The adjudicators propose anchors, but the server validates them:
    a dropped thread points at a nonexistent or mis-kinded id, not a critique we can pin. Generic
    over the `Thread` subclasses, so the whole review fan-out re-grounds the same way."""
    by_kind = valid_anchor_ids_by_kind(cv)
    return [t for t in threads if t.anchor_id in by_kind.get(t.anchor_kind, set())]


def validate_stable_ids(cv: TailoredCV) -> None:
    """Raise on any reused or blank section/item/bullet id (either breaks anchoring)."""
    seen_sections: set[str] = set()
    seen_items: set[str] = set()
    seen_bullets: set[str] = set()
    for section in cv.sections:
        _reject_blank("section", section.section_id)
        if section.section_id in seen_sections:
            raise DuplicateStableId("section", section.section_id)
        seen_sections.add(section.section_id)
        for item in section.items:
            _reject_blank("item", item.item_id)
            if item.item_id in seen_items:
                raise DuplicateStableId("item", item.item_id)
            seen_items.add(item.item_id)
            for bullet in item.highlights:
                _reject_blank("bullet", bullet.bullet_id)
                if bullet.bullet_id in seen_bullets:
                    raise DuplicateStableId("bullet", bullet.bullet_id)
                seen_bullets.add(bullet.bullet_id)


def _reject_blank(kind: str, stable_id: str) -> None:
    if not stable_id.strip():
        raise BlankStableId(kind)


class StructureViolation(Exception):
    """A Corrector apply broke reword-in-place (→ 422). Since DevPR29 the Corrector returns text
    keyed by bulletId (never structure), so this fires at splice time (`cv_store.apply_corrections`)
    when a revision for an accepted bullet is missing, blank, or oversized — the whole correction is
    rejected rather than partially spliced. Distinct from `StableIdError` (blank/duplicate ids),
    which also maps to 422."""
