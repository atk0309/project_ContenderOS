import { describe, expect, it } from "vitest";
import type { Schemas } from "@/lib/api/client";
import {
  acceptedCount,
  agentLabel,
  applyRunRequest,
  bulkDecideRequest,
  decideProposalRequest,
  dirtyNetNewPendingProposalIds,
  dirtyPendingProposalIds,
  discardRunRequest,
  draftToContent,
  editedContent,
  effectiveContent,
  emptyChecklist,
  extractedNothing,
  getRunRequest,
  hasPendingUpdateProposals,
  ingestErrorMessage,
  isFileTooLarge,
  isPdfFile,
  isProposalDirty,
  joinRecommended,
  judgeUnavailable,
  listRunsRequest,
  MAX_UPLOAD_BYTES,
  netNewPendingCount,
  netNewPendingItems,
  openRun,
  orderedProposals,
  type ProposalDraft,
  parseDetail,
  parseSseFrame,
  pendingCount,
  proposalVerdictLabel,
  proposalVerdictReason,
  recommendedMissing,
  reduceChecklist,
  relationshipLabel,
  type SseEvent,
  seedDraft,
  splitSseFrames,
  streamIngestRequest,
  unitKindLabel,
  uploadStreamRequest,
  VERDICT_FALLBACK_REASON,
  verdictLabel,
} from "./logic";

type Proposal = Schemas["IngestionProposal"];
type IngestRun = Schemas["IngestionRun"];
type ProposalContent = Schemas["ProposalContent"];

const body = (init?: RequestInit): Record<string, unknown> => {
  expect(typeof init?.body).toBe("string");
  return JSON.parse(init?.body as string);
};

function proposal(over: Partial<Proposal> & Pick<Proposal, "unitKind" | "content">): Proposal {
  return {
    proposalId: over.proposalId ?? "p1",
    unitKind: over.unitKind,
    summary: over.summary ?? "summary",
    content: over.content,
    edited: over.edited ?? null,
    evidence: over.evidence ?? { snippet: "snip", verified: true },
    status: over.status ?? "pending",
    version: over.version ?? 1,
    appliedMasterId: over.appliedMasterId ?? null,
    relationship: over.relationship ?? "net-new",
    targetWorkId: over.targetWorkId ?? null,
    targetLabel: over.targetLabel ?? null,
    currentValue: over.currentValue ?? null,
    decision: over.decision ?? null,
  };
}

function run(over: Partial<IngestRun> & Pick<IngestRun, "id" | "status">): IngestRun {
  return {
    id: over.id,
    status: over.status,
    sourceType: over.sourceType ?? "pasted",
    filename: over.filename ?? null,
    failureKind: over.failureKind ?? null,
    failureReason: over.failureReason ?? null,
    createdAt: over.createdAt ?? "2026-06-24T00:00:00Z",
    updatedAt: over.updatedAt ?? "2026-06-24T00:00:00Z",
  };
}

const workContent: ProposalContent = {
  work: {
    company: "Acme",
    position: "Engineer",
    startDate: "2019-01",
    endDate: "2022-06",
    highlights: ["Led k8s migration", "Cut build time 40%"],
    tags: ["platform", "infra"],
    evidence: "verbatim source span",
  },
};

describe("request builders", () => {
  it("builds the list (GET, no body) and read calls", () => {
    expect(listRunsRequest().path).toBe("/workspaces/default/ingest");
    expect(listRunsRequest().init).toBeUndefined();
    expect(getRunRequest("run1").path).toBe("/workspaces/default/ingest/run1");
  });

  it("builds the per-proposal decide call and URL-encodes ids", () => {
    const c = decideProposalRequest("run/1", "p#2", {
      action: "accept",
      baseVersion: 3,
      edited: null,
    });
    expect(c.path).toBe("/workspaces/default/ingest/run%2F1/proposals/p%232");
    expect(body(c.init)).toEqual({ action: "accept", baseVersion: 3, edited: null });
  });

  it("builds the bulk decide call", () => {
    const items = [{ proposalId: "a", baseVersion: 1 }];
    const c = bulkDecideRequest("run1", items, "accept");
    expect(c.path).toBe("/workspaces/default/ingest/run1/decide");
    expect(body(c.init)).toEqual({ items, action: "accept" });
  });

  it("builds the apply and discard calls (POST, no body)", () => {
    expect(applyRunRequest("run1").path).toBe("/workspaces/default/ingest/run1/apply");
    expect(applyRunRequest("run1").init?.method).toBe("POST");
    expect(discardRunRequest("run1").path).toBe("/workspaces/default/ingest/run1/discard");
  });
});

