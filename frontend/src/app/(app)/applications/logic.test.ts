import { describe, expect, it } from "vitest";
import type { Schemas } from "@/lib/api/client";
import {
  applicationLabel,
  applyRequest,
  blockedBulletIds,
  byCvRequest,
  conflictCode,
  deleteApplicationRequest,
  isLikelyEmail,
  isTerminalStage,
  listApplicationsRequest,
  moveOptions,
  pipelineDots,
  readApplicationRequest,
  stageShort,
  stageSummary,
  stageTitle,
  stageTone,
  trackerCounts,
  updateRecruiterRequest,
  updateStageRequest,
} from "./logic";

const summary = (
  over: Partial<Schemas["ApplicationSummary"]> = {},
): Schemas["ApplicationSummary"] => ({
  id: "a1",
  jobTitle: "Staff Engineer",
  company: "Acme",
  stage: "applied",
  appliedAt: "2026-06-26T00:00:00+00:00",
  cvId: "cv1",
  ...over,
});

describe("request builders", () => {
  it("apply posts the body to the workspace applications collection", () => {
    const call = applyRequest({ cvId: "cv1", baseVersion: 2, jobTitle: "PM" });
    expect(call.path).toBe("/workspaces/default/applications");
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      cvId: "cv1",
      baseVersion: 2,
      jobTitle: "PM",
    });
  });

  it("list / read / by-cv are GETs on the right paths", () => {
    expect(listApplicationsRequest().path).toBe("/workspaces/default/applications");
    expect(readApplicationRequest("a1").path).toBe("/workspaces/default/applications/a1");
    expect(byCvRequest("cv1").path).toBe("/workspaces/default/applications/by-cv/cv1");
  });

  it("stage update PATCHes and delete DELETEs", () => {
    const patch = updateStageRequest("a1", { stage: "interview", note: "call booked" });
    expect(patch.path).toBe("/workspaces/default/applications/a1/stage");
    expect(patch.init?.method).toBe("PATCH");
    const del = deleteApplicationRequest("a1");
    expect(del.init?.method).toBe("DELETE");
  });

  it("encodes ids and a custom workspace", () => {
    expect(byCvRequest("cv/1", "ws 2").path).toBe("/workspaces/ws%202/applications/by-cv/cv%2F1");
  });

  it("recruiter update PATCHes both camelCase keys to the /recruiter path", () => {
    const req = updateRecruiterRequest("a1", {
      recruiterName: "Dana",
      recruiterEmail: "d@acme.test",
    });
    expect(req.path).toBe("/workspaces/default/applications/a1/recruiter");
    expect(req.init?.method).toBe("PATCH");
    // Both keys are always sent (full-replace); a stringified body carries the camelCase names.
    expect(JSON.parse(String(req.init?.body))).toEqual({
      recruiterName: "Dana",
      recruiterEmail: "d@acme.test",
    });
  });
});

describe("isLikelyEmail (mirrors the backend _RECRUITER_EMAIL_RE)", () => {
  it("accepts plausible addresses (must stay a subset of the backend rule)", () => {
    for (const ok of [
      "a@example.test",
      "first.last@sub.example.com",
      "x+tag@example.test",
      " trim@example.test ",
    ]) {
      expect(isLikelyEmail(ok)).toBe(true);
    }
  });
  it("rejects blanks, missing parts, whitespace, and a dot-less domain", () => {
    for (const bad of [
      "",
      "   ",
      "no-at",
      "a@b",
      "a@@example.test",
      "a b@example.test",
      "@example.test",
      "a@.test",
    ]) {
      expect(isLikelyEmail(bad)).toBe(false);
    }
  });
  it("rejects URI/mailto metacharacters (no mailto-header injection)", () => {
    for (const bad of [
      "hr@example.test?bcc=x@example.test",
      "a@example.test#frag",
      "a@example.test,c@example.test",
      "a@example.test&x=1",
    ]) {
      expect(isLikelyEmail(bad)).toBe(false);
    }
  });
});

describe("selectors", () => {
  it("labels with company when present, else the title alone", () => {
    expect(applicationLabel(summary())).toBe("Acme — Staff Engineer");
    expect(applicationLabel(summary({ company: null }))).toBe("Staff Engineer");
  });
});

