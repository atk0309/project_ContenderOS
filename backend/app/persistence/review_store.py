"""Review store: persist + read the LATEST review run per CV, scoped by workspace (invariant 8).

Reviews used to be transient (ADR 0010/0011); the owner reversed that, so the latest run + the
owner's per-finding decisions now survive navigation (ADR 0013). This is a **latest-run-only
snapshot** — one row per CV (`cv_reviews.cv_id` PK) — deliberately DECOUPLED from history (no run
history, no durable Diff). Routes stay thin (AGENTS §8); the data logic lives here. Every query
filters on BOTH `workspace_id` and `cv_id`, so a review guessed across tenants simply isn't found.

Transaction ownership: `save_review` and `set_decisions` are standalone and **commit**.
`delete_review` does NOT commit — it rides the caller's transaction, because both lifecycle callers
(`cv_store`, `application_store`) delete the review inside a larger single-commit unit, and the
settle-time tombstone commits explicitly right after. `save_review` is deliberately **lockless**
(the ADR's orphan-row acceptance depends on it): a concurrent delete can leave an unreachable orphan
row, which is accepted (uuid CV ids never recycle).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import delete, insert, literal, select, update
from sqlalchemy.exc import IntegrityError

from app.persistence.models import StoredCV, StoredCvReview
from app.schema import ReviewBundle
from app.schema.reviews import ThreadDecision

if TYPE_CHECKING:
    from sqlalchemy.engine import CursorResult
    from sqlalchemy.ext.asyncio import AsyncSession


class ReviewNotFound(Exception):
    """No stored review for this CV in this workspace (→ 404 at the decisions route). Covers the
    cross-tenant guess too — every query filters on `(workspace_id, cv_id)`."""

    def __init__(self, cv_id: str) -> None:
        self.cv_id = cv_id
        super().__init__(f"no stored review for CV {cv_id!r} in this workspace")


class ReviewSuperseded(Exception):
    """A settle-time save arrived for an OLDER `cv_version` than the stored row — a slow run from a
    stale tab finishing after a fresh re-run on a newer CV version. The stored newer run wins; the
    late run is NOT persisted (the route surfaces `detail="save_failed"` so that client keeps its
    decisions local, and must NOT tombstone the newer row). Equal versions stay last-write-wins
    (invariant 7 / ADR 0013)."""

    def __init__(self, cv_id: str) -> None:
        self.cv_id = cv_id
        super().__init__(f"stored review for CV {cv_id!r} is for a newer CV version")


class ReviewVersionConflict(Exception):
    """A decisions PUT targets a `cvVersion` that no longer matches the stored review (→ 409): the
    review was re-run since (which resets decisions), so the client's snapshot is stale. The
    same-version cross-tab residual is accepted last-write-wins (invariant 7 / ADR 0013)."""

    def __init__(self, cv_id: str) -> None:
        self.cv_id = cv_id
        super().__init__(f"stored review for CV {cv_id!r} is a different version; reload and retry")


async def _row(session: AsyncSession, workspace_id: str, cv_id: str) -> StoredCvReview | None:
    stmt = select(StoredCvReview).where(
        StoredCvReview.cv_id == cv_id, StoredCvReview.workspace_id == workspace_id
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def save_review(
    session: AsyncSession,
    *,
    workspace_id: str,
    cv_id: str,
    cv_version: int,
    bundle: ReviewBundle,
    reviewed_text: dict[str, str],
) -> None:
    """Upsert the latest review run for a CV (atomic conditional UPDATE, insert on miss; NO
    dialect ON CONFLICT). Resets `decisions` to `{}` — a fresh run invalidates the prior
    per-finding verdicts. **Commits.**

    Deliberately **lockless** (unlike `master_store`): no advisory lock, so a concurrent
    settle-vs-delete can leave an orphan row — accepted (ADR 0013; the read paths self-heal it).
    The never-regress guard is an **atomic conditional UPDATE** (`WHERE cv_version <= incoming`,
    checked by rowcount), NOT a read-then-write — a v2 row committed between a SELECT and this
    write can therefore never be clobbered back to v1 (`ReviewSuperseded`). Equal versions stay
    last-write-wins (invariant 7).

    Both the UPDATE and the guarded INSERT also carry the SAME **live-CV guard**
    (`EXISTS(StoredCV WHERE version <= incoming)`): a run that reviewed version N cannot persist
    once the live CV has advanced past N. The INSERT arm always had it; hoisting it onto the UPDATE
    arm too means never-regress is enforced against the LIVE CV version, not just the review row's
    own `cv_version`. Today this is belt-and-suspenders with the apply-time delete (a settle after
    apply finds no row → takes the guarded-INSERT arm anyway); it exists so a run that raced a
    concurrent edit during its own fan-out is refused (strictly safer than persisting an
    already-superseded run), and so a future change that KEEPS the review row across apply
    (resolve-in-place) cannot be clobbered by a stale post-apply settle at the same version."""
    dumped = bundle.model_dump(mode="json", by_alias=True)
    # Only persist while the live CV hasn't advanced past the reviewed version. Mirrors the guarded
    # INSERT's `StoredCV.version <= cv_version`, hoisted onto the UPDATE arm too so an existing
    # review row can never be regressed against a CV that already moved on.
    cv_not_advanced = (
        select(StoredCV.id)
        .where(
            StoredCV.id == cv_id,
            StoredCV.workspace_id == workspace_id,
            StoredCV.version <= cv_version,
        )
        .exists()
    )
    cond_update = (
        update(StoredCvReview)
        .where(
            StoredCvReview.cv_id == cv_id,
            StoredCvReview.workspace_id == workspace_id,
            StoredCvReview.cv_version <= cv_version,
            cv_not_advanced,
        )
        .values(
            cv_version=cv_version,
            bundle=dumped,
            reviewed_text=dict(reviewed_text),
            decisions={},
        )
    )
    result = cast("CursorResult[Any]", await session.execute(cond_update))
    if result.rowcount:
        await session.commit()
        return
    # 0 rows: either no row exists yet (→ guarded insert) or the row holds a NEWER version.
    if await _row(session, workspace_id, cv_id) is not None:
        await session.rollback()  # hygiene; the guarded update wrote nothing
        raise ReviewSuperseded(cv_id)
    # Guarded INSERT … FROM SELECT against the CV row itself: inserts ONLY while the CV still
    # exists AND hasn't advanced past the reviewed version — atomically, in the statement's WHERE.
    # Same live-CV guard as the UPDATE arm above: a slow/cross-tab run settling AFTER an apply
    # bumped the CV version selects 0 rows instead of resurrecting notes the apply consumed — apply
    # now RESOLVES the review in place (ADR 0014) rather than deleting it, so this guard (not a
    # delete) blocks resurrection. It also structurally prevents the settle-vs-delete orphan at
    # insert time (CV gone → nothing to select). The read-side orphan guard stays defense-in-depth.
    # Timestamps are supplied explicitly (`from_select` bypasses the Python-side column defaults);
    # `now` mirrors models._now.
    now = datetime.now(UTC)
    guarded_insert = insert(StoredCvReview).from_select(
        [
            "cv_id",
            "workspace_id",
            "cv_version",
            "bundle",
            "reviewed_text",
            "decisions",
            "created_at",
            "updated_at",
        ],
        select(
            literal(cv_id),
            literal(workspace_id),
            literal(cv_version),
            literal(dumped, StoredCvReview.bundle.type),
            literal(dict(reviewed_text), StoredCvReview.reviewed_text.type),
            literal({}, StoredCvReview.decisions.type),
            literal(now, StoredCvReview.created_at.type),
            literal(now, StoredCvReview.updated_at.type),
        )
        .select_from(StoredCV)
        .where(
            StoredCV.id == cv_id,
            StoredCV.workspace_id == workspace_id,
            StoredCV.version <= cv_version,
        ),
    )
    try:
        result = cast("CursorResult[Any]", await session.execute(guarded_insert))
        if not result.rowcount:
            # The CV was deleted or advanced past the reviewed version (apply/edit) mid-run.
            await session.rollback()
            raise ReviewSuperseded(cv_id)
        await session.commit()
    except IntegrityError:
        # A concurrent first-save won the insert (the `cv_id` PK collided). Roll back so the
        # session is usable, then retry the SAME atomic conditional update against the racer's row
        # (last-write-wins for `<=`; superseded if the racer persisted a newer version).
        await session.rollback()
        result = cast("CursorResult[Any]", await session.execute(cond_update))
        if result.rowcount:
            await session.commit()
            return
        raise ReviewSuperseded(cv_id) from None


async def get_review(session: AsyncSession, workspace_id: str, cv_id: str) -> StoredCvReview | None:
    """The stored latest review row for a CV, or None. Workspace-scoped (invariant 8). The route
    validates `bundle` into `ReviewBundle` (and self-heals a schema-skewed blob to 200-null)."""
    return await _row(session, workspace_id, cv_id)


async def set_decisions(
    session: AsyncSession,
    workspace_id: str,
    cv_id: str,
    decisions: dict[str, ThreadDecision],
    cv_version: int,
) -> None:
    """Reassign the WHOLE decisions blob (last-write-wins, invariant 7) for a stored review.
    **Commits.** `ReviewNotFound` (→ 404) if no row; `ReviewVersionConflict` (→ 409) if the stored
    row's `cv_version` differs from the client's `cv_version` (the review was re-run since). The
    version check lives in the UPDATE's `WHERE` clause (atomic, checked by rowcount) — a re-run
    committing a different version between a SELECT and this write can never receive stale
    decisions. The same-version cross-tab residual is accepted LWW (ADR 0013)."""
    stmt = (
        update(StoredCvReview)
        .where(
            StoredCvReview.cv_id == cv_id,
            StoredCvReview.workspace_id == workspace_id,
            StoredCvReview.cv_version == cv_version,
        )
        .values(decisions={key: decision.value for key, decision in decisions.items()})
    )
    result = cast("CursorResult[Any]", await session.execute(stmt))
    if not result.rowcount:
        # Advisory disambiguation for the status code; the write itself already refused atomically.
        await session.rollback()
        if await _row(session, workspace_id, cv_id) is None:
            raise ReviewNotFound(cv_id)
        raise ReviewVersionConflict(cv_id)
    await session.commit()


async def delete_review(
    session: AsyncSession,
    workspace_id: str,
    cv_id: str,
    *,
    only_if_updated_at: datetime | None = None,
) -> None:
    """Delete the stored review for a CV — a **0-row-safe bulk `delete().where(...)`** (never
    get-then-raise: lifecycle callers and the settle-time tombstone routinely hit no-row).

    Does **not** commit: it rides the caller's transaction. Lifecycle callers (`cv_store.delete_cv`
    / `apply_corrections`, `application_store.delete_application`) delete the review inside their
    own single-commit unit; the settle-time tombstone commits explicitly after calling this.

    `only_if_updated_at` supports the conditional tombstone: pass the pre-save row's `updated_at`
    to delete ONLY the run that was there before a failed save — a concurrent tab may have saved a
    NEWER run mid-failure, and that must never be deleted."""
    stmt = delete(StoredCvReview).where(
        StoredCvReview.cv_id == cv_id, StoredCvReview.workspace_id == workspace_id
    )
    if only_if_updated_at is not None:
        stmt = stmt.where(StoredCvReview.updated_at == only_if_updated_at)
    await session.execute(stmt)


async def resolve_threads(
    session: AsyncSession,
    workspace_id: str,
    cv_id: str,
    bullet_ids: set[str],
) -> None:
    """Mark applied bullets **resolved** on the stored review, in place (ADR 0014). Apply KEEPS the
    review row (it no longer deletes it) so the candidate's OTHER, un-applied notes survive; the
    applied bullets flip to a resolved "✓" chip on the client.

    Appends `bullet_ids` to the bundle's `resolvedAnchorIds` while **preserving** `cv_version` (the
    verdict stays visible, stale-marked (ADR 0016); the stored review version is unchanged, so a
    decisions PUT still matches it) and **preserving** `decisions` (unlike `save_review`, which
    resets them). Does **not** commit — it rides the caller's transaction, exactly like
    `delete_review`: `apply_corrections` resolves the review AND bumps the CV version in one guarded
    unit. **0-row-safe**: a no-op when no `cv_reviews` row exists, so apply runs fine against a
    `save_failed` in-memory-only review (never `None.bundle`). The `bundle` JSON column is NOT
    `MutableDict`, so the blob is **reassigned** — an in-place `.append` wouldn't flush."""
    if not bullet_ids:
        return
    row = await _row(session, workspace_id, cv_id)
    if row is None:
        return  # 0-row-safe: a save_failed / in-memory-only review has no row to resolve.
    bundle = dict(row.bundle)
    raw = bundle.get("resolvedAnchorIds")
    resolved: list[str] = list(raw) if isinstance(raw, list) else []
    resolved.extend(bid for bid in bullet_ids if bid not in resolved)
    bundle["resolvedAnchorIds"] = resolved
    row.bundle = bundle  # reassign — a plain JSON column doesn't track deep mutation.