describe("run + proposal selectors", () => {
  it("finds the single open run (review/extracting/reconciling), else null", () => {
    expect(
      openRun([run({ id: "a", status: "applied" }), run({ id: "b", status: "review" })])?.id,
    ).toBe("b");
    expect(openRun([run({ id: "a", status: "extracting" })])?.id).toBe("a");
    expect(
      openRun([run({ id: "a", status: "applied" }), run({ id: "b", status: "discarded" })]),
    ).toBeNull();
  });

  it("counts by status (a declined proposal counts as neither pending nor accepted)", () => {
    const ps = [
      proposal({
        proposalId: "a",
        unitKind: "skill",
        content: { skill: { name: "Go", level: null, keywords: [], evidence: "" } },
        status: "pending",
        version: 2,
      }),
      proposal({ proposalId: "b", unitKind: "work", content: workContent, status: "accepted" }),
      proposal({ proposalId: "c", unitKind: "work", content: workContent, status: "declined" }),
    ];
    expect(pendingCount(ps)).toBe(1);
    expect(acceptedCount(ps)).toBe(1);
  });

  it("scopes 'add all new items' to net-new pending proposals", () => {
    const ps = [
      proposal({
        proposalId: "n",
        unitKind: "work",
        content: workContent,
        status: "pending",
        version: 3,
      }),
      proposal({
        proposalId: "e",
        unitKind: "highlight",
        content: { highlight: { text: "A bullet" } },
        status: "pending",
        relationship: "enrich",
      }),
      proposal({
        proposalId: "c",
        unitKind: "basics-field",
        content: { field: { fieldPath: "basics.name", value: "X" } },
        status: "pending",
        relationship: "correction",
      }),
    ];
    expect(netNewPendingCount(ps)).toBe(1); // enrich + correction excluded
    expect(netNewPendingItems(ps)).toEqual([{ proposalId: "n", baseVersion: 3 }]);
  });

  it("hasPendingUpdateProposals is true only while a pending enrich/correction remains", () => {
    // First import: all net-new, all accepted -> no pending update -> helper must hide
    // (the "already in your master" copy is false when no master exists yet).
    const firstImportAccepted = [
      proposal({
        proposalId: "a",
        unitKind: "basics-field",
        content: { field: { fieldPath: "basics.name", value: "X" } },
        status: "accepted",
      }),
      proposal({ proposalId: "b", unitKind: "work", content: workContent, status: "accepted" }),
    ];
    expect(hasPendingUpdateProposals(firstImportAccepted)).toBe(false);

    // Re-import: a pending enrich remains -> helper shows (it still informs).
    const enrichPending = [
      proposal({
        proposalId: "e",
        unitKind: "highlight",
        content: { highlight: { text: "A bullet" } },
        status: "pending",
        relationship: "enrich",
      }),
    ];
    expect(hasPendingUpdateProposals(enrichPending)).toBe(true);

    // Re-import: every enrich/correction already decided -> helper hides (nothing left to review).
    const updatesDecided = [
      proposal({
        proposalId: "e",
        unitKind: "highlight",
        content: { highlight: { text: "A bullet" } },
        status: "accepted",
        relationship: "enrich",
      }),
      proposal({
        proposalId: "c",
        unitKind: "basics-field",
        content: { field: { fieldPath: "basics.name", value: "X" } },
        status: "declined",
        relationship: "correction",
      }),
    ];
    expect(hasPendingUpdateProposals(updatesDecided)).toBe(false);
  });

  it("flags a review run with zero proposals as 'extracted nothing'", () => {
    expect(extractedNothing({ run: run({ id: "a", status: "review" }), proposals: [] })).toBe(true);
    expect(
      extractedNothing({
        run: run({ id: "a", status: "review" }),
        proposals: [proposal({ unitKind: "work", content: workContent })],
      }),
    ).toBe(false);
    expect(extractedNothing({ run: run({ id: "a", status: "applied" }), proposals: [] })).toBe(
      false,
    );
  });

  it("preserves input order regardless of status (stable identity, never re-sort by status)", () => {
    const ps = [
      proposal({ proposalId: "first", unitKind: "work", content: workContent, status: "accepted" }),
      proposal({ proposalId: "second", unitKind: "work", content: workContent, status: "pending" }),
      proposal({ proposalId: "third", unitKind: "work", content: workContent, status: "declined" }),
    ];
    expect(
      orderedProposals({ run: run({ id: "a", status: "review" }), proposals: ps }).map(
        (p) => p.proposalId,
      ),
    ).toEqual(["first", "second", "third"]);
  });
});

