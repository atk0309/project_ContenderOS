import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError, type Schemas } from "@/lib/api/client";
import type { AgentStatus, Checklist, SseEvent } from "@/lib/sse";
import { sampleRenderInput } from "@/render/fixtures";
import { toResumeDocument } from "@/render/model";
import { ResumeTemplate } from "@/render/ResumeTemplate";
import { VerdictPill } from "@/ui";
import { EditorPanel } from "./EditorPanel";
import { GatekeeperEmpty, GatekeeperView } from "./GatekeeperView";
import {
  acceptedThreads,
  agentRosterStatus,
  agentState,
  anchorLabel,
  applyFeedbackRequest,
  bulletMarkers,
  canApplyCorrections,
  checklistFromBundle,
  collectThreads,
  collectUnsignedBulletIds,
  type Decisions,
  decide,
  deleteCvRequest,
  deleteReviewRequest,
  diffChangedBullets,
  diffChangedBulletsFromSnapshot,
  dirtyBulletIds,
  editableBulletIds,
  editableItems,
  editRequest,
  emptyBundle,
  exportUrl,
  failureLabel,
  foldSameBulletDecisions,
  gatekeeperEmptyReason,
  gatekeeperFixes,
  gatekeeperKeywords,
  gatekeeperMustHaves,
  isAcceptableThread,
  isInlineThread,
  isSafeHttpUrl,
  isSupportedFactCheck,
  listCvsRequest,
  newApplicationError,
  orphanedThreads,
  overlayDrafts,
  parseRequest,
  type ReviewThread,
  readRequest,
  reduceReviewBundle,
  reviewAgentLabel,
  reviewedTextSnapshot,
  reviewLatestRequest,
  reviewStreamRequest,
  SOURCE_AGENT_ID,
  STALE_REVIEW_PHRASE,
  sameBulletApply,
  saveDecisionsRequest,
  signoffRequest,
  staleReviewBulletIds,
  tailorRequest,
  threadKey,
  threadsForAnchor,
  withPostingUrl,
  wordDiff,
} from "./logic";
import { ReviewNote } from "./ReviewNote";
import { ReviewPanel } from "./ReviewPanel";
import { ThreadCard } from "./ThreadCard";
import { ThreadList } from "./ThreadList";
import { TopbarVerdict } from "./TopbarVerdict";
import { VerdictCard } from "./VerdictCard";

const bundle: Schemas["RenderBundle"] = { ...sampleRenderInput, jobSpec: null };

const body = (init?: RequestInit): Record<string, unknown> => {
  expect(typeof init?.body).toBe("string");
  return JSON.parse(init?.body as string);
};

const persistedText = (bulletId: string): string => {
  const found = bundle.cv.sections
    .flatMap((s) => s.items.flatMap((it) => it.highlights))
    .find((b) => b.bulletId === bulletId);
  if (!found) throw new Error(`no bullet ${bulletId}`);
  return found.text;
};

describe("selectors", () => {
  it("collects only the net-new bullet awaiting sign-off", () => {
    expect(collectUnsignedBulletIds(bundle.cv)).toEqual(["b-acme-netnew"]);
  });

  it("lists editable work bullets grouped by item, skipping skills/education", () => {
    const groups = editableItems(bundle.cv);
    expect(groups.map((g) => g.itemId)).toEqual(["item-acme", "item-globex"]);
    expect(groups.map((g) => g.bullets.map((b) => b.bulletId))).toEqual([
      ["b-acme-edi", "b-acme-uptime", "b-acme-netnew"],
      ["b-globex-api"],
    ]);
    // The empty skills section and the highlight-less education item contribute nothing.
    expect(groups).toHaveLength(2);
  });
});

describe("editableItems reverse-chronological ordering (D1b)", () => {
  const w = (id: string, startDate: string, endDate?: string): Schemas["WorkEntry"] => ({
    id,
    company: id,
    position: id,
    startDate,
    endDate,
    highlights: [],
    tags: [],
  });
  const workById = new Map<string, Schemas["WorkEntry"]>([
    ["w-old", w("w-old", "2016", "2019")],
    ["w-now", w("w-now", "2022")], // ongoing
    ["w-mid", w("w-mid", "2019", "2022")],
  ]);
  const datesOf = (sourceId: string) => {
    const e = workById.get(sourceId);
    return e ? { startDate: e.startDate, endDate: e.endDate } : null;
  };
  const item = (sourceId: string): Schemas["TailoredItem"] => ({
    itemId: `i-${sourceId}`,
    sourceId,
    position: null,
    company: null,
    highlights: [
      {
        bulletId: `b-${sourceId}`,
        sourceId: null,
        origin: "net-new",
        needsSignoff: true,
        text: "x",
      },
    ],
  });
  const cvOf = (sections: Schemas["TailoredSection"][]): Schemas["TailoredCV"] => ({
    jobSpecRef: "j",
    masterVersion: "1",
    version: 1,
    parentVersion: null,
    summary: "",
    sections,
  });

  it("sorts a work section reverse-chronologically when dates are supplied", () => {
    const cv = cvOf([
      { sectionId: "s-work", type: "work", items: [item("w-old"), item("w-now"), item("w-mid")] },
    ]);
    expect(editableItems(cv, datesOf).map((g) => g.itemId)).toEqual([
      "i-w-now",
      "i-w-mid",
      "i-w-old",
    ]);
  });

  it("keeps document order when no dates are supplied (order-agnostic callers)", () => {
    const cv = cvOf([
      { sectionId: "s-work", type: "work", items: [item("w-old"), item("w-now"), item("w-mid")] },
    ]);
    expect(editableItems(cv).map((g) => g.itemId)).toEqual(["i-w-old", "i-w-now", "i-w-mid"]);
  });

  it("sorts WITHIN each section and preserves cv.sections order (projects before work)", () => {
    // The renderer keeps sections as ordered blocks; a flat sort would wrongly force work above
    // projects. Per-section sorting mirrors the renderer: projects stay first (authored), work sorts.
    const cv = cvOf([
      { sectionId: "s-proj", type: "projects", items: [item("p-1"), item("p-2")] }, // unresolved → authored
      { sectionId: "s-work", type: "work", items: [item("w-old"), item("w-now")] }, // resolved → sorted
    ]);
    expect(editableItems(cv, datesOf).map((g) => g.itemId)).toEqual([
      "i-p-1",
      "i-p-2",
      "i-w-now",
      "i-w-old",
    ]);
  });

  it("never sorts a projects section, even when its item sourceIds resolve in workById", () => {
    // The renderer sorts ONLY work sections; Projects keep authored order unconditionally. So a
    // projects section whose items happen to resolve to dated work entries must NOT reorder.
    const cv = cvOf([
      { sectionId: "s-proj", type: "projects", items: [item("w-old"), item("w-now")] }, // resolvable!
    ]);
    expect(editableItems(cv, datesOf).map((g) => g.itemId)).toEqual(["i-w-old", "i-w-now"]);
  });
});

describe("draft dirtiness + overlay", () => {
  it("treats a changed draft as dirty and an equal draft as clean", () => {
    expect(dirtyBulletIds(bundle, {})).toEqual([]);
    expect(dirtyBulletIds(bundle, { "b-acme-edi": "different" })).toEqual(["b-acme-edi"]);
    // A draft identical to the persisted text is not a change.
    expect(dirtyBulletIds(bundle, { "b-acme-edi": persistedText("b-acme-edi") })).toEqual([]);
  });

  it("overlays draft text by bulletId, leaving other bullets and the master untouched", () => {
    const overlaid = overlayDrafts(bundle, { "b-acme-edi": "Overlaid draft text." });
    const all = overlaid.cv.sections.flatMap((s) => s.items.flatMap((it) => it.highlights));
    expect(all.find((b) => b.bulletId === "b-acme-edi")?.text).toBe("Overlaid draft text.");
    expect(all.find((b) => b.bulletId === "b-acme-uptime")?.text).toBe(
      persistedText("b-acme-uptime"),
    );
    expect(overlaid.master).toBe(bundle.master);
  });

  it("flows the overlay through the real ResumeTemplate (preview == what edits show)", () => {
    const overlaid = overlayDrafts(bundle, { "b-acme-edi": "Overlaid draft text." });
    const html = renderToStaticMarkup(<ResumeTemplate doc={toResumeDocument(overlaid)} />);
    expect(html).toContain("Overlaid draft text.");
    expect(html).toContain('data-bullet-id="b-acme-edi"');
  });

  it("freezes the focused bullet at its focus text — caret-safe + preserves a lingering draft (DevPR14)", () => {
    // Frozen at focus = whatever was displayed (here a lingering draft after a failed save). The overlay
    // renders the FROZEN text for that bullet so React never reconciles the focused contentEditable, and
    // crucially it is NOT reverted to the persisted text (the data-loss-on-refocus bug).
    const frozen = { bulletId: "b-acme-edi", text: "Lingering unsaved draft." };
    const textOf = (rb: typeof bundle, id: string) =>
      rb.cv.sections
        .flatMap((s) => s.items.flatMap((it) => it.highlights))
        .find((b) => b.bulletId === id)?.text;
    expect(textOf(overlayDrafts(bundle, {}, frozen), "b-acme-edi")).toBe(
      "Lingering unsaved draft.",
    );
    // The frozen text is held constant even as keystroke drafts for the SAME bullet arrive (they drive
    // the mirror/checks until blur, never the focused line itself).
    expect(
      textOf(overlayDrafts(bundle, { "b-acme-edi": "newer keystrokes" }, frozen), "b-acme-edi"),
    ).toBe("Lingering unsaved draft.");
  });
});

describe("request builders", () => {
  it("builds the parse + tailor calls", () => {
    const parse = parseRequest("a job posting");
    expect(parse.path).toBe("/ai/parse");
    expect(parse.init?.method).toBe("POST");
    expect(body(parse.init)).toEqual({ rawText: "a job posting" });

    const jobSpec: Schemas["JobSpec"] = {
      title: "Engineer",
      company: "Acme",
      seniority: "senior",
      tone: "corporate",
      rawText: "a job posting",
      atsKeywords: [],
      mustHaves: [],
      niceToHaves: [],
      redFlags: [],
    };
    // The master is loaded server-side now — only the job crosses the wire.
    const tailor = tailorRequest(jobSpec);
    expect(tailor.path).toBe("/workspaces/default/cv");
    expect(body(tailor.init)).toEqual({ jobSpec });
  });

  it("builds the read / edit / signoff calls scoped to the default workspace", () => {
    expect(readRequest("cv1").path).toBe("/workspaces/default/cv/cv1");
    expect(readRequest("cv1").init).toBeUndefined();

    const edit = editRequest("cv1", "b-acme-edi", "new text", 3);
    expect(edit.path).toBe("/workspaces/default/cv/cv1/edit");
    expect(body(edit.init)).toEqual({ bulletId: "b-acme-edi", text: "new text", baseVersion: 3 });

    const signoff = signoffRequest("cv1", ["b-acme-netnew"], 3);
    expect(signoff.path).toBe("/workspaces/default/cv/cv1/signoff");
    expect(body(signoff.init)).toEqual({ bulletIds: ["b-acme-netnew"], baseVersion: 3 });
  });

  it("builds the streaming review call with an SSE Accept header + JSON content-type", () => {
    const review = reviewStreamRequest("cv1", 3);
    expect(review.path).toBe("/workspaces/default/cv/cv1/review");
    expect(review.init?.method).toBe("POST");
    const headers = review.init?.headers as Record<string, string>;
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(body(review.init)).toEqual({ baseVersion: 3 });
  });

  it("builds the dashboard list call (GET, no body)", () => {
    const list = listCvsRequest();
    expect(list.path).toBe("/workspaces/default/cv");
    expect(list.init).toBeUndefined();
  });

  it("builds the delete call (DELETE on the cv path)", () => {
    const del = deleteCvRequest("cv1");
    expect(del.path).toBe("/workspaces/default/cv/cv1");
    expect(del.init?.method).toBe("DELETE");
  });

  it("builds the clear-review call (DELETE on the review path)", () => {
    const del = deleteReviewRequest("cv1");
    expect(del.path).toBe("/workspaces/default/cv/cv1/review");
    expect(del.init?.method).toBe("DELETE");
  });

  it("builds gated export urls per format", () => {
    expect(exportUrl("cv1", "pdf")).toBe("/api/render/pdf?cvId=cv1");
    expect(exportUrl("cv1", "docx")).toBe("/api/render/docx?cvId=cv1");
    expect(exportUrl("cv1", "text")).toBe("/api/render/text?cvId=cv1");
  });
});

