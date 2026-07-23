"""Tailor agent, exercised with fakes (offline — no key, no DB, no network).

The runner and model resolver are injectable and overridden here. The point of these tests is that
the server-side provenance gate runs on the Tailor's output regardless of what the model claims.
Route-level coverage lives in test_cv.py (`POST /workspaces/{id}/cv` — the one tailoring route)."""

from __future__ import annotations

import asyncio
from typing import TypeVar

from app.ai.agents.registry import ModelResolver
from app.ai.agents.tailor import TailorContext, run_tailor, tailor
from app.ai.providers.base import ProviderRunner
from app.schema import TailoredBullet, TailoredCV, TailoredItem, TailoredSection
from app.schema.common import Origin, Provider, SectionType, Tier
from pydantic import BaseModel

from tests.factories import sample_job_spec, sample_master_profile

TOut = TypeVar("TOut", bound=BaseModel)


def _model_cv() -> TailoredCV:
    """What the (faked) model returns: a grounded bullet, a net-new bullet, and a bullet that claims
    a `sourceId` no master Highlight has — the server must reclassify the last two."""
    return TailoredCV(
        job_spec_ref="job-1",
        master_version="1",
        version=1,
        summary="Integration manager.",
        sections=[
            TailoredSection(
                section_id="s1",
                type=SectionType.work,
                items=[
                    TailoredItem(
                        item_id="i1",
                        source_id="exampleco-integration-mgr",
                        highlights=[
                            TailoredBullet(
                                bullet_id="b1",
                                source_id="exampleco-1",
                                text="Led migration of 40 EDI partners.",
                                origin=Origin.verbatim,
                            ),
                            TailoredBullet(
                                bullet_id="b2",
                                source_id="bogus-id",  # no such master Highlight
                                text="Single-handedly tripled revenue.",
                                origin=Origin.verbatim,  # model lies; server overrides
                            ),
                        ],
                    )
                ],
            )
        ],
    )


def _fake_runner() -> ProviderRunner:
    async def runner(
        *,
        provider: Provider,
        model: str,
        system: str,
        user: str,
        output: type[TOut],
        **_: object,
    ) -> TOut:
        return output.model_validate(_model_cv().model_dump(by_alias=True))

    return runner


def _fixed_resolver() -> ModelResolver:
    async def resolve(provider: Provider, tier: Tier) -> str:
        return "fake-model-id"

    return resolve


def test_tailor_builds_input_with_master_and_job() -> None:
    text = tailor.build_input(TailorContext(master=sample_master_profile(), job=sample_job_spec()))
    assert "MASTER PROFILE" in text
    assert "JOB SPEC" in text
    assert "Senior Integration Engineer" in text  # from the job spec


def test_run_tailor_applies_provenance_gate() -> None:
    cv = asyncio.run(
        run_tailor(
            sample_master_profile(),
            sample_job_spec(),
            runner=_fake_runner(),
            resolve=_fixed_resolver(),
        )
    )
    bullets = {b.bullet_id: b for s in cv.sections for it in s.items for b in it.highlights}
    # Grounded bullet survives as-is.
    assert bullets["b1"].origin is Origin.verbatim
    assert bullets["b1"].needs_signoff is False
    # The bogus-source bullet is reclassified net-new, its false sourceId nulled, sign-off required.
    assert bullets["b2"].origin is Origin.net_new
    assert bullets["b2"].source_id is None
    assert bullets["b2"].needs_signoff is True