describe("structured edit round-trip", () => {
  it("round-trips a work proposal: list split/trim/empty-drop, endDate, preserved evidence", () => {
    const p = proposal({ unitKind: "work", content: workContent });
    const draft = seedDraft(p);
    expect(draft).toMatchObject({
      kind: "work",
      company: "Acme",
      highlights: "Led k8s migration\nCut build time 40%",
      tags: "platform, infra",
      endDate: "2022-06",
    });
    // A round-trip with messy whitespace normalises back to the same content.
    const messy: ProposalDraft = {
      ...(draft as Extract<ProposalDraft, { kind: "work" }>),
      highlights: " Led k8s migration \n\n Cut build time 40% \n",
    };
    expect(draftToContent(messy, p.content)).toEqual(workContent);
  });

  it("keeps the immutable basics fieldPath through the round-trip (the allowlist key)", () => {
    const p = proposal({
      unitKind: "basics-field",
      content: { field: { fieldPath: "basics.location.countryCode", value: "GB" } },
    });
    const draft = seedDraft(p);
    expect(draft).toEqual({
      kind: "basics-field",
      fieldPath: "basics.location.countryCode",
      value: "GB",
    });
    const edited = { ...(draft as Extract<ProposalDraft, { kind: "basics-field" }>), value: "US" };
    expect(draftToContent(edited, p.content)).toEqual({
      field: { fieldPath: "basics.location.countryCode", value: "US" },
    });
  });

  it("maps an empty endDate/level back to null", () => {
    const p = proposal({
      unitKind: "skill",
      content: { skill: { name: "Go", level: "expert", keywords: ["a"], evidence: "" } },
    });
    const draft = { ...(seedDraft(p) as Extract<ProposalDraft, { kind: "skill" }>), level: "  " };
    expect(draftToContent(draft, p.content)).toEqual({
      skill: { name: "Go", level: null, keywords: ["a"], evidence: "" },
    });
  });

  it("round-trips a language proposal: seeds name + fluency, blank fluency → null (D2a)", () => {
    const p = proposal({
      unitKind: "language",
      content: { language: { language: "German", fluency: "B2", evidence: "German B2" } },
    });
    expect(seedDraft(p)).toEqual({ kind: "language", language: "German", fluency: "B2" });
    const draft = {
      ...(seedDraft(p) as Extract<ProposalDraft, { kind: "language" }>),
      fluency: "  ",
    };
    expect(draftToContent(draft, p.content)).toEqual({
      language: { language: "German", fluency: null, evidence: "German B2" },
    });
  });

  it("seeds from a prior saved edit, not the original extraction", () => {
    const p = proposal({
      unitKind: "basics-field",
      content: { field: { fieldPath: "basics.name", value: "John" } },
      edited: { field: { fieldPath: "basics.name", value: "Jonathan" } },
    });
    expect(effectiveContent(p)).toEqual(p.edited);
    expect(seedDraft(p)).toEqual({
      kind: "basics-field",
      fieldPath: "basics.name",
      value: "Jonathan",
    });
  });
});