describe("VerdictCard", () => {
  const verdict = (
    over: Partial<Schemas["GatekeeperVerdict"]> = {},
  ): Schemas["GatekeeperVerdict"] => ({
    decision: "borderline",
    atsMatchScore: 64,
    missingKeywords: ["AS2"],
    unmetMustHaves: ["REST APIs"],
    recruiterNotes: "Solid EDI; thin on REST.",
    threads: [],
    ...over,
  });

  it("renders a clickable button carrying the decision, score, and recruiter note", () => {
    const html = renderToStaticMarkup(<VerdictCard verdict={verdict()} onOpen={() => {}} />);
    // The rail card is a button that opens the full recruiter read; the verdict is in its accessible name.
    expect(html).toContain("<button");
    expect(html).toContain('data-testid="verdict-card"');
    expect(html).toContain("Gatekeeper verdict Borderline ATS 64/100");
    expect(html).toContain("Borderline");
    expect(html).toContain("ATS 64/100");
    expect(html).toContain("Solid EDI; thin on REST.");
    // Advisory framing is always shown — the verdict never blocks export (invariant 2).
    expect(html).toContain("never blocks export");
    // The keyword / must-have chips are NOT duplicated here — they live in GatekeeperView.
    expect(html).not.toContain("REST APIs");
  });

  it("clamps an over-range score the server would have clamped too (defence in depth)", () => {
    const html = renderToStaticMarkup(
      <VerdictCard verdict={verdict({ atsMatchScore: 250 })} onOpen={() => {}} />,
    );
    expect(html).toContain("ATS 100/100");
  });
});

describe("agentRosterStatus (rail roster slot)", () => {
  it("a failed/interrupted agent reads as text, never a number", () => {
    expect(agentRosterStatus("editor", "failed", 3, 0, false)).toEqual({ kind: "failed" });
    expect(agentRosterStatus("gatekeeper", "running", 0, 0, false)).toEqual({
      kind: "interrupted",
    });
    expect(agentRosterStatus("spotter", "pending", 0, 0, false)).toEqual({ kind: "interrupted" });
  });

  it("a done agent aggregates panel + inline into one count", () => {
    expect(agentRosterStatus("factCheck", "done", 2, 3, false)).toEqual({ kind: "count", n: 5 });
  });

  it("a done agent with no findings shows nothing — except the editor's overall, which is a note", () => {
    expect(agentRosterStatus("editor", "done", 0, 0, true)).toEqual({ kind: "note" });
    expect(agentRosterStatus("editor", "done", 0, 0, false)).toEqual({ kind: "none" });
    // `hasOverall` only applies to the editor — a 0-count gatekeeper is still `none`.
    expect(agentRosterStatus("gatekeeper", "done", 0, 0, true)).toEqual({ kind: "none" });
  });

  it("an absent (job-dependent, didn't apply) agent shows no slot", () => {
    expect(agentRosterStatus("gatekeeper", "absent", 0, 0, false)).toEqual({ kind: "none" });
  });
});

describe("EditorPanel navigator (DevPR16)", () => {
  it("renders each editable bullet as a nav button + a read-only summary card", () => {
    const html = renderToStaticMarkup(
      <EditorPanel
        cv={bundle.cv}
        drafts={{}}
        applyingFeedback={false}
        workById={new Map()}
        inlineThreads={[]}
        staleIds={new Set()}
        decisions={{}}
        onDecide={() => {}}
        acceptedCount={0}
        onSelectBullet={() => {}}
      />,
    );
    // Each editable work/projects bullet is a real <button> navigator, named by its bullet text.
    expect(html.split("ws-bullet-nav").length - 1).toBe(4);
    expect(html).toContain("<button");
    expect(html).toContain("Led migration of 40 EDI partners");
    // The purpose is exposed to assistive tech (a visually-hidden suffix on the button).
    expect(html).toContain("jump to this line on the CV");
    // The read-only Summary card renders the tailored summary (no edit affordance).
    expect(html).toContain("Senior integration engineer who ships reliable partner pipelines");
  });
});

describe("bulletMarkers (DevPR17 in-margin markers)", () => {
  const editableIds = new Set(["b1", "b2"]);
  const t = (
    over: Partial<ReviewThread> & Pick<ReviewThread, "source" | "anchorId">,
  ): ReviewThread =>
    ({
      key: `${over.source}:bullet:${over.anchorId}:${over.key ?? "0"}`,
      anchorKind: "bullet",
      comment: "note",
      severity: "minor",
      ...over,
    }) as ReviewThread;

  it("groups by bullet, picks the highest-severity source, counts, and flags actionable", () => {
    const markers = bulletMarkers(
      [
        t({ source: "editor", anchorId: "b1", severity: "info" }),
        t({ source: "factCheck", anchorId: "b1", severity: "major", key: "1" }),
        t({ source: "spotter", anchorId: "b2", severity: "minor" }),
      ],
      {},
      new Set(),
      editableIds,
    );
    expect(markers).toHaveLength(2);
    expect(markers.find((m) => m.bulletId === "b1")).toMatchObject({
      source: "factCheck",
      count: 2,
      actionableCount: 2,
      verifiedCount: 0,
      actionable: true,
      stale: false,
    });
  });

  it("counts actionable-vs-verified: 2 fixes + 1 supported fact-check on one bullet", () => {
    const m = bulletMarkers(
      [
        t({ source: "editor", anchorId: "b1" }),
        t({ source: "spotter", anchorId: "b1", key: "1" }),
        t({ source: "factCheck", anchorId: "b1", verdict: "supported", key: "2" }),
      ],
      {},
      new Set(),
      editableIds,
    )[0];
    // The badge counts only what a fix addresses; the verified positive is tallied separately.
    expect(m).toMatchObject({ count: 3, actionableCount: 2, verifiedCount: 1, actionable: true });
  });

  it("verified-only bullet: actionableCount 0 (badge suppressed) but a verified positive present", () => {
    const m = bulletMarkers(
      [t({ source: "factCheck", anchorId: "b1", verdict: "supported" })],
      {},
      new Set(),
      editableIds,
    )[0];
    expect(m).toMatchObject({ actionableCount: 0, verifiedCount: 1, actionable: false });
  });

  it("ignores non-editable bullets and dismissed (rejected) threads", () => {
    const threads = [
      t({ source: "editor", anchorId: "b1" }),
      t({ source: "editor", anchorId: "elsewhere" }), // not editable → no marker
    ];
    expect(
      bulletMarkers(threads, { "editor:bullet:b1:0": "rejected" }, new Set(), editableIds),
    ).toHaveLength(0);
  });

  it("marks a stale bullet + a supported-fact-check bullet as non-actionable", () => {
    expect(
      bulletMarkers([t({ source: "editor", anchorId: "b1" })], {}, new Set(["b1"]), editableIds)[0],
    ).toMatchObject({ stale: true, actionable: false });
    expect(
      bulletMarkers(
        [t({ source: "factCheck", anchorId: "b2", verdict: "supported" })],
        {},
        new Set(),
        editableIds,
      )[0],
    ).toMatchObject({ actionable: false });
  });

  it("keeps a resolved (applied) bullet's marker, non-actionable, resolved wins over stale (ADR 0014)", () => {
    // Applied bullet: resolved=true AND stale=true (its text changed) AND a leftover accept decision —
    // the marker must survive (unlike a rejected one) and be non-actionable; render precedence is
    // resolved > stale.
    const m = bulletMarkers(
      [t({ source: "editor", anchorId: "b1", resolved: true })],
      { "editor:bullet:b1:0": "accepted" },
      new Set(["b1"]),
      editableIds,
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      resolved: true,
      stale: true,
      actionable: false,
      actionableCount: 0,
    });
  });
});

describe("ReviewNote (DevPR17 in-place card)", () => {
  const editableIds = new Set(["b1"]);
  const note = (extra: Partial<Parameters<typeof ReviewNote>[0]> = {}) =>
    renderToStaticMarkup(
      <ReviewNote
        bulletId="b1"
        bulletExcerpt="Led EDI…"
        threads={[
          {
            key: "editor:bullet:b1:0",
            source: "editor",
            anchorKind: "bullet",
            anchorId: "b1",
            comment: "Tighten this line.",
            severity: "minor",
            suggestedRevision: "Tighter line.",
          },
        ]}
        cv={bundle.cv}
        needsSignoff={false}
        editableIds={editableIds}
        staleIds={new Set()}
        applying={false}
        dirtyCount={0}
        busy={false}
        hasLiveDiff={false}
        top={100}
        onAcceptFix={() => {}}
        onSignOff={() => {}}
        onDismiss={() => {}}
        onViewDiff={() => {}}
        onClose={() => {}}
        {...extra}
      />,
    );

  it("shows Accept & fix but NO Sign-off on a grounded bullet", () => {
    const html = note();
    expect(html).toContain("Accept &amp; fix");
    expect(html).not.toContain("Sign off to export");
  });

  it("renders Sign off to export only when the bullet needs sign-off", () => {
    expect(note({ needsSignoff: true })).toContain("Sign off to export");
  });

  it("a supported fact-check is advisory — no Accept & fix", () => {
    const html = note({
      threads: [
        {
          key: "factCheck:bullet:b1:0",
          source: "factCheck",
          anchorKind: "bullet",
          anchorId: "b1",
          comment: "Verified.",
          severity: "info",
          verdict: "supported",
        },
      ],
    });
    expect(html).not.toContain("Accept &amp; fix");
  });
});

// --- Gatekeeper subview selectors (B3) -------------------------------------------------------

describe("gatekeeperMustHaves", () => {
  const jobSpec = (over: Partial<Schemas["JobSpec"]> = {}): Schemas["JobSpec"] => ({
    title: "Senior Engineer",
    company: "Acme",
    seniority: "senior",
    tone: "corporate",
    rawText: "",
    postingUrl: null,
    mustHaves: ["Event-driven at scale", "EDI integration", "Team leadership"],
    niceToHaves: [],
    atsKeywords: [],
    redFlags: [],
    ...over,
  });
  const verdict = (over: Partial<Schemas["GatekeeperVerdict"]>): Schemas["GatekeeperVerdict"] => ({
    decision: "borderline",
    atsMatchScore: 60,
    missingKeywords: [],
    unmetMustHaves: [],
    recruiterNotes: "",
    threads: [],
    ...over,
  });

  it("tags each JobSpec must-have met/unmet by the verdict's unmet list", () => {
    const out = gatekeeperMustHaves(jobSpec(), verdict({ unmetMustHaves: ["EDI integration"] }));
    expect(out).toEqual([
      { label: "Event-driven at scale", met: true },
      { label: "EDI integration", met: false },
      { label: "Team leadership", met: true },
    ]);
  });

  it("matches normalized (case + collapsed whitespace), so a phrasing wobble still marks it unmet", () => {
    const out = gatekeeperMustHaves(
      jobSpec(),
      verdict({ unmetMustHaves: ["  edi   INTEGRATION "] }),
    );
    expect(out.find((m) => m.label === "EDI integration")?.met).toBe(false);
    expect(out.filter((m) => !m.met)).toHaveLength(1); // no duplicate row from the rephrasing
  });

  it("appends an unmet must-have the JobSpec list doesn't contain (never silently dropped)", () => {
    const out = gatekeeperMustHaves(jobSpec(), verdict({ unmetMustHaves: ["Kubernetes in prod"] }));
    expect(out).toContainEqual({ label: "Kubernetes in prod", met: false });
    expect(out.filter((m) => m.met).map((m) => m.label)).toEqual([
      "Event-driven at scale",
      "EDI integration",
      "Team leadership",
    ]);
  });

  it("falls back to unmet-only when there is no JobSpec (guard)", () => {
    expect(gatekeeperMustHaves(null, verdict({ unmetMustHaves: ["A", "B"] }))).toEqual([
      { label: "A", met: false },
      { label: "B", met: false },
    ]);
  });

  it("dedupes a repeated must-have (normalized) so the rendered list has no duplicate row/key", () => {
    const out = gatekeeperMustHaves(
      jobSpec({ mustHaves: ["EDI integration", "edi  integration", "Team leadership"] }),
      verdict({}),
    );
    expect(out).toEqual([
      { label: "EDI integration", met: true },
      { label: "Team leadership", met: true },
    ]);
  });
});

