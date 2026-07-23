# ADR 0003: Stable-id anchoring for review threads

Status: accepted  
Date: 2026-06-18

## Context

The source harness anchored review threads to array-index `jsonPath` strings like
`sections[0].items[1].highlights[2]`. The Corrector rewrites and reorders bullets/sections, so a
thread anchored to `highlights[2]` silently points at the wrong bullet (or out of bounds) after a
correction — corrupting the review loop and the diff view.

## Decision

Anchor to **stable ids**, never positions.

- Every `TailoredBullet` carries a `bulletId`; sections/items carry `sectionId`/`itemId`. The Tailor
  mints them; the **Corrector preserves them on reword** and mints fresh ids only for net-new bullets.
- Review `Thread`s carry `anchorId` (+ `anchorKind ∈ {bullet,item,section,summary}`). All report
  schemas (Editor, Fact-Check, Slop, Gatekeeper threads) use `anchorId`.
- Threads whose `anchorId` no longer exists are marked `orphaned`, never mis-rendered.
- `ResumeTemplate`/editor tag DOM nodes `data-bullet-id` so the annotation layer tracks the bullet
  through edits and reorders.

## Consequences

- The diff view is a clean `bulletId`-keyed join (added / removed / reworded), not a positional diff.
- The slop heuristics output also carries `anchorId`.
- Strengthens invariant 7 rather than weakening it.

## Links

`docs/invariants.md` (7), `backend/app/schema/tailored.py`, `backend/app/schema/reviews.py`.