describe("dirtiness + edited payload", () => {
  it("is not dirty for an unchanged draft (incl. re-joined lists), dirty after a real change", () => {
    const p = proposal({ unitKind: "work", content: workContent });
    expect(isProposalDirty(p, seedDraft(p))).toBe(false);
    const changed = {
      ...(seedDraft(p) as Extract<ProposalDraft, { kind: "work" }>),
      company: "Globex",
    };
    expect(isProposalDirty(p, changed)).toBe(true);
  });

  it("is not dirty vs a prior saved edit", () => {
    const p = proposal({
      unitKind: "basics-field",
      content: { field: { fieldPath: "basics.name", value: "John" } },
      edited: { field: { fieldPath: "basics.name", value: "Jonathan" } },
    });
    expect(isProposalDirty(p, seedDraft(p))).toBe(false);
  });

  it("editedContent returns undefined when clean and the new content when dirty", () => {
    const p = proposal({ unitKind: "work", content: workContent });
    expect(editedContent(p, undefined)).toBeUndefined();
    expect(editedContent(p, seedDraft(p))).toBeUndefined();
    const changed = {
      ...(seedDraft(p) as Extract<ProposalDraft, { kind: "work" }>),
      position: "Staff Engineer",
    };
    expect(editedContent(p, changed)?.work?.position).toBe("Staff Engineer");
  });

  it("dirtyPendingProposalIds flags only pending proposals with unsaved edits", () => {
    const p1 = proposal({
      proposalId: "p1",
      unitKind: "work",
      content: workContent,
      status: "pending",
    });
    const p2 = proposal({
      proposalId: "p2",
      unitKind: "work",
      content: workContent,
      status: "accepted",
    });
    const dirty = {
      ...(seedDraft(p1) as Extract<ProposalDraft, { kind: "work" }>),
      company: "Globex",
    };
    // p1 dirty+pending → flagged; p2 dirty but accepted → not flagged; clean draft → not flagged.
    expect(dirtyPendingProposalIds([p1, p2], { p1: dirty, p2: dirty })).toEqual(["p1"]);
    expect(dirtyPendingProposalIds([p1], { p1: seedDraft(p1) })).toEqual([]);
    expect(dirtyPendingProposalIds([p1], {})).toEqual([]);
  });

  it("dirtyNetNewPendingProposalIds ignores dirty enrich/correction (bulk add is net-new only)", () => {
    const netNew = proposal({
      proposalId: "n",
      unitKind: "work",
      content: workContent,
      status: "pending",
    });
    const enrich = proposal({
      proposalId: "e",
      unitKind: "highlight",
      content: { highlight: { text: "A bullet" } },
      status: "pending",
      relationship: "enrich",
    });
    const dirtyNet = {
      ...(seedDraft(netNew) as Extract<ProposalDraft, { kind: "work" }>),
      company: "Globex",
    };
    const dirtyEnrich = { kind: "highlight" as const, text: "edited bullet" };
    expect(
      dirtyNetNewPendingProposalIds([netNew, enrich], { n: dirtyNet, e: dirtyEnrich }),
    ).toEqual(["n"]); // the dirty enrich is NOT a bulk-add blocker
  });
});

describe("display + error helpers", () => {
  it("labels unit kinds for the UI", () => {
    expect(unitKindLabel("basics-field")).toBe("Detail");
    expect(unitKindLabel("work")).toBe("Work");
  });

  it("labels a relationship in plain language (net-new gets no extra badge)", () => {
    expect(relationshipLabel("net-new")).toBeNull();
    expect(relationshipLabel("enrich")).toBe("Adds to an existing role");
    expect(relationshipLabel("correction")).toBe("Updates a detail");
  });

  it("labels an advisory verdict in plain language (include suppressed)", () => {
    expect(verdictLabel("include")).toBeNull();
    expect(verdictLabel("needs-review")).toBe("Worth a look");
    expect(verdictLabel("exclude")).toBe("Suggested skip");
  });

  it("suppresses a card verdict for include, no decision, and the Judge-unavailable marker", () => {
    const decided = (verdict: Schemas["IngestVerdict"], reason: string) =>
      proposal({ unitKind: "work", content: workContent, decision: { verdict, reason } });
    expect(proposalVerdictLabel(decided("exclude", "noise"))).toBe("Suggested skip");
    expect(proposalVerdictLabel(decided("include", ""))).toBeNull();
    expect(proposalVerdictLabel(decided("needs-review", "suggestions unavailable"))).toBeNull();
    expect(proposalVerdictLabel(proposal({ unitKind: "work", content: workContent }))).toBeNull();
  });

  it("surfaces a verdict reason, with a generic fallback when the Judge gave none", () => {
    const decided = (verdict: Schemas["IngestVerdict"], reason: string) =>
      proposal({ unitKind: "work", content: workContent, decision: { verdict, reason } });
    // The Judge's own phrase shows verbatim.
    expect(proposalVerdictReason(decided("needs-review", "Overlaps your Acme role"))).toBe(
      "Overlaps your Acme role",
    );
    // Empty / whitespace-only reason on a flagged item falls back — never a dangling blank line.
    expect(proposalVerdictReason(decided("needs-review", ""))).toBe(VERDICT_FALLBACK_REASON);
    expect(proposalVerdictReason(decided("exclude", "   "))).toBe(VERDICT_FALLBACK_REASON);
    // Suppressed exactly where the badge is: include, the unavailable marker, and no decision.
    expect(proposalVerdictReason(decided("include", "looks good"))).toBeNull();
    expect(proposalVerdictReason(decided("needs-review", "suggestions unavailable"))).toBeNull();
    expect(proposalVerdictReason(proposal({ unitKind: "work", content: workContent }))).toBeNull();
  });

  it("flags a run where the advisory Judge was unavailable (every decision degraded)", () => {
    const degraded = proposal({
      unitKind: "work",
      content: workContent,
      decision: { verdict: "needs-review", reason: "suggestions unavailable" },
    });
    const judged = proposal({
      unitKind: "work",
      content: workContent,
      decision: { verdict: "include", reason: "" },
    });
    expect(judgeUnavailable([degraded])).toBe(true);
    expect(judgeUnavailable([degraded, judged])).toBe(false); // not ALL degraded
    expect(judgeUnavailable([proposal({ unitKind: "work", content: workContent })])).toBe(false);
  });

  it("parses a FastAPI {detail} body out of a raw ApiError message, else returns it raw", () => {
    expect(
      parseDetail('{"detail":"the imported profile is missing required fields: basics.phone"}'),
    ).toBe("the imported profile is missing required fields: basics.phone");
    expect(parseDetail("plain text error")).toBe("plain text error");
  });
});