describe("gatekeeperKeywords", () => {
  const jobSpec = (atsKeywords: string[]): Schemas["JobSpec"] => ({
    title: "T",
    company: null,
    seniority: "senior",
    tone: "corporate",
    rawText: "",
    postingUrl: null,
    mustHaves: [],
    niceToHaves: [],
    atsKeywords,
    redFlags: [],
  });
  const verdict = (missingKeywords: string[]): Schemas["GatekeeperVerdict"] => ({
    decision: "pass",
    atsMatchScore: 80,
    missingKeywords,
    unmetMustHaves: [],
    recruiterNotes: "",
    threads: [],
  });

  it("present = atsKeywords NOT flagged missing (normalized); missing = the verdict's list", () => {
    const out = gatekeeperKeywords(
      jobSpec(["Kafka", "GraphQL", "Terraform"]),
      verdict(["graphql"]), // case-insensitive flag
    );
    expect(out.present).toEqual(["Kafka", "Terraform"]);
    expect(out.missing).toEqual(["graphql"]);
  });

  it("treats no JobSpec as no confirmed-present keywords (only the missing list shows)", () => {
    const out = gatekeeperKeywords(null, verdict(["AS2"]));
    expect(out.present).toEqual([]);
    expect(out.missing).toEqual(["AS2"]);
  });

  it("dedupes present + missing (normalized) so chips have no duplicate keys", () => {
    const out = gatekeeperKeywords(
      jobSpec(["Kafka", "kafka", "Terraform"]),
      verdict(["AS2", "as2"]),
    );
    expect(out.present).toEqual(["Kafka", "Terraform"]);
    expect(out.missing).toEqual(["AS2"]);
  });
});

describe("gatekeeperEmptyReason", () => {
  const base = {
    hasPreview: true,
    hasJobSpec: true,
    gateFailed: false,
    reviewing: false,
    versionDrifted: false,
    reviewFailed: false,
  };

  it("reports no-cv / no-job before any review signal", () => {
    expect(gatekeeperEmptyReason({ ...base, hasPreview: false, reviewing: true })).toBe("no-cv");
    expect(gatekeeperEmptyReason({ ...base, hasJobSpec: false, gateFailed: true })).toBe("no-job");
  });

  it("surfaces a failed Gatekeeper agent BEFORE 'running' (its verdict won't arrive)", () => {
    // The key invariant-5 precedence: a gatekeeper failure mid-stream is 'failed', not masked as 'running'.
    expect(gatekeeperEmptyReason({ ...base, gateFailed: true, reviewing: true })).toBe("failed");
  });

  it("is 'running' while streaming with no gatekeeper failure yet", () => {
    expect(gatekeeperEmptyReason({ ...base, reviewing: true })).toBe("running");
  });

  it("is 'drifted' after a post-review edit, and 'failed' on a settled run-level failure", () => {
    expect(gatekeeperEmptyReason({ ...base, versionDrifted: true })).toBe("drifted");
    // A run-level failure for this CV reads 'failed', NOT 'no-review' (a review WAS attempted).
    expect(gatekeeperEmptyReason({ ...base, reviewFailed: true })).toBe("failed");
  });

  it("falls back to 'no-review' only when a job CV was genuinely never reviewed", () => {
    expect(gatekeeperEmptyReason(base)).toBe("no-review");
  });
});

describe("wordDiff", () => {
  it("marks deleted words on the before stream and added words on the after stream", () => {
    const { before, after } = wordDiff("Led the team of five", "Led a team of eight engineers");
    const text = (s: typeof before, type: string) =>
      s
        .filter((w) => w.type === type)
        .map((w) => w.t)
        .join("")
        .trim();
    expect(text(before, "del")).toContain("the"); // "the" → "a"
    expect(text(after, "add")).toContain("a");
    expect(text(after, "add")).toContain("engineers"); // net-new tail word
    // Unchanged words appear (as `same`) in BOTH streams, preserving the readable sentence.
    expect(before.map((w) => w.t).join("")).toBe("Led the team of five");
    expect(after.map((w) => w.t).join("")).toBe("Led a team of eight engineers");
  });

  it("is empty-diff stable when nothing changed (all same)", () => {
    const { before, after } = wordDiff("same text", "same text");
    expect(before.every((w) => w.type === "same")).toBe(true);
    expect(after.every((w) => w.type === "same")).toBe(true);
  });
});

describe("diffChangedBullets", () => {
  const withBullet = (bulletId: string, text: string): Schemas["TailoredCV"] => ({
    ...bundle.cv,
    sections: bundle.cv.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => ({
        ...it,
        highlights: it.highlights.map((b) => (b.bulletId === bulletId ? { ...b, text } : b)),
      })),
    })),
  });

  it("returns only the bullets whose text changed, matched by stable bulletId, with context", () => {
    const after = withBullet("b-acme-edi", "Rewrote the EDI migration line with a sharper metric.");
    const changed = diffChangedBullets(bundle.cv, after);
    expect(changed.map((c) => c.bulletId)).toEqual(["b-acme-edi"]);
    expect(changed[0]?.beforeText).toBe(persistedText("b-acme-edi"));
    expect(changed[0]?.afterText).toBe("Rewrote the EDI migration line with a sharper metric.");
    expect((changed[0]?.context.length ?? 0) > 0).toBe(true); // role · company (or section)
  });

  it("returns nothing when no bullet text changed", () => {
    expect(diffChangedBullets(bundle.cv, bundle.cv)).toEqual([]);
  });
});

describe("diffChangedBulletsFromSnapshot (durable derived diff, ADR 0015)", () => {
  const edit = (
    cv: Schemas["TailoredCV"],
    bulletId: string,
    text: string,
  ): Schemas["TailoredCV"] => ({
    ...cv,
    sections: cv.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => ({
        ...it,
        highlights: it.highlights.map((b) => (b.bulletId === bulletId ? { ...b, text } : b)),
      })),
    })),
  });

  it("returns EVERY bullet changed since the baseline (accumulates), not just the last", () => {
    const baseline = reviewedTextSnapshot(bundle.cv); // review-start text
    let after = edit(bundle.cv, "b-acme-edi", "Rewrote the EDI line.");
    after = edit(after, "b-acme-uptime", "Raised uptime further.");
    const changed = diffChangedBulletsFromSnapshot(baseline, after);
    expect(changed.map((c) => c.bulletId).sort()).toEqual(["b-acme-edi", "b-acme-uptime"]);
    expect(changed.find((c) => c.bulletId === "b-acme-edi")?.beforeText).toBe(
      persistedText("b-acme-edi"),
    );
  });

  it("skips a bullet absent from the baseline (net-new since the review)", () => {
    // Only one bullet was known at review-start; the rest of the CV has no baseline entry → ignored.
    const baseline = { "b-acme-edi": "the text at review time (now changed)" };
    const changed = diffChangedBulletsFromSnapshot(baseline, bundle.cv);
    expect(changed.map((c) => c.bulletId)).toEqual(["b-acme-edi"]);
  });

  it("returns nothing when the CV still matches its own baseline", () => {
    expect(diffChangedBulletsFromSnapshot(reviewedTextSnapshot(bundle.cv), bundle.cv)).toEqual([]);
  });
});

// --- Review surface (read-only; PR-2b) -------------------------------------------------------

const gk: Schemas["GatekeeperVerdict"] = {
  decision: "pass",
  atsMatchScore: 80,
  missingKeywords: [],
  unmetMustHaves: [],
  recruiterNotes: "ok",
  threads: [],
};
const slopRep: Schemas["SlopReport"] = { threads: [] };
const fcRep: Schemas["FactCheckReport"] = { threads: [] };

const started = (agentId: string): SseEvent => ({ agentId, type: "agent_started" });
const progress = (agentId: string): SseEvent => ({
  agentId,
  note: "working",
  type: "agent_progress",
});
const done = (agentId: string, ok: boolean, detail?: string): SseEvent => ({
  agentId,
  ok,
  detail,
  type: "agent_done",
});
const runDone = (ok: boolean): SseEvent => ({ ok, type: "run_done" });
const report = (over: Partial<Schemas["AgentReport"]> & { agentId: string }): SseEvent => ({
  type: "agent_report",
  ...over,
});

describe("reduceReviewBundle", () => {
  it("merges each agent_report by its POPULATED field, not by agentId", () => {
    let b = emptyBundle(3);
    b = reduceReviewBundle(b, report({ agentId: "gatekeeper", gatekeeper: gk }));
    b = reduceReviewBundle(b, report({ agentId: "spotter", slop: slopRep })); // agentId ≠ field
    b = reduceReviewBundle(b, report({ agentId: "fact-checker", factCheck: fcRep }));
    expect(b.gatekeeper).toEqual(gk);
    expect(b.slop).toEqual(slopRep);
    expect(b.factCheck).toEqual(fcRep);
    expect(b.editor).toBeUndefined();
    expect(b.cvVersion).toBe(3);
  });

  it("coalesces — a later report's null fields never clobber a prior report", () => {
    let b = reduceReviewBundle(emptyBundle(3), report({ agentId: "gatekeeper", gatekeeper: gk }));
    b = reduceReviewBundle(b, report({ agentId: "spotter", slop: slopRep }));
    expect(b.gatekeeper).toEqual(gk); // survives the slop report (whose gatekeeper field is null)
  });

  it("reconstructs failures from failed agent_done, deduped by agentId (latest detail wins)", () => {
    let b = reduceReviewBundle(emptyBundle(3), done("editor", false, "RateLimitError"));
    b = reduceReviewBundle(b, done("editor", false, "AuthenticationError"));
    expect(b.failures).toEqual([{ agentId: "editor", detail: "AuthenticationError" }]);
  });

  it("leaves the bundle unchanged for started / progress / ok-done / run_done", () => {
    const b0 = emptyBundle(3);
    expect(reduceReviewBundle(b0, started("editor"))).toBe(b0);
    expect(reduceReviewBundle(b0, progress("editor"))).toBe(b0);
    expect(reduceReviewBundle(b0, done("editor", true))).toBe(b0);
    expect(reduceReviewBundle(b0, runDone(true))).toBe(b0);
  });
});

describe("agentState", () => {
  const cl = (status: Record<string, AgentStatus>): Checklist => ({
    order: Object.keys(status),
    status,
  });

  it("is pending before start while the stream is live, absent only once settled", () => {
    expect(agentState(cl({}), [], "gatekeeper", false)).toBe("pending");
    expect(agentState(cl({}), [], "gatekeeper", true)).toBe("absent");
  });

  it("reflects the live checklist status", () => {
    expect(agentState(cl({ editor: "running" }), [], "editor", false)).toBe("running");
    expect(agentState(cl({ editor: "done" }), [], "editor", true)).toBe("done");
  });

  it("is failed when a failure exists, regardless of settle/checklist", () => {
    expect(agentState(cl({}), [{ agentId: "editor", detail: "x" }], "editor", false)).toBe(
      "failed",
    );
  });
});

describe("failureLabel + reviewAgentLabel", () => {
  it("maps the real agent exception class names, the stream sentinel, and a generic fallback", () => {
    // The backend serializes type(exc).__name__ — providers/base.py raises AgentRefusal/etc.
    expect(failureLabel("AgentRefusal")).toBe("the model declined to answer");
    expect(failureLabel("AgentParseError")).toBe("couldn't read the model's reply");
    expect(failureLabel("RateLimitError")).toBe("rate-limited — try again shortly");
    expect(failureLabel("BadRequestError")).toBe("the provider rejected the request"); // live-observed
    expect(failureLabel("stream_ended_without_terminal")).toBe("the review stream ended early");
    expect(failureLabel("SomeBrandNewError")).toBe("an unexpected error");
  });

  it("labels review agents and falls back for an unknown id", () => {
    expect(reviewAgentLabel("fact-checker")).toBe("Fact-check");
    expect(reviewAgentLabel("spotter")).toBe("Voice review");
    expect(reviewAgentLabel("mystery")).toBe("Reviewing…");
  });
});

