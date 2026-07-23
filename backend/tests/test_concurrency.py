"""Apply-vs-edit serialization under the per-CV advisory lock (ADR 0009).

The derived CV "lock" (an application row exists) is only race-safe because `apply` and the CV
mutations (`edit_bullet`/`sign_off`/`delete_cv`) all take `lock_cv` first — otherwise an edit
could read `is_applied == False`, lose the CPU, and then mutate a CV a concurrent apply just
froze. `pg_advisory_xact_lock` is a no-op on SQLite (locks.py), so the offline gate cannot
exercise this; like the master-store lock test, it is `TEST_POSTGRES_URL`-gated — CI provides a
Postgres service, locally it SKIPS (visibly, via pytest `-ra`). This is the owed companion to
`test_put_master_serializes_under_advisory_lock_on_postgres` (ADR 0009 / testing strategy).
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from app.persistence import application_store, cv_store
from app.persistence.cv_store import CVLocked
from app.persistence.locks import lock_cv
from app.persistence.models import Base
from app.schema import TailoredCV
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from tests.factories import sample_job_spec, sample_master_profile, sample_tailored_cv

EDITED = "edited text while the apply transaction holds the lock"


@pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"),
    reason=(
        "apply-vs-edit serialization rides a Postgres advisory lock (no-op on SQLite); "
        "set TEST_POSTGRES_URL to a clean async Postgres DB to run it"
    ),
)
def test_apply_vs_edit_serializes_under_cv_lock_on_postgres() -> None:
    """An edit that starts while an apply's transaction holds `lock_cv` must queue behind it and
    then fail closed with `CVLocked` — never mutate the frozen CV. Deterministic direction: if the
    lock were a no-op, the edit would complete before the apply commits and the final CV would
    carry the edited text, failing the assertions below."""
    url = os.environ["TEST_POSTGRES_URL"]
    workspace_id = f"pgcc-{uuid.uuid4().hex[:8]}"

    async def run() -> None:
        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            maker = async_sessionmaker(engine, expire_on_commit=False)

            async with maker() as seed:
                row = await cv_store.create_cv(
                    seed,
                    workspace_id=workspace_id,
                    master=sample_master_profile(),
                    cv=sample_tailored_cv(with_net_new=False),  # nothing unsigned → apply passes
                    job_spec=sample_job_spec(),
                )
                cv_id, base_version = row.id, row.version

            async with maker() as s1, maker() as s2:
                # s1 takes the per-CV lock (held until its transaction ends), standing in for the
                # window between apply's lock acquisition and its commit.
                await lock_cv(s1, cv_id)
                edit = asyncio.create_task(
                    cv_store.edit_bullet(
                        s2, workspace_id, cv_id, "b1", EDITED, base_version=base_version
                    )
                )
                await asyncio.sleep(0.2)
                assert not edit.done(), "edit must block on the advisory lock, not run concurrently"
                # apply re-takes the (reentrant) lock in s1, inserts the application row, commits —
                # releasing the lock and unblocking the edit, which must now see the frozen CV.
                application = await application_store.apply(
                    s1,
                    workspace_id=workspace_id,
                    cv_id=cv_id,
                    job_title="Integration Manager",
                    company=None,
                    job_url=None,
                    note=None,
                    base_version=base_version,
                )
                assert application.tailored_cv_ref == cv_id
                with pytest.raises(CVLocked):
                    await edit

            async with maker() as s3:
                frozen = await cv_store.get_cv(s3, workspace_id, cv_id)
                cv = TailoredCV.model_validate(frozen.cv)
                texts = [b.text for s in cv.sections for i in s.items for b in i.highlights]
                assert EDITED not in texts, "the refused edit must not have mutated the frozen CV"
                assert frozen.version == base_version, "no version bump from the refused edit"
        finally:
            await engine.dispose()

    asyncio.run(run())


@pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"),
    reason=(
        "apply-vs-edit serialization rides a Postgres advisory lock (no-op on SQLite); "
        "set TEST_POSTGRES_URL to a clean async Postgres DB to run it"
    ),
)
def test_apply_itself_takes_the_cv_lock_on_postgres() -> None:
    """The other half of the contract: `application_store.apply()` must take `lock_cv` ITSELF —
    an apply started while another transaction holds the per-CV lock must queue behind it, not
    proceed. If `apply` lost its `lock_cv` call, it would complete while the lock is held and the
    `not done()` assertion below would fail."""
    url = os.environ["TEST_POSTGRES_URL"]
    workspace_id = f"pgcc-{uuid.uuid4().hex[:8]}"

    async def run() -> None:
        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            maker = async_sessionmaker(engine, expire_on_commit=False)

            async with maker() as seed:
                row = await cv_store.create_cv(
                    seed,
                    workspace_id=workspace_id,
                    master=sample_master_profile(),
                    cv=sample_tailored_cv(with_net_new=False),
                    job_spec=sample_job_spec(),
                )
                cv_id, base_version = row.id, row.version

            async with maker() as holder, maker() as s1:
                await lock_cv(holder, cv_id)  # a competing writer holds the lock
                apply_task = asyncio.create_task(
                    application_store.apply(
                        s1,
                        workspace_id=workspace_id,
                        cv_id=cv_id,
                        job_title="Integration Manager",
                        company=None,
                        job_url=None,
                        note=None,
                        base_version=base_version,
                    )
                )
                await asyncio.sleep(0.2)
                assert not apply_task.done(), "apply must take lock_cv and queue behind the holder"
                await holder.rollback()  # release the lock without changing anything
                application = await apply_task
                assert application.tailored_cv_ref == cv_id
        finally:
            await engine.dispose()

    asyncio.run(run())