describe("recommended basics nudge", () => {
  const basics = (over: Partial<Schemas["Basics"]> = {}): Schemas["Basics"] => ({
    name: "Jane",
    email: "jane@example.com",
    label: "",
    phone: "",
    url: null,
    location: { city: "", region: "", countryCode: "" },
    profiles: [],
    summary: "",
    ...over,
  });

  it("joins recommended labels with one article and no Oxford comma", () => {
    expect(joinRecommended([])).toBeNull();
    expect(joinRecommended(["summary"])).toBe("a summary");
    expect(joinRecommended(["headline", "summary"])).toBe("a headline and summary");
    expect(joinRecommended(["headline", "phone number", "location", "summary"])).toBe(
      "a headline, phone number, location and summary",
    );
  });

  it("lists only the empty recommended basics, in display order", () => {
    expect(recommendedMissing(basics())).toEqual([
      "headline",
      "phone number",
      "location",
      "summary",
    ]);
    expect(
      recommendedMissing(
        basics({
          label: "Engineer",
          phone: "123",
          location: { city: "Example City", region: "", countryCode: "" },
          summary: "About me",
        }),
      ),
    ).toEqual([]);
  });

  it("keys location on city||region — a country-only address still nudges", () => {
    expect(
      recommendedMissing(basics({ location: { city: "", region: "", countryCode: "ZZ" } })),
    ).toContain("location");
    expect(
      recommendedMissing(
        basics({ location: { city: "Example City", region: "", countryCode: "" } }),
      ),
    ).not.toContain("location");
    // whitespace counts as empty
    expect(recommendedMissing(basics({ label: "  ", summary: "x" }))).toEqual([
      "headline",
      "phone number",
      "location",
    ]);
  });
});

describe("PDF upload (PR-C)", () => {
  it("recognises a PDF by MIME type OR a .pdf extension (octet-stream fallback)", () => {
    expect(isPdfFile({ type: "application/pdf", name: "x" })).toBe(true);
    expect(isPdfFile({ type: "application/octet-stream", name: "Resume.PDF" })).toBe(true);
    expect(isPdfFile({ type: "text/plain", name: "notes.pdf" })).toBe(true);
    expect(isPdfFile({ type: "text/plain", name: "notes.txt" })).toBe(false);
  });

  it("guards size client-side against MAX_UPLOAD_BYTES", () => {
    expect(isFileTooLarge({ size: MAX_UPLOAD_BYTES + 1 })).toBe(true);
    expect(isFileTooLarge({ size: MAX_UPLOAD_BYTES })).toBe(false);
    expect(isFileTooLarge({ size: 1024 })).toBe(false);
  });
});

describe("ingestErrorMessage", () => {
  it("keeps the friendly 503 / 502 copy (behaviour-preserving) and adds 413", () => {
    expect(ingestErrorMessage(503, "")).toContain("Admin");
    expect(ingestErrorMessage(502, "")).toContain("couldn't read");
    expect(ingestErrorMessage(413, "")).toContain("too large");
  });

  it("passes a 422's actionable server detail through (not cannned)", () => {
    expect(ingestErrorMessage(422, '{"detail":"please upload a PDF file"}')).toBe(
      "please upload a PDF file",
    );
    expect(ingestErrorMessage(422, "plain text reason")).toBe("plain text reason");
  });

  it("falls back to a generic message when there's no detail", () => {
    expect(ingestErrorMessage(400, "")).toBe("Request failed.");
  });
});