describe("collectThreads / threadKey / routing", () => {
  const bundleWith = (over: Partial<Schemas["ReviewBundle"]>): Schemas["ReviewBundle"] => ({
    cvVersion: 3,
    failures: [],
    resolvedAnchorIds: [],
    ...over,
  });
  const editorT: Schemas["Thread"] = {
    anchorId: "b-acme-edi",
    anchorKind: "bullet",
    comment: "tighten",
    severity: "minor",
  };
  const gateT: Schemas["Thread"] = {
    anchorId: "item-acme",
    anchorKind: "item",
    comment: "weak",
    severity: "info",
  };
  const factT: Schemas["FactCheckThread"] = {
    anchorId: "b-acme-uptime",
    anchorKind: "bullet",
    claim: "99.9% uptime",
    comment: "verify",
    severity: "major",
    sourceId: "acme-uptime",
    verdict: "supported",
  };
  const slopT: Schemas["SlopThread"] = {
    anchorId: "b-acme-edi",
    anchorKind: "bullet",
    comment: "cliché",
    flag: "cliche",
    severity: "minor",
  };
  const full = bundleWith({
    editor: { overall: "Good overall.", threads: [editorT] },
    gatekeeper: { ...gk, threads: [gateT] },
    factCheck: { threads: [factT] },
    slop: { threads: [slopT] },
  });

  it("flattens all four sources, tagging source + per-source extras, with unique keys", () => {
    const threads = collectThreads(full);
    expect(threads).toHaveLength(4);
    expect(threads.map((t) => t.source).sort()).toEqual([
      "editor",
      "factCheck",
      "gatekeeper",
      "spotter",
    ]);
    const fc = threads.find((t) => t.source === "factCheck");
    expect(fc?.claim).toBe("99.9% uptime");
    expect(fc?.verdict).toBe("supported");
    expect(fc?.sourceId).toBe("acme-uptime");
    expect(threads.find((t) => t.source === "spotter")?.flag).toBe("cliche");
    expect(new Set(threads.map(threadKey)).size).toBe(4);
  });

  it("tags a thread resolved iff its bullet is in bundle.resolvedAnchorIds (ADR 0014)", () => {
    // resolvedAnchorIds is server-controlled; collectThreads reads it and flags each thread on an
    // applied bullet. A fresh run (empty) leaves everything un-resolved → chips clear on re-run.
    const applied = bundleWith({
      resolvedAnchorIds: ["b-acme-edi"],
      editor: { overall: "", threads: [editorT] },
      factCheck: { threads: [factT] }, // a DIFFERENT bullet → not resolved
    });
    const threads = collectThreads(applied);
    expect(threads.find((t) => t.anchorId === "b-acme-edi")?.resolved).toBe(true);
    expect(threads.find((t) => t.anchorId === "b-acme-uptime")?.resolved).toBe(false);
    // A fresh (empty resolvedAnchorIds) bundle resolves nothing.
    expect(collectThreads(full).every((t) => !t.resolved)).toBe(true);
  });

  it("keeps a thread's key stable when a sibling bullet's threads are dropped", () => {
    const two = bundleWith({
      editor: {
        overall: "",
        threads: [
          { anchorId: "A", anchorKind: "bullet", comment: "a", severity: "info" },
          { anchorId: "B", anchorKind: "bullet", comment: "b", severity: "info" },
        ],
      },
    });
    const one = bundleWith({
      editor: {
        overall: "",
        threads: [{ anchorId: "B", anchorKind: "bullet", comment: "b", severity: "info" }],
      },
    });
    const keyB2 = collectThreads(two).find((t) => t.anchorId === "B")?.key;
    const keyB1 = collectThreads(one).find((t) => t.anchorId === "B")?.key;
    expect(keyB1).toBe(keyB2);
  });

  it("distinguishes the same id used as a bullet vs an item (anchorKind in the key)", () => {
    const b = bundleWith({
      editor: {
        overall: "",
        threads: [
          { anchorId: "x", anchorKind: "bullet", comment: "a", severity: "info" },
          { anchorId: "x", anchorKind: "item", comment: "b", severity: "info" },
        ],
      },
    });
    expect(new Set(collectThreads(b).map((t) => t.key)).size).toBe(2);
  });

  it("routes a thread inline iff it anchors an editable bullet; else panel", () => {
    const ids = editableBulletIds(bundle.cv);
    const threads = collectThreads(full);
    const inline = threads.find((t) => t.source === "editor"); // b-acme-edi (editable bullet)
    const panel = threads.find((t) => t.source === "gatekeeper"); // item-acme (item)
    expect(inline && isInlineThread(inline, ids)).toBe(true);
    expect(panel && isInlineThread(panel, ids)).toBe(false);
  });

  it("threadsForAnchor returns only that anchor's threads", () => {
    const forEdi = threadsForAnchor(collectThreads(full), "bullet", "b-acme-edi");
    expect(forEdi.map((t) => t.source).sort()).toEqual(["editor", "spotter"]);
  });
});