describe("409 body parsing", () => {
  it("reads the conflict code from a {code} body", () => {
    expect(conflictCode(JSON.stringify({ code: "stale", detail: "x" }))).toBe("stale");
    expect(conflictCode(JSON.stringify({ code: "cvLocked" }))).toBe("cvLocked");
  });

  it("returns null for a non-code body or non-JSON", () => {
    expect(conflictCode(JSON.stringify({ blockedBulletIds: ["b1"] }))).toBeNull();
    expect(conflictCode("Workspace owner only")).toBeNull();
  });

  it("reads blocked bullet ids from the needs-sign-off body", () => {
    expect(blockedBulletIds(JSON.stringify({ blockedBulletIds: ["b1", "b2"] }))).toEqual([
      "b1",
      "b2",
    ]);
    expect(blockedBulletIds("not json")).toEqual([]);
  });
});

describe("stage pipeline model", () => {
  it("labels stages short + full, Title-casing unknown ones", () => {
    expect(stageShort("interview")).toBe("Intv");
    expect(stageShort("offer")).toBe("Offer");
    expect(stageTitle("acknowledged")).toBe("Acknowledged");
    expect(stageShort("custom")).toBe("Custom");
    expect(stageTitle("")).toBe("");
  });

  it("classifies terminal stages", () => {
    expect(isTerminalStage("rejected")).toBe(true);
    expect(isTerminalStage("withdrawn")).toBe(true);
    expect(isTerminalStage("offer")).toBe(false);
    expect(isTerminalStage("applied")).toBe(false);
  });

  it("tones: offer=ok, rejected=bad, withdrawn=muted, else accent", () => {
    expect(stageTone("offer")).toBe("ok");
    expect(stageTone("rejected")).toBe("bad");
    expect(stageTone("withdrawn")).toBe("muted");
    expect(stageTone("screen")).toBe("accent");
  });

  it("builds collapsed dots from the current stage (done up to it, that one current)", () => {
    const dots = pipelineDots("screen");
    expect(dots.map((d) => d.key)).toEqual([
      "applied",
      "acknowledged",
      "screen",
      "interview",
      "final",
      "offer",
    ]);
    expect(dots.map((d) => d.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
      "pending",
      "pending",
    ]);
    // The offer dot keeps its success tone even while pending.
    expect(dots[5]).toMatchObject({ tone: "ok", name: "Offer", short: "Offer" });
  });

  it("shows an all-pending pipeline for a terminal stage (badge carries the state)", () => {
    expect(pipelineDots("rejected").every((d) => d.state === "pending")).toBe(true);
    expect(pipelineDots("withdrawn").every((d) => d.state === "pending")).toBe(true);
  });

  it("marks the current dot as the first one when at 'applied'", () => {
    expect(pipelineDots("applied").map((d) => d.state)).toEqual([
      "current",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("splits move options into ordered progress + terminal, flagging the active one", () => {
    const stages = [
      "applied",
      "acknowledged",
      "screen",
      "interview",
      "final",
      "offer",
      "rejected",
      "withdrawn",
    ];
    const { progress, terminal } = moveOptions(stages, "interview");
    expect(progress.map((o) => o.stage)).toEqual([
      "applied",
      "acknowledged",
      "screen",
      "interview",
      "final",
      "offer",
    ]);
    expect(terminal.map((o) => o.stage)).toEqual(["rejected", "withdrawn"]);
    expect(progress.find((o) => o.stage === "interview")?.active).toBe(true);
    expect(progress.find((o) => o.stage === "screen")?.active).toBe(false);
    expect(progress[0]).toMatchObject({ label: "Applied", tone: "accent" });
    expect(terminal[0]).toMatchObject({ label: "Rejected", tone: "bad" });
  });

  it("counts total + active (non-terminal) applications", () => {
    expect(trackerCounts([{ stage: "screen" }, { stage: "rejected" }, { stage: "offer" }])).toEqual(
      { total: 3, active: 2 },
    );
    expect(trackerCounts([])).toEqual({ total: 0, active: 0 });
  });

  it("summarises the stage position, closing out terminal applications", () => {
    expect(stageSummary("applied")).toBe("Stage 1 of 6 · Applied");
    expect(stageSummary("offer")).toBe("Stage 6 of 6 · Offer");
    expect(stageSummary("rejected")).toBe("Rejected · closed");
    expect(stageSummary("withdrawn")).toBe("Withdrawn · closed");
  });

  it("counts the denominator from the application's own progress stages", () => {
    // A custom pipeline (fewer progress stages + a terminal) counts correctly off `stages`.
    expect(stageSummary("screen", ["applied", "screen", "offer", "rejected"])).toBe(
      "Stage 2 of 3 · Screen",
    );
  });
});