describe("SSE streaming (F3b)", () => {
  it("stream builders negotiate text/event-stream; paste sets Content-Type, upload does not", () => {
    const paste = streamIngestRequest("cv text", "ws1");
    const ph = new Headers(paste.init?.headers);
    expect(paste.path).toBe("/workspaces/ws1/ingest");
    expect(ph.get("accept")).toBe("text/event-stream");
    expect(ph.get("content-type")).toBe("application/json");
    expect(body(paste.init)).toEqual({ text: "cv text", sourceType: "pasted" });

    const file = new File([new Uint8Array([1, 2, 3])], "cv.pdf", { type: "application/pdf" });
    const upload = uploadStreamRequest(file, "ws1");
    const uh = new Headers(upload.init?.headers);
    expect(upload.path).toBe("/workspaces/ws1/ingest/file");
    expect(uh.get("accept")).toBe("text/event-stream");
    // No content-type — the browser writes the multipart boundary itself.
    expect(uh.get("content-type")).toBeNull();
    const form = upload.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("sourceType")).toBe("cv-pdf");
    expect(form.get("file")).toBeInstanceOf(File);
  });

  it("splitSseFrames returns complete frames and carries the trailing partial", () => {
    const a = splitSseFrames("data: {}\n\ndata: {}\n\ndata: par");
    expect(a.frames).toEqual(["data: {}", "data: {}"]);
    expect(a.rest).toBe("data: par");
    // A buffer with no complete frame yet keeps everything as the partial.
    expect(splitSseFrames("data: half")).toEqual({ frames: [], rest: "data: half" });
  });

  it("parseSseFrame parses data lines, ignores keepalive comments and junk", () => {
    expect(parseSseFrame('data: {"type":"run_done","ok":true,"resultRef":"r1"}')).toEqual({
      type: "run_done",
      ok: true,
      resultRef: "r1",
    });
    // Leading space after `data:` is tolerated.
    expect(parseSseFrame('data:{"type":"agent_started","agentId":"extractor-basics"}')).toEqual({
      type: "agent_started",
      agentId: "extractor-basics",
    });
    expect(parseSseFrame(": keepalive")).toBeNull(); // comment/heartbeat → no event
    expect(parseSseFrame("event: x")).toBeNull(); // no data line
    expect(parseSseFrame("data: not json")).toBeNull();
  });

  it("agentLabel maps canonical ids to plain language; unknown ids get a generic label", () => {
    expect(agentLabel("extractor-work")).toBe("Reading your work history");
    expect(agentLabel("reconciler-work")).toBe("Checking against your master");
    expect(agentLabel("judge")).toBe("Reviewing suggestions");
    expect(agentLabel("something-new")).toBe("Working…");
  });

  it("reduceChecklist appends in first-seen order with last-event-wins status", () => {
    const ev = (e: SseEvent) => e;
    let c = emptyChecklist();
    c = reduceChecklist(c, ev({ type: "agent_started", agentId: "extractor-basics" }));
    c = reduceChecklist(c, ev({ type: "agent_done", agentId: "extractor-basics", ok: true }));
    c = reduceChecklist(c, ev({ type: "agent_started", agentId: "extractor-work" }));
    expect(c.order).toEqual(["extractor-basics", "extractor-work"]);
    expect(c.status["extractor-basics"]).toBe("done");
    expect(c.status["extractor-work"]).toBe("running");
    // run_done leaves the checklist untouched.
    expect(reduceChecklist(c, ev({ type: "run_done", ok: true, resultRef: "r1" }))).toBe(c);
  });

  it("reduceChecklist collapses the native→text fallback retry (failed then re-run → done)", () => {
    const ev = (e: SseEvent) => e;
    let c = emptyChecklist();
    c = reduceChecklist(c, ev({ type: "agent_started", agentId: "extractor-basics" }));
    c = reduceChecklist(
      c,
      ev({ type: "agent_done", agentId: "extractor-basics", ok: false, detail: "BadRequestError" }),
    );
    c = reduceChecklist(c, ev({ type: "agent_started", agentId: "extractor-basics" }));
    c = reduceChecklist(c, ev({ type: "agent_done", agentId: "extractor-basics", ok: true }));
    expect(c.order).toEqual(["extractor-basics"]); // not duplicated
    expect(c.status["extractor-basics"]).toBe("done"); // last-event-wins
  });
});