describe("orphanedThreads + anchorLabel", () => {
  const mk = (anchorKind: ReviewThread["anchorKind"], anchorId: string): ReviewThread => ({
    key: `k-${anchorKind}-${anchorId}`,
    source: "editor",
    anchorKind,
    anchorId,
    comment: "",
    severity: "info",
  });

  it("flags only threads whose anchor no longer resolves in the CV", () => {
    const list = [
      mk("bullet", "b-acme-edi"),
      mk("item", "item-acme"),
      mk("summary", "summary"),
      mk("bullet", "ghost"),
      mk("item", "ghost-item"),
    ];
    expect(
      orphanedThreads(list, bundle.cv)
        .map((t) => t.anchorId)
        .sort(),
    ).toEqual(["ghost", "ghost-item"]);
  });

  it("labels each anchor kind for the panel", () => {
    expect(anchorLabel(mk("summary", "summary"), bundle.cv)).toBe("Summary");
    expect(anchorLabel(mk("section", "sec-experience"), bundle.cv)).toBe("Work experience");
    expect(anchorLabel(mk("item", "item-acme"), bundle.cv)).toBe("Role"); // position/company null
    expect(anchorLabel(mk("bullet", "b-acme-uptime"), bundle.cv)).toBe(
      "Raised pipeline uptime to 99.9% across 12 markets.",
    );
  });

  it("truncates a long bullet label with an ellipsis", () => {
    const label = anchorLabel(mk("bullet", "b-acme-edi"), bundle.cv);
    expect(label.startsWith("Led migration of 40 EDI partners")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("apply corrections — decisions + the per-bullet lifecycle (PR-4)", () => {
  // editable bullets in the fixture: b-acme-edi / b-acme-uptime / b-acme-netnew / b-globex-api.
  const editableIds = editableBulletIds(bundle.cv);
  const mkThread = (
    over: Partial<ReviewThread> & Pick<ReviewThread, "anchorId">,
  ): ReviewThread => ({
    key: `editor:bullet:${over.anchorId}:0`,
    source: "editor",
    anchorKind: "bullet",
    comment: "tighten",
    severity: "minor",
    ...over,
  });

  it("decide toggles, clears on re-apply, switches, and is immutable", () => {
    const d0: Decisions = {};
    const d1 = decide(d0, "k1", "accepted");
    expect(d1).toEqual({ k1: "accepted" });
    expect(d0).toEqual({}); // immutable
    expect(decide(d1, "k1", "accepted")).toEqual({}); // re-apply clears
    expect(decide(d1, "k1", "rejected")).toEqual({ k1: "rejected" }); // switch
  });

  it("reviewedTextSnapshot captures every bullet's text", () => {
    const snap = reviewedTextSnapshot(bundle.cv);
    expect(snap["b-acme-edi"]).toBe(persistedText("b-acme-edi"));
    expect(Object.keys(snap)).toContain("b-globex-api");
  });

  it("staleReviewBulletIds: saved drift OR dirty; unchanged live; revert live again; new not stale", () => {
    const snap = reviewedTextSnapshot(bundle.cv);
    const savedEdit = overlayDrafts(bundle, { "b-acme-edi": "A reworded saved line." }).cv;
    expect([...staleReviewBulletIds(snap, savedEdit, {})]).toEqual(["b-acme-edi"]); // saved-text drift
    expect([...staleReviewBulletIds(snap, bundle.cv, {})]).toEqual([]); // unchanged → live
    expect([...staleReviewBulletIds(snap, bundle.cv, { "b-acme-uptime": "x" })]).toEqual([
      "b-acme-uptime",
    ]); // unsaved draft → stale
    expect([
      ...staleReviewBulletIds(snap, bundle.cv, { "b-acme-edi": persistedText("b-acme-edi") }),
    ]).toEqual([]); // draft reverted to snapshot → live again
    expect([...staleReviewBulletIds({}, bundle.cv, {})]).toEqual([]); // no snapshot → never stale
  });

  it("isAcceptableThread: editable bullet, non-stale, not a supported fact-check", () => {
    const live = new Set<string>();
    expect(isAcceptableThread(mkThread({ anchorId: "b-acme-edi" }), live, editableIds)).toBe(true);
    expect(
      isAcceptableThread(
        mkThread({ anchorId: "item-acme", anchorKind: "item" }),
        live,
        editableIds,
      ),
    ).toBe(false); // item anchor → not inline
    expect(isAcceptableThread(mkThread({ anchorId: "ghost" }), live, editableIds)).toBe(false); // orphan
    expect(
      isAcceptableThread(
        mkThread({ anchorId: "b-acme-edi" }),
        new Set(["b-acme-edi"]),
        editableIds,
      ),
    ).toBe(false); // stale
    expect(
      isAcceptableThread(
        mkThread({ anchorId: "b-acme-edi", source: "factCheck", verdict: "supported" }),
        live,
        editableIds,
      ),
    ).toBe(false); // supported fact-check → not a correction
    expect(
      isAcceptableThread(
        mkThread({ anchorId: "b-acme-edi", source: "factCheck", verdict: "overstated" }),
        live,
        editableIds,
      ),
    ).toBe(true); // overstated → correctable
    expect(
      isAcceptableThread(mkThread({ anchorId: "b-acme-edi", resolved: true }), live, editableIds),
    ).toBe(false); // resolved (applied) → not actionable, even when NOT stale (ADR 0014)
  });

  it("acceptedThreads: only accepted+correctable; multiple per bullet kept; strips frontend fields", () => {
    const threads = [
      mkThread({
        key: "editor:bullet:b-acme-edi:0",
        anchorId: "b-acme-edi",
        suggestedRevision: "Edited line.",
      }),
      mkThread({
        key: "spotter:bullet:b-acme-edi:0",
        anchorId: "b-acme-edi",
        source: "spotter",
        flag: "llm-tell",
      }),
      mkThread({
        key: "factCheck:bullet:b-acme-uptime:0",
        anchorId: "b-acme-uptime",
        source: "factCheck",
        verdict: "supported",
      }),
      mkThread({ key: "editor:item:item-acme:0", anchorId: "item-acme", anchorKind: "item" }),
    ];
    const decisions: Decisions = {
      "editor:bullet:b-acme-edi:0": "accepted",
      "spotter:bullet:b-acme-edi:0": "accepted",
      "factCheck:bullet:b-acme-uptime:0": "accepted", // supported → dropped
      "editor:item:item-acme:0": "accepted", // item → dropped
    };
    const out = acceptedThreads(threads, decisions, new Set(), editableIds);
    expect(out.map((t) => t.anchorId)).toEqual(["b-acme-edi", "b-acme-edi"]);
    expect(out[0]).toEqual({
      anchorId: "b-acme-edi",
      anchorKind: "bullet",
      comment: "tighten",
      severity: "minor",
      suggestedRevision: "Edited line.",
    });
    expect(out[0]).not.toHaveProperty("key"); // frontend-only field stripped
  });

  it("sameBulletApply: clicked + EVERY non-rejected same-bullet note, never other bullets", () => {
    const clicked = mkThread({ key: "editor:bullet:b1:0", anchorId: "b1" });
    const threads = [
      clicked,
      mkThread({ key: "spotter:bullet:b1:0", anchorId: "b1", source: "spotter" }), // same bullet, staged
      mkThread({ key: "editor:bullet:b2:0", anchorId: "b2" }), // OTHER bullet, staged
      mkThread({ key: "factCheck:bullet:b1:0", anchorId: "b1", source: "factCheck" }), // same, undecided
    ];
    const decisions: Decisions = {
      "spotter:bullet:b1:0": "accepted",
      "editor:bullet:b2:0": "accepted",
    };
    // clicked + BOTH same-bullet siblings (staged accept AND undecided) — whole-bullet resolve would
    // otherwise drop the undecided one; NOT the other bullet's accept.
    expect(sameBulletApply(clicked, threads, decisions)).toEqual({
      "editor:bullet:b1:0": "accepted",
      "spotter:bullet:b1:0": "accepted",
      "factCheck:bullet:b1:0": "accepted",
    });
  });

  it("sameBulletApply: excludes an explicitly REJECTED same-bullet sibling", () => {
    const clicked = mkThread({ key: "editor:bullet:b1:0", anchorId: "b1" });
    const rejected = mkThread({ key: "spotter:bullet:b1:0", anchorId: "b1", source: "spotter" });
    // A dismissal must never be resurrected into the apply payload.
    expect(
      sameBulletApply(clicked, [clicked, rejected], { "spotter:bullet:b1:0": "rejected" }),
    ).toEqual({
      "editor:bullet:b1:0": "accepted",
    });
  });

  it("sameBulletApply → acceptedThreads still drops an undecided SUPPORTED fact-check sibling", () => {
    const clicked = mkThread({ key: "editor:bullet:b1:0", anchorId: "b1" });
    const supported = mkThread({
      key: "factCheck:bullet:b1:0",
      anchorId: "b1",
      source: "factCheck",
      verdict: "supported", // positive verdict — not a correction; rewriting it re-words a verified bullet
    });
    const threads = [clicked, supported];
    const sb = sameBulletApply(clicked, threads, {});
    // sameBulletApply folds the undecided supported sibling in (it isn't rejected)...
    expect(sb["factCheck:bullet:b1:0"]).toBe("accepted");
    // ...but the downstream re-filter through isAcceptableThread drops it, so the Corrector never
    // re-words a supported bullet. Only the editor note reaches the payload.
    const out = acceptedThreads(threads, sb, new Set<string>(), new Set(["b1"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.anchorId).toBe("b1");
  });

  it("foldSameBulletDecisions: batch apply folds each accepted bullet's non-rejected siblings", () => {
    const threads = [
      mkThread({ key: "editor:bullet:b1:0", anchorId: "b1" }), // accepted
      mkThread({ key: "spotter:bullet:b1:0", anchorId: "b1", source: "spotter" }), // undecided sibling
      mkThread({ key: "factCheck:bullet:b1:0", anchorId: "b1", source: "factCheck" }), // rejected sibling
      mkThread({ key: "editor:bullet:b2:0", anchorId: "b2" }), // no accepted sibling → untouched
    ];
    const decisions: Decisions = {
      "editor:bullet:b1:0": "accepted",
      "factCheck:bullet:b1:0": "rejected",
    };
    const out = foldSameBulletDecisions(decisions, threads);
    expect(out["editor:bullet:b1:0"]).toBe("accepted");
    expect(out["spotter:bullet:b1:0"]).toBe("accepted"); // undecided sibling FOLDED in (no silent drop)
    expect(out["factCheck:bullet:b1:0"]).toBe("rejected"); // an explicit dismissal is never resurrected
    expect(out["editor:bullet:b2:0"]).toBeUndefined(); // b2 has no accepted thread → left alone
  });

  it("foldSameBulletDecisions: no accepted thread → returns the same decisions reference unchanged", () => {
    const decisions: Decisions = {};
    expect(foldSameBulletDecisions(decisions, [mkThread({ key: "k1", anchorId: "b1" })])).toBe(
      decisions,
    );
  });

  it("isSupportedFactCheck: only a factCheck with a supported verdict", () => {
    expect(isSupportedFactCheck(mkThread({ anchorId: "b1", source: "factCheck" }))).toBe(false);
    expect(
      isSupportedFactCheck(mkThread({ anchorId: "b1", source: "factCheck", verdict: "supported" })),
    ).toBe(true);
    expect(isSupportedFactCheck(mkThread({ anchorId: "b1" }))).toBe(false);
  });

  it("decisions survive a one-bullet save — only the saved bullet's accept drops out", () => {
    const threads = [
      mkThread({ key: "k-edi", anchorId: "b-acme-edi" }),
      mkThread({ key: "k-uptime", anchorId: "b-acme-uptime" }),
    ];
    const decisions: Decisions = { "k-edi": "accepted", "k-uptime": "accepted" };
    const out = acceptedThreads(threads, decisions, new Set(["b-acme-edi"]), editableIds);
    expect(out.map((t) => t.anchorId)).toEqual(["b-acme-uptime"]);
    expect(decisions["k-uptime"]).toBe("accepted"); // the surviving decision is preserved
  });

  it("canApplyCorrections: ≥1 accepted, no dirty, not busy — NOT gated on sign-off", () => {
    expect(canApplyCorrections({ acceptedCount: 1, dirty: 0, busy: false })).toBe(true);
    expect(canApplyCorrections({ acceptedCount: 0, dirty: 0, busy: false })).toBe(false);
    expect(canApplyCorrections({ acceptedCount: 2, dirty: 1, busy: false })).toBe(false);
    expect(canApplyCorrections({ acceptedCount: 2, dirty: 0, busy: true })).toBe(false);
  });

  it("applyFeedbackRequest builds the POST path + body", () => {
    const threads = [
      {
        anchorId: "b-acme-edi",
        anchorKind: "bullet" as const,
        comment: "c",
        severity: "minor" as const,
        suggestedRevision: "x",
      },
    ];
    const call = applyFeedbackRequest("cv-1", 3, threads);
    expect(call.path).toBe("/workspaces/default/cv/cv-1/apply");
    expect(call.init?.method).toBe("POST");
    expect(body(call.init)).toEqual({ threads, baseVersion: 3 });
  });
});

describe("ThreadCard / ThreadList renderers", () => {
  it("ThreadCard renders a fact-check thread with claim, verdict, advisory rewrite, and anchor", () => {
    const t: ReviewThread = {
      key: "k",
      source: "factCheck",
      anchorKind: "bullet",
      anchorId: "b-acme-edi",
      comment: "Can't verify the partner count.",
      severity: "major",
      claim: "40 EDI partners",
      verdict: "unsupported",
      sourceId: "acme-edi",
      suggestedRevision: "Migrated dozens of EDI partners.",
    };
    const html = renderToStaticMarkup(<ThreadCard thread={t} cv={bundle.cv} showAnchor />);
    expect(html).toContain("Fact-check");
    expect(html).toContain("unsupported");
    expect(html).toContain("40 EDI partners");
    expect(html).toContain("Can&#x27;t verify the partner count.");
    expect(html).toContain("Migrated dozens of EDI partners.");
    expect(html).toContain("SUGGESTED — advisory"); // read-only (no acceptable prop) → advisory
    expect(html).not.toContain("correction on"); // and no Accept button
    expect(html).toContain("Led migration of 40 EDI partners"); // anchorLabel snippet
    expect(html).toContain("Source: acme-edi");
  });

  it("ThreadCard renders Accept / Reject when acceptable, reflecting the decision (PR-4)", () => {
    const t: ReviewThread = {
      key: "editor:bullet:b-acme-edi:0",
      source: "editor",
      anchorKind: "bullet",
      anchorId: "b-acme-edi",
      comment: "Tighten this.",
      severity: "minor",
      suggestedRevision: "A crisper line.",
    };
    const html = renderToStaticMarkup(
      <ThreadCard thread={t} cv={bundle.cv} showAnchor={false} acceptable decision="accepted" />,
    );
    expect(html).toContain("correction on"); // aria-label gives SR context (after the visible label)
    expect(html).toContain("✓ Accepted"); // reflects decision="accepted"
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("advisory"); // the acceptable label drops the advisory suffix
  });

  it("ThreadCard offers Accept with no suggestedRevision (Corrector works from the comment)", () => {
    const t: ReviewThread = {
      key: "spotter:bullet:b-acme-edi:0",
      source: "spotter",
      anchorKind: "bullet",
      anchorId: "b-acme-edi",
      comment: "Sounds generic.",
      severity: "minor",
      flag: "generic-phrasing",
    };
    const html = renderToStaticMarkup(
      <ThreadCard thread={t} cv={bundle.cv} showAnchor={false} acceptable />,
    );
    expect(html).toContain("Accept — reword from this note");
  });

  it("ThreadCard keeps the fact-check source visible even inline (showAnchor=false)", () => {
    const t: ReviewThread = {
      key: "k",
      source: "factCheck",
      anchorKind: "bullet",
      anchorId: "b-acme-edi",
      comment: "Overstated.",
      severity: "minor",
      verdict: "overstated",
      sourceId: "acme-edi",
    };
    const html = renderToStaticMarkup(<ThreadCard thread={t} cv={bundle.cv} showAnchor={false} />);
    expect(html).toContain("Source: acme-edi"); // source survives inline routing
    expect(html).not.toContain("On:"); // but the anchor label is omitted inline
  });

  it("ThreadList shows per-agent state: overall + cards, a failed 'couldn't run' row, and 'no findings'", () => {
    const checklist: Checklist = {
      order: ["editor", "fact-checker", "spotter"],
      status: { editor: "done", "fact-checker": "failed", spotter: "done" },
    };
    const tlBundle: Schemas["ReviewBundle"] = {
      cvVersion: 2,
      failures: [{ agentId: "fact-checker", detail: "RateLimitError" }],
      resolvedAnchorIds: [],
      editor: { overall: "Tighten the verbs.", threads: [] },
      slop: { threads: [] },
    };
    const panelThreads: ReviewThread[] = [
      {
        key: "e1",
        source: "editor",
        anchorKind: "item",
        anchorId: "item-acme",
        comment: "Reorder these bullets.",
        severity: "minor",
      },
      {
        key: "e2",
        source: "editor",
        anchorKind: "item",
        anchorId: "ghost-item",
        comment: "Anchored to removed content.",
        severity: "info",
      },
    ];
    const html = renderToStaticMarkup(
      <ThreadList
        bundle={tlBundle}
        cv={bundle.cv}
        panelThreads={panelThreads}
        inlineCountBySource={{ editor: 0, factCheck: 0, spotter: 0, gatekeeper: 0 }}
        checklist={checklist}
        settled
      />,
    );
    expect(html).toContain("Line edits");
    expect(html).toContain("Tighten the verbs."); // editor.overall as the disclosure body lead
    expect(html).toContain("Reorder these bullets."); // live editor panel thread
    expect(html).toContain("Couldn"); // "Couldn't run" failed row (apostrophe entity-escaped)
    expect(html).toContain("rate-limited"); // failureLabel(RateLimitError), not the raw class name
    expect(html).not.toContain("RateLimitError"); // never leak the raw exception name
    expect(html).toContain("Voice review"); // spotter disclosure shown
    expect(html).toContain("No findings."); // spotter done + empty
    expect(html).toContain("no longer match this CV"); // the ghost-item orphan line
  });
});

describe("withPostingUrl (B1 — owner-supplied posting URL merge)", () => {
  const spec: Schemas["JobSpec"] = {
    rawText: "We need a backend engineer.",
    title: "Backend Engineer",
    company: "Acme",
    seniority: "senior",
    mustHaves: ["Python"],
    niceToHaves: [],
    atsKeywords: ["fastapi"],
    tone: "technical",
    redFlags: [],
    postingUrl: null,
  };

  it("attaches a trimmed URL", () => {
    expect(withPostingUrl(spec, "  https://x.test/job  ").postingUrl).toBe("https://x.test/job");
  });

  it("maps a blank/whitespace-only URL to null (legacy-clean, never fetched)", () => {
    expect(withPostingUrl(spec, "   ").postingUrl).toBeNull();
    expect(withPostingUrl(spec, "").postingUrl).toBeNull();
  });

  it("drops a non-http(s) URL to null (no javascript:/data: href sink)", () => {
    expect(withPostingUrl(spec, "javascript:alert(1)").postingUrl).toBeNull();
    expect(withPostingUrl(spec, "data:text/html,<script>1</script>").postingUrl).toBeNull();
    expect(withPostingUrl(spec, "company.com/job").postingUrl).toBeNull(); // no scheme → invalid
  });

  it("preserves the parsed fields and overrides any prior postingUrl", () => {
    const out = withPostingUrl({ ...spec, postingUrl: "old" }, "https://new.test");
    expect(out.postingUrl).toBe("https://new.test");
    expect(out.title).toBe("Backend Engineer");
    expect(out.mustHaves).toEqual(["Python"]);
  });

  it("does not mutate the input spec", () => {
    withPostingUrl(spec, "https://x.test");
    expect(spec.postingUrl).toBeNull();
  });
});

describe("isSafeHttpUrl (B1 — posting-URL href guard)", () => {
  it("accepts http and https absolute URLs", () => {
    expect(isSafeHttpUrl("https://acme.test/careers/123")).toBe(true);
    expect(isSafeHttpUrl("http://acme.test")).toBe(true);
  });

  it("rejects script/data/other protocols and unparseable values", () => {
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,x")).toBe(false);
    expect(isSafeHttpUrl("mailto:a@b.test")).toBe(false);
    expect(isSafeHttpUrl("ftp://acme.test")).toBe(false);
    expect(isSafeHttpUrl("not a url")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
  });
});

describe("newApplicationError (B1 — parse/tailor/draft failure copy)", () => {
  it("guides to the master CV on 404 (no master saved yet)", () => {
    expect(newApplicationError(new ApiError(404, "no master"))).toMatch(/master CV first/i);
  });

  it("guides to Admin only on 503 (AI not configured)", () => {
    expect(newApplicationError(new ApiError(503, "no key"))).toMatch(/Admin/);
  });

  it("treats 502 as a transient provider failure — retry, not a config nudge", () => {
    const msg = newApplicationError(new ApiError(502, "bad gateway"));
    expect(msg).toMatch(/try again/i);
    expect(msg).not.toMatch(/Admin/);
  });

  it("unwraps the FastAPI {detail} body for other ApiErrors (e.g. a 422 refusal)", () => {
    // api() stores the raw response body as ApiError.message — this is what the modal really gets.
    expect(newApplicationError(new ApiError(422, '{"detail":"model declined to respond"}'))).toBe(
      "model declined to respond",
    );
    // A plain-text message (non-JSON) passes through unchanged.
    expect(newApplicationError(new ApiError(422, "Title is required"))).toBe("Title is required");
  });

  it("falls back to a generic message for a detail-less ApiError", () => {
    expect(newApplicationError(new ApiError(500, ""))).toMatch(/please try again/i);
  });

  it("handles a non-ApiError throwable", () => {
    expect(newApplicationError(new Error("boom"))).toBe("Something went wrong — please try again.");
  });
});

// --- Review persistence: rehydration + decisions sync (S4 / ADR 0013) ------------------------

describe("reviewLatestRequest / saveDecisionsRequest (persistence builders)", () => {
  it("builds the GET latest-review probe (encoded cvId, no body/method)", () => {
    const req = reviewLatestRequest("cv 1");
    expect(req.path).toBe("/workspaces/default/cv/cv%201/review");
    expect(req.init).toBeUndefined();
  });

  it("builds the PUT decisions call with the whole snapshot + cvVersion (encoded cvId)", () => {
    const decisions: Decisions = {
      "editor:bullet:b1:0": "accepted",
      "spotter:bullet:b1:0": "rejected",
    };
    const req = saveDecisionsRequest("cv/2", decisions, 7);
    expect(req.path).toBe("/workspaces/default/cv/cv%2F2/review/decisions");
    expect(req.init?.method).toBe("PUT");
    expect(body(req.init)).toEqual({ decisions, cvVersion: 7 });
  });
});

describe("checklistFromBundle (rehydrated settled checklist)", () => {
  const bundleWith = (over: Partial<Schemas["ReviewBundle"]>): Schemas["ReviewBundle"] => ({
    cvVersion: 3,
    failures: [],
    resolvedAnchorIds: [],
    ...over,
  });

  it("maps every populated report field to its backend agent id — all done (slop→spotter, factCheck→fact-checker)", () => {
    const cl = checklistFromBundle(
      bundleWith({
        editor: { overall: "", threads: [] },
        factCheck: { threads: [] },
        gatekeeper: { ...gk, threads: [] },
        slop: { threads: [] },
      }),
    );
    expect(cl.status).toEqual({
      editor: "done",
      "fact-checker": "done",
      gatekeeper: "done",
      spotter: "done",
    });
    expect([...cl.order].sort()).toEqual(["editor", "fact-checker", "gatekeeper", "spotter"]);
  });

  it("preserves 'absent' for an agent that never ran (no-job draft) — same as a settled-live run", () => {
    // Only the always-on adjudicators reported: no editor/gatekeeper field → they stay OUT of the
    // checklist, so agentState(settled=true) reads 'absent', exactly as it would after a live no-job run.
    const cl = checklistFromBundle(
      bundleWith({ factCheck: { threads: [] }, slop: { threads: [] } }),
    );
    expect(cl.status).toEqual({ "fact-checker": "done", spotter: "done" });
    expect(agentState(cl, [], "gatekeeper", true)).toBe("absent");
    expect(agentState(cl, [], "editor", true)).toBe("absent");
    expect(agentState(cl, [], "fact-checker", true)).toBe("done");
  });

  it("maps a failures[] entry to 'failed' (a failure wins over a report)", () => {
    const failures = [{ agentId: "editor", detail: "RateLimitError" }];
    const cl = checklistFromBundle(bundleWith({ slop: { threads: [] }, failures }));
    expect(cl.status.editor).toBe("failed");
    expect(cl.status.spotter).toBe("done");
    expect(agentState(cl, failures, "editor", true)).toBe("failed");
  });

  it("rehydrated roster status equals the settled-live one (feed through agentRosterStatus)", () => {
    const b = bundleWith({
      editor: { overall: "Tighten the verbs.", threads: [] },
      factCheck: { threads: [] },
      slop: { threads: [] },
    });
    const cl = checklistFromBundle(b);
    // editor done, 0 panel + 0 inline BUT a real overall → a "note" slot (not a false 0).
    const editorState = agentState(cl, b.failures, SOURCE_AGENT_ID.editor, true);
    expect(editorState).toBe("done");
    expect(agentRosterStatus("editor", editorState, 0, 0, !!b.editor?.overall)).toEqual({
      kind: "note",
    });
    // fact-check done, no findings → no slot; gatekeeper never ran (absent) → no slot.
    expect(
      agentRosterStatus(
        "factCheck",
        agentState(cl, [], SOURCE_AGENT_ID.factCheck, true),
        0,
        0,
        false,
      ),
    ).toEqual({ kind: "none" });
    expect(
      agentRosterStatus(
        "gatekeeper",
        agentState(cl, [], SOURCE_AGENT_ID.gatekeeper, true),
        0,
        0,
        false,
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("rehydration key-determinism + restored staleness (S4)", () => {
  const editorT: Schemas["Thread"] = {
    anchorId: "b-acme-edi",
    anchorKind: "bullet",
    comment: "tighten",
    severity: "minor",
  };
  const slopT: Schemas["SlopThread"] = {
    anchorId: "b-acme-edi",
    anchorKind: "bullet",
    comment: "cliché",
    flag: "cliche",
    severity: "minor",
  };
  const savedBundle: Schemas["ReviewBundle"] = {
    cvVersion: 3,
    failures: [],
    resolvedAnchorIds: [],
    editor: { overall: "", threads: [editorT] },
    slop: { threads: [slopT] },
  };
  const roundtrip = (b: Schemas["ReviewBundle"]): Schemas["ReviewBundle"] =>
    JSON.parse(JSON.stringify(b)) as Schemas["ReviewBundle"];

  it("collectThreads keys survive a persist→restore JSON round-trip, so restored decisions re-attach", () => {
    const liveKeys = collectThreads(savedBundle).map((t) => t.key);
    const restoredKeys = collectThreads(roundtrip(savedBundle)).map((t) => t.key);
    expect(restoredKeys).toEqual(liveKeys);
    // A decision keyed at review time still lands on the restored thread → it's accepted after restore.
    const decisions: Decisions = { [liveKeys[0] as string]: "accepted" };
    const editableIds = editableBulletIds(bundle.cv);
    const accepted = acceptedThreads(
      collectThreads(roundtrip(savedBundle)),
      decisions,
      new Set(),
      editableIds,
    );
    expect(accepted.map((t) => t.anchorId)).toEqual(["b-acme-edi"]);
  });

  it("acceptedThreads projection is identical pre-navigation vs after restore (same bundle + decisions)", () => {
    const editableIds = editableBulletIds(bundle.cv);
    const decisions: Decisions = { "editor:bullet:b-acme-edi:0": "accepted" };
    const before = acceptedThreads(collectThreads(savedBundle), decisions, new Set(), editableIds);
    const after = acceptedThreads(
      collectThreads(roundtrip(savedBundle)),
      decisions,
      new Set(),
      editableIds,
    );
    expect(after).toEqual(before);
  });

  it("decide → the PUT payload is the POST-toggle snapshot (the exact map persisted)", () => {
    // decide() toggles; the sync PUTs exactly the RETURNED snapshot, so a re-accept that CLEARS a key
    // persists the cleared map (not the pre-toggle one).
    const d1 = decide({}, "k1", "accepted");
    expect(body(saveDecisionsRequest("cv1", d1, 3).init)).toEqual({
      decisions: { k1: "accepted" },
      cvVersion: 3,
    });
    const d2 = decide(d1, "k1", "accepted"); // re-accept clears
    expect(body(saveDecisionsRequest("cv1", d2, 3).init)).toEqual({ decisions: {}, cvVersion: 3 });
  });

  it("staleReviewBulletIds over a RESTORED reviewedText flags exactly the drifted bullet", () => {
    // On restore, reviewedText is a server-sent bulletId→text map (not a live snapshot); an edit since
    // the persisted review must still register as drift so the note goes stale (per-bullet lifecycle).
    const restoredReviewedText = reviewedTextSnapshot(bundle.cv);
    const editedCv = overlayDrafts(bundle, {
      "b-acme-edi": "Edited after the restored review.",
    }).cv;
    expect([...staleReviewBulletIds(restoredReviewedText, editedCv, {})]).toEqual(["b-acme-edi"]);
  });
});

// --- Drifted review stays visible (ADR 0016) — region carriers -------------------------------
//
// Paraphrase-proof region tests: each scenario pins its inputs (dirtyCount, gatekeeperState via the
// checklist/failures, acceptedCount, restored) and asserts (a) the count of the canonical
// STALE_REVIEW_PHRASE and (b) a DERIVED /re-run/i total, accounting every legitimate contributor
// (the allowlist: the trigger label, ThreadList per-agent error copy, applyDisabledReason, the
// dirty hint, the gatekeeper-unavailable fallback — plus the phrase itself, which contains
// "re-run"). Any new "re-run" paraphrase breaks the count and must be routed through a carrier.

/** Occurrences of a literal string (regex-escaped) or a regex in rendered HTML. */
const countOf = (html: string, needle: string | RegExp): number =>
  (
    html.match(
      typeof needle === "string"
        ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
        : new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : `${needle.flags}g`),
    ) ?? []
  ).length;

describe("drifted review region carriers (ADR 0016)", () => {
  const panelGkThread: Schemas["Thread"] = {
    anchorId: "item-acme",
    anchorKind: "item",
    comment: "Lead with the platform win.",
    severity: "minor",
  };
  const settledAll: Checklist = {
    order: ["editor", "fact-checker", "spotter", "gatekeeper"],
    status: { editor: "done", "fact-checker": "done", spotter: "done", gatekeeper: "done" },
  };
  const settledNoGate: Checklist = {
    order: ["editor", "fact-checker", "spotter"],
    status: { editor: "done", "fact-checker": "done", spotter: "done" },
  };
  const withVerdict: Schemas["ReviewBundle"] = {
    cvVersion: 3,
    failures: [],
    resolvedAnchorIds: [],
    editor: { overall: "", threads: [] },
    factCheck: { threads: [] },
    slop: { threads: [] },
    gatekeeper: { ...gk, threads: [panelGkThread] },
  };
  const noVerdict: Schemas["ReviewBundle"] = {
    cvVersion: 3,
    failures: [],
    resolvedAnchorIds: [],
    editor: { overall: "", threads: [] },
    factCheck: { threads: [] },
    slop: { threads: [] },
  };
  const renderPanel = (over: Partial<Parameters<typeof ReviewPanel>[0]> = {}) =>
    renderToStaticMarkup(
      <ReviewPanel
        cv={bundle.cv}
        bundle={null}
        reviewing={false}
        mutating={false}
        clearing={false}
        versionDrifted={false}
        reviewRestored={false}
        saveFailed={false}
        decideSaveFailed={false}
        reviewLoadFailed={false}
        dirtyCount={0}
        checklist={settledAll}
        statusLine=""
        reviewError={null}
        reviewReadiness="ready"
        headingRef={null}
        onReview={() => {}}
        onCancel={() => {}}
        onRetryReview={() => {}}
        onOpenGatekeeper={() => {}}
        showApply={false}
        acceptedCount={0}
        canApply={false}
        applyDisabledReason={null}
        applying={false}
        applyError={null}
        onApply={() => {}}
        onClearReview={() => {}}
        {...over}
      />,
    );

  it("rail ABSENT: no phrase, no chip, zero re-run copy", () => {
    const html = renderPanel();
    expect(html).toContain("Get an AI read on this CV"); // the intro renders
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(0);
    expect(countOf(html, "Out of date")).toBe(0);
    expect(countOf(html, /re-run/i)).toBe(0); // trigger reads "Review", not "Re-run"
  });

  it("rail FRESH: no phrase, no chip; /re-run/i = 1 (the Re-run trigger only)", () => {
    const html = renderPanel({ bundle: withVerdict });
    expect(html).toContain('data-testid="verdict-card"');
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(0);
    expect(countOf(html, "Out of date")).toBe(0);
    expect(countOf(html, /re-run/i)).toBe(1); // 1 = the "Re-run" trigger
  });

  it("rail DRIFTED + verdict, 0 accepts: the card chip is the single carrier; governed caption renders NOTHING", () => {
    const html = renderPanel({ bundle: withVerdict, versionDrifted: true });
    // Exactly one canonical phrase — inside the VerdictCard's extended aria-label, which also
    // embeds the chip's visible "Out of date" text (WCAG 2.5.3 label-in-name).
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1);
    expect(html).toContain(`ATS 80/100. Out of date: ${STALE_REVIEW_PHRASE}.`); // the name assertion
    expect(countOf(html, "Out of date")).toBe(2); // the card chip + its label-in-name echo
    // The governed caption drops its drift clause AND, at zero accepts, renders nothing at all.
    expect(html).not.toContain("Your accepted bullet notes");
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
    // 2 = the "Re-run" trigger + the phrase's own "re-run" (in the card aria-label).
    expect(countOf(html, /re-run/i)).toBe(2);
  });

  it("rail DRIFTED + verdict, >0 accepts: caption keeps ONLY the accepted-notes sentence", () => {
    const html = renderPanel({ bundle: withVerdict, versionDrifted: true, acceptedCount: 2 });
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1); // still only the card chip's aria-label
    expect(html).toContain("Your accepted bullet notes still apply.");
    expect(countOf(html, /re-run/i)).toBe(2); // trigger + the phrase in the aria-label
  });

  it("rail DRIFTED, no verdict: the drift caption carries the phrase (built from the constant)", () => {
    const html = renderPanel({
      bundle: noVerdict,
      checklist: settledNoGate,
      versionDrifted: true,
    });
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1); // visible caption, no chip anywhere
    expect(countOf(html, "Out of date")).toBe(0);
    // The gatekeeper empty-copy fallback stays FRESH-only — never beside the drift caption.
    expect(html).not.toContain("Gatekeeper unavailable");
    expect(countOf(html, /re-run/i)).toBe(2); // trigger + the phrase's own "re-run"
  });

  it("rail DRIFTED restored, no verdict: the restored caption carries the phrase once", () => {
    const html = renderPanel({
      bundle: noVerdict,
      checklist: settledNoGate,
      versionDrifted: true,
      reviewRestored: true,
    });
    expect(html).toContain("Restored from an earlier run.");
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1);
    expect(countOf(html, /re-run/i)).toBe(2); // trigger + phrase
  });

  it("rail DRIFTED restored + verdict, 0 accepts: chip carries it; restored caption renders NOTHING", () => {
    const html = renderPanel({ bundle: withVerdict, versionDrifted: true, reviewRestored: true });
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1); // the card aria-label only
    expect(countOf(html, "Out of date")).toBe(2); // chip + its label-in-name echo in the aria-label
    expect(html).not.toContain("Restored from an earlier run");
    expect(html).not.toContain("Your accepted bullet notes");
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
    expect(countOf(html, /re-run/i)).toBe(2);
  });

  it("rail allowlist accounting: dirty hint + stale-accepts reason + failed-agent copy all tally", () => {
    const html = renderPanel({
      bundle: { ...withVerdict, failures: [{ agentId: "editor", detail: "RateLimitError" }] },
      versionDrifted: true,
      dirtyCount: 2,
      showApply: true,
      applyDisabledReason: "Your accepted notes are stale — re-run Review.",
    });
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1); // single carrier holds under extra copy
    // 5 = trigger "Re-run" + card-aria phrase + ThreadList failed-editor "Re-run to try again."
    //   + dirty hint "…re-run Review." + applyDisabledReason "…re-run Review."
    expect(countOf(html, /re-run/i)).toBe(5);
  });

  it("rail DRIFTED roster: the identity badge keeps its FULL fill+ink pair; dim rides the row chrome only", () => {
    const fresh = renderPanel({ bundle: withVerdict });
    const stale = renderPanel({ bundle: withVerdict, versionDrifted: true });
    // The badge fill+ink is a contrast-tested pair (design-system.md §agent identity) — the fill
    // stays the RAW identity token in both states, never colour-mixed under unchanged ink.
    for (const html of [fresh, stale]) {
      expect(html).toContain(
        "background:var(--rv-editor);color:var(--ink-editor, var(--agent-ink))",
      );
      expect(html).toContain("background:var(--rv-gate);color:var(--ink-gate, var(--agent-ink))");
    }
    expect(stale).not.toContain("var(--rv-editor) 55%"); // the old badge-fill desaturation is gone
    // Roster dimming lives on the ROW chrome only: tint 6%→3%, border 18%→8%.
    expect(stale).toContain("color-mix(in srgb, var(--rv-editor) 3%, var(--panel))");
    expect(stale).toContain("color-mix(in srgb, var(--rv-editor) 8%, var(--line))");
    expect(fresh).toContain("color-mix(in srgb, var(--rv-editor) 6%, var(--panel))");
    expect(fresh).toContain("color-mix(in srgb, var(--rv-editor) 18%, var(--line))");
  });

  it("rail DRIFTED + orphaned notes: the orphan footnote drops its re-run tail (single carrier)", () => {
    // An anchor no bullet in the CV carries — a panel-routed orphan (anchored to removed content).
    const orphaned: Schemas["ReviewBundle"] = {
      ...withVerdict,
      editor: {
        overall: "",
        threads: [
          {
            anchorId: "b-gone",
            anchorKind: "bullet",
            comment: "On a removed line.",
            severity: "minor",
          },
        ],
      },
    };
    const stale = renderPanel({ bundle: orphaned, versionDrifted: true });
    expect(stale).toContain("no longer match this CV");
    expect(countOf(stale, STALE_REVIEW_PHRASE)).toBe(1); // the card chip aria-label stays sole carrier
    // 2 = the "Re-run" trigger + the phrase — the orphan footnote contributes NO second instruction.
    expect(countOf(stale, /re-run/i)).toBe(2);
    const fresh = renderPanel({ bundle: orphaned });
    expect(fresh).toContain("re-run Review to refresh."); // the tail stays in the fresh state
    expect(countOf(fresh, /re-run/i)).toBe(2); // trigger + the orphan tail
  });

  it("rail FRESH with a failed Gatekeeper: the unavailable fallback + ThreadList row tally, no phrase", () => {
    const html = renderPanel({
      bundle: { ...noVerdict, failures: [{ agentId: "gatekeeper", detail: "AgentError" }] },
      checklist: settledNoGate,
    });
    expect(html).toContain("Gatekeeper unavailable");
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(0);
    // 3 = trigger "Re-run" + the fallback's "Re-run to try again." + ThreadList's failed-row
    //   "Re-run to try again."
    expect(countOf(html, /re-run/i)).toBe(3);
  });

  it("header FRESH (TopbarVerdict): pill + accessible name, no chip, no phrase", () => {
    const html = renderToStaticMarkup(
      <TopbarVerdict verdict={gk} stale={false} onOpen={() => {}} />,
    );
    expect(html).toContain("Gatekeeper verdict Likely pass 80/100 — open the recruiter read");
    expect(countOf(html, "Out of date")).toBe(0);
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(0);
  });

  it("header STALE (TopbarVerdict): SHORT chip visible; the name carries the chip text AND the phrase", () => {
    const html = renderToStaticMarkup(<TopbarVerdict verdict={gk} stale onOpen={() => {}} />);
    // 2 = the visible chip (short — never the 45-char phrase) + its label-in-name echo: the chip is
    // aria-hidden, so the accessible name must CONTAIN the literal visible "Out of date" (WCAG
    // 2.5.3 — a voice-control user speaks what they see) ahead of the canonical phrase.
    expect(countOf(html, "Out of date")).toBe(2);
    expect(html).toContain(
      `Gatekeeper verdict Likely pass 80/100 — Out of date: ${STALE_REVIEW_PHRASE} — open the recruiter read`,
    );
  });

  it("VerdictPill stale: desaturates chrome only — the label ink stays --text", () => {
    const stale = renderToStaticMarkup(<VerdictPill decision="pass" stale />);
    const fresh = renderToStaticMarkup(<VerdictPill decision="pass" />);
    expect(stale).toContain("Likely pass"); // the decision label survives, undimmed
    expect(stale).toContain("color:var(--text)"); // label ink untouched (rubric §6)
    expect(stale).toContain("var(--line)"); // the desaturating colour-mix target
    expect(fresh).not.toContain("var(--line)");
  });

  it("Gatekeeper subview STALE: ONE visible banner carries the phrase (no chip)", () => {
    const html = renderToStaticMarkup(
      <GatekeeperView
        verdict={{ ...gk, recruiterNotes: "Solid read." }}
        jobSpec={null}
        mustHaves={[]}
        keywords={{ present: [], missing: [] }}
        fixes={[]}
        stale
        onBack={() => {}}
        onOpenFix={() => {}}
      />,
    );
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1); // the banner, and only the banner
    expect(countOf(html, "Out of date")).toBe(0); // no separate chip in this region
    expect(countOf(html, /re-run/i)).toBe(1); // the phrase's own "re-run" only
  });

  it("Gatekeeper subview FRESH: no banner, no phrase, no re-run copy", () => {
    const html = renderToStaticMarkup(
      <GatekeeperView
        verdict={{ ...gk, recruiterNotes: "Solid read." }}
        jobSpec={null}
        mustHaves={[]}
        keywords={{ present: [], missing: [] }}
        fixes={[]}
        onBack={() => {}}
        onOpenFix={() => {}}
      />,
    );
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(0);
    expect(countOf(html, /re-run/i)).toBe(0);
  });

  it("Gatekeeper subview DRIFTED with NO verdict (GatekeeperEmpty): review-scoped copy, ONE phrase", () => {
    // This subview shows precisely when a drifted run has no verdict to render — the page.tsx call
    // site suppresses a stale gate failure (`!versionDrifted && …gateFailed`), so `drifted` wins —
    // and the copy must reference the REVIEW (there may be no verdict at all), carry the canonical
    // phrase once, and give exactly ONE re-run instruction (the phrase's own).
    const html = renderToStaticMarkup(
      <GatekeeperEmpty reason="drifted" onBack={() => {}} onOpenWorkspace={() => {}} />,
    );
    expect(html).toContain("This review is out of date");
    expect(html).not.toContain("verdict is out of date");
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1);
    expect(countOf(html, /re-run/i)).toBe(1);
  });
});

// --- Explicit row states on Gatekeeper fixes (ADR 0016 / ADR 0014 resolvedAnchorIds) ---------

describe("gatekeeperFixes (explicit row states)", () => {
  const editableIds = editableBulletIds(bundle.cv);
  const gkThread = (over: Partial<Schemas["Thread"]> = {}): Schemas["Thread"] => ({
    anchorId: "b-acme-edi",
    anchorKind: "bullet",
    comment: "Quantify the win.",
    severity: "minor",
    ...over,
  });
  const bundleWith = (
    threads: Schemas["Thread"][],
    resolvedAnchorIds: string[] = [],
  ): Schemas["ReviewBundle"] => ({
    cvVersion: 3,
    failures: [],
    resolvedAnchorIds,
    gatekeeper: { ...gk, threads },
  });
  const fixesOf = (
    b: Schemas["ReviewBundle"],
    staleIds: ReadonlySet<string> = new Set(),
    versionDrifted = false,
  ) => gatekeeperFixes(collectThreads(b), bundle.cv, staleIds, editableIds, versionDrifted);

  it("unresolved editable-bullet fix → applicable ('Open in Workspace')", () => {
    const [f] = fixesOf(bundleWith([gkThread()]));
    expect(f?.state).toBe("applicable");
    expect(f?.context.startsWith("Led migration of 40 EDI partners")).toBe(true);
  });

  it("resolved bullet fix → applied (and no longer applicable)", () => {
    const [f] = fixesOf(bundleWith([gkThread()], ["b-acme-edi"]));
    expect(f?.state).toBe("applied");
  });

  it("summary/item anchors → advisory, never applied or applicable", () => {
    const fixes = fixesOf(
      bundleWith([
        gkThread({ anchorId: "summary", anchorKind: "summary" }),
        gkThread({ anchorId: "item-acme", anchorKind: "item" }),
      ]),
    );
    expect(fixes.map((f) => f.state)).toEqual(["advisory", "advisory"]);
  });

  it("cross-kind anchorId collision: a non-bullet thread sharing an applied bulletId is NOT applied", () => {
    // resolvedAnchorIds holds bulletIds only (ADR 0014), but collectThreads marks ANY thread whose
    // anchorId matches as resolved — the builder's anchorKind check keeps the false Applied chip out.
    const fixes = fixesOf(
      bundleWith(
        [gkThread(), gkThread({ anchorId: "b-acme-edi", anchorKind: "item" })],
        ["b-acme-edi"],
      ),
    );
    const bulletFix = fixes.find((f) => f.key.includes(":bullet:"));
    const itemFix = fixes.find((f) => f.key.includes(":item:"));
    expect(bulletFix?.state).toBe("applied");
    expect(itemFix?.state).toBe("advisory");
  });

  it("whole-bullet supersession: EVERY gatekeeper thread on an applied bullet reads applied", () => {
    const fixes = fixesOf(
      bundleWith(
        [gkThread(), gkThread({ comment: "Second critique of the same line." })],
        ["b-acme-edi"],
      ),
    );
    expect(fixes).toHaveLength(2);
    expect(fixes.every((f) => f.state === "applied")).toBe(true);
  });

  it("FRESH review + unsaved draft on the bullet → blocked-dirty, never a dead no-tag row", () => {
    // The bullet is in staleIds (an unsaved draft) but the review is NOT version-drifted — under a
    // fresh review a SAVED-text drift is impossible (a save bumps cv.version), so this block is
    // temporary and the row must say so rather than render tagless under a fresh-looking verdict.
    const [f] = fixesOf(bundleWith([gkThread()]), new Set(["b-acme-edi"]), false);
    expect(f?.state).toBe("blocked-dirty");
  });

  it("DRIFTED review: the blocked bullet fix → stale (the banner-explained no-tag row)", () => {
    const [f] = fixesOf(bundleWith([gkThread()]), new Set(["b-acme-edi"]), true);
    expect(f?.state).toBe("stale");
  });

  it("FRESH education-section bullet anchor → advisory (outside the editable sections, permanently)", () => {
    // editableBulletIds covers work/projects sections only (EDITABLE_SECTIONS in logic.ts) — an
    // education/skills bullet can never be opened in the editor, so its fix is functionally
    // advisory ("edit it in the Workspace yourself"), NOT a dead tagless row on a fresh review.
    const cvWithEduBullet: Schemas["TailoredCV"] = {
      ...bundle.cv,
      sections: bundle.cv.sections.map((s) =>
        s.type === "education"
          ? {
              ...s,
              items: s.items.map((it) => ({
                ...it,
                highlights: [
                  {
                    bulletId: "b-edu-thesis",
                    sourceId: "example-university-thesis",
                    origin: "verbatim" as const,
                    needsSignoff: false,
                    text: "Thesis on EDI protocol interoperability.",
                  },
                ],
              })),
            }
          : s,
      ),
    };
    const eduEditableIds = editableBulletIds(cvWithEduBullet);
    expect(eduEditableIds.has("b-edu-thesis")).toBe(false); // education is not an editable section
    expect(eduEditableIds.has("b-acme-edi")).toBe(true); // …while work bullets are
    const [f] = gatekeeperFixes(
      collectThreads(bundleWith([gkThread({ anchorId: "b-edu-thesis" })])),
      cvWithEduBullet,
      new Set(),
      eduEditableIds,
      false,
    );
    expect(f?.state).toBe("advisory");
    expect(f?.context).toBe("Thesis on EDI protocol interoperability."); // the anchor resolves
  });

  it("filters to gatekeeper threads only", () => {
    const b: Schemas["ReviewBundle"] = {
      cvVersion: 3,
      failures: [],
      resolvedAnchorIds: [],
      editor: { overall: "", threads: [gkThread()] },
      gatekeeper: { ...gk, threads: [gkThread({ anchorId: "b-acme-uptime" })] },
    };
    const fixes = gatekeeperFixes(collectThreads(b), bundle.cv, new Set(), editableIds, false);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.key.startsWith("gatekeeper:")).toBe(true);
  });
});

describe("GatekeeperView fix rows (explicit states, banner-governed)", () => {
  const appliedFix = {
    key: "gatekeeper:bullet:b-acme-edi:0",
    comment: "Quantify the win.",
    context: "Led migration of 40 EDI partners…",
    state: "applied" as const,
  };
  const applicableFix = {
    key: "gatekeeper:bullet:b-acme-uptime:0",
    comment: "Name the SLA.",
    context: "Raised pipeline uptime…",
    state: "applicable" as const,
  };
  const staleFix = {
    key: "gatekeeper:bullet:b-globex-api:0",
    comment: "Sharpen this line.",
    context: "Built the partner API…",
    state: "stale" as const,
  };
  const blockedFix = {
    key: "gatekeeper:bullet:b-globex-api:1",
    comment: "Lead with the metric.",
    context: "Built the partner API…",
    state: "blocked-dirty" as const,
  };
  const advisoryFix = {
    key: "gatekeeper:summary:summary:0",
    comment: "Tighten the summary.",
    context: "Summary",
    state: "advisory" as const,
  };
  const view = (fixes: Parameters<typeof GatekeeperView>[0]["fixes"], stale: boolean) =>
    renderToStaticMarkup(
      <GatekeeperView
        verdict={{ ...gk, recruiterNotes: "Solid read." }}
        jobSpec={null}
        mustHaves={[]}
        keywords={{ present: [], missing: [] }}
        fixes={fixes}
        stale={stale}
        onBack={() => {}}
        onOpenFix={() => {}}
      />,
    );

  it("FRESH applied row: ✓ Applied chip, NO 'Open in Workspace' on that row; sub-copy + srOnly carry the tail", () => {
    const html = view([appliedFix], false);
    expect(countOf(html, "Open in Workspace")).toBe(0); // the applied row loses the CTA
    expect(countOf(html, "Applied")).toBe(2); // the aria-hidden chip label + the srOnly text
    expect(html).toContain("1 applied — re-run Review to re-check."); // the sub-copy with its tail
    expect(html).toContain("Applied — re-run Review to re-check"); // the row's srOnly (banner absent)
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(0);
    // 2 = the sub-copy tail + the srOnly tail (no banner in the fresh state).
    expect(countOf(html, /re-run/i)).toBe(2);
  });

  it("STALE: the banner is the ONLY re-run carrier — the sub-copy drops its tail, srOnly is just 'Applied'", () => {
    const html = view([appliedFix, applicableFix], true);
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1); // the banner
    expect(html).toContain("1 applied."); // tail dropped
    expect(html).not.toContain("Applied — re-run Review to re-check"); // srOnly collapses to "Applied"
    expect(countOf(html, "Open in Workspace")).toBe(1); // the applicable row keeps its CTA
    expect(countOf(html, /re-run/i)).toBe(1); // the banner phrase only — no per-row re-run spam
  });

  it("a stale bullet-anchored unapplied fix renders NO advisory wording anywhere, any case", () => {
    const html = view([staleFix], true);
    // Case-insensitive: neither the row tag NOR the header guidance may call a stale bullet-anchored
    // unapplied fix advisory — "Advisory" derives strictly from `state === "advisory"`. The stale
    // row is tagless BY DESIGN here: `stale` is only reachable drifted, so the banner explains it.
    expect(countOf(html, /advisory/i)).toBe(0);
    expect(countOf(html, "Applied")).toBe(0);
    expect(countOf(html, "Open in Workspace")).toBe(0);
    expect(countOf(html, "Save your edits first")).toBe(0); // stale ≠ blocked-dirty
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(1); // the banner IS co-present
  });

  it("FRESH blocked-dirty row: 'Save your edits first' microcopy — never a dead unexplained row", () => {
    const html = view([blockedFix], false);
    expect(countOf(html, "Save your edits first")).toBe(1); // the row explains itself
    // Not counted actionable/advisory/applied — no header guidance fires for it…
    expect(html).not.toContain("Open a flagged bullet");
    expect(countOf(html, /advisory/i)).toBe(0);
    expect(countOf(html, "Applied")).toBe(0);
    expect(countOf(html, "Open in Workspace")).toBe(0);
    // …and the fresh card stays banner- and re-run-free (the microcopy carries no re-run copy).
    expect(countOf(html, STALE_REVIEW_PHRASE)).toBe(0);
    expect(countOf(html, /re-run/i)).toBe(0);
  });

  it("mixed applicable + blocked-dirty (fresh): the nudge counts ONLY the applicable row", () => {
    const html = view([applicableFix, blockedFix], false);
    expect(html).toContain("Open a flagged bullet in the Workspace to accept the rewrite.");
    expect(countOf(html, "Open in Workspace")).toBe(1); // the blocked row gets no CTA
    expect(countOf(html, "Save your edits first")).toBe(1);
  });

  it("all-advisory card: the blanket guidance is allowed (every row IS advisory)", () => {
    const html = view([advisoryFix], false);
    expect(html).toContain("These are advisory — edit them in the Workspace.");
  });

  it("mixed advisory + stale rows: count-scoped guidance, never the blanket 'These…'", () => {
    const html = view([advisoryFix, staleFix], true);
    expect(html).toContain("1 advisory — edit it in the Workspace.");
    expect(html).not.toContain("These are advisory");
    // Exactly two case-insensitive hits: the advisory row's own tag + the count-scoped guidance —
    // nothing describes the stale (banner-explained) row.
    expect(countOf(html, /advisory/i)).toBe(2);
  });

  it("MIXED applicable + advisory rows: BOTH sentences render — the accept nudge never masks the advisory guidance", () => {
    const html = view([applicableFix, advisoryFix], false);
    expect(html).toContain("Open a flagged bullet in the Workspace to accept the rewrite.");
    expect(html).toContain("1 advisory — edit it in the Workspace."); // count-scoped, not the blanket
    expect(html).not.toContain("These are advisory");
  });
});
