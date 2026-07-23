/**
 * A deterministic sample {master, cv} for the /print/sample route and the renderer determinism
 * tests. Placeholder data only — never a real CV (security: no real personal data in the repo).
 * Includes a net-new bullet (needsSignoff) so later phases exercise the sign-off gate.
 */
import type { components } from "@/lib/api/generated-types";
import type { RenderInput } from "./model";

type MasterProfile = components["schemas"]["MasterProfile"];
type TailoredCV = components["schemas"]["TailoredCV"];

const master: MasterProfile = {
  schemaVersion: "1",
  basics: {
    name: "Sample Candidate",
    label: "Senior Integration Engineer",
    email: "sample@example.com",
    phone: "+00 000 000 000",
    url: "https://example.com",
    location: { city: "Example City", region: "Example Region", countryCode: "ZZ" },
    profiles: [{ network: "Portfolio", url: "https://example.com/profile" }],
    summary: "Master summary (not rendered; the tailored summary is used).",
  },
  work: [
    {
      id: "acme-integration-lead",
      company: "Acme Logistics",
      position: "Integration Lead",
      startDate: "2021",
      endDate: undefined,
      highlights: [
        { id: "acme-edi", text: "Led migration of 40 EDI partners to a new platform." },
        { id: "acme-uptime", text: "Raised pipeline uptime to 99.9% across 12 markets." },
      ],
      tags: ["integration", "edi"],
    },
    {
      id: "globex-engineer",
      company: "Globex",
      position: "Systems Engineer",
      startDate: "2018",
      endDate: "2021",
      highlights: [{ id: "globex-api", text: "Built the partner API used by 200+ integrations." }],
      tags: ["api"],
    },
  ],
  education: [
    {
      id: "example-university-bsc",
      institution: "Example University",
      area: "Computer Science",
      studyType: "BSc",
      startDate: "2014",
      endDate: "2018",
    },
  ],
  skills: [
    { name: "EDI / AS2", keywords: [] },
    { name: "Python", keywords: [] },
    { name: "TypeScript", keywords: [] },
    { name: "Postgres", keywords: [] },
  ],
  languages: [
    { language: "English", fluency: "Native" },
    { language: "French", fluency: "Native" },
    { language: "German", fluency: "Professional working" },
  ],
  certificates: null,
};

const cv: TailoredCV = {
  jobSpecRef: "sample-job",
  masterVersion: "1",
  version: 1,
  parentVersion: null,
  summary:
    "Senior integration engineer who ships reliable partner pipelines — 40+ EDI migrations and a partner API at scale.",
  sections: [
    {
      sectionId: "sec-experience",
      type: "work",
      items: [
        {
          itemId: "item-acme",
          sourceId: "acme-integration-lead",
          position: null,
          company: null,
          highlights: [
            {
              bulletId: "b-acme-edi",
              sourceId: "acme-edi",
              origin: "reworded",
              needsSignoff: false,
              text: "Led migration of 40 EDI partners to a new platform, cutting onboarding time in half.",
            },
            {
              bulletId: "b-acme-uptime",
              sourceId: "acme-uptime",
              origin: "verbatim",
              needsSignoff: false,
              text: "Raised pipeline uptime to 99.9% across 12 markets.",
            },
            {
              bulletId: "b-acme-netnew",
              sourceId: null,
              origin: "net-new",
              needsSignoff: true,
              text: "Owned the SLA dashboard the leadership team reviewed weekly.",
            },
          ],
        },
        {
          itemId: "item-globex",
          sourceId: "globex-engineer",
          position: null,
          company: null,
          highlights: [
            {
              bulletId: "b-globex-api",
              sourceId: "globex-api",
              origin: "verbatim",
              needsSignoff: false,
              text: "Built the partner API used by 200+ integrations.",
            },
          ],
        },
      ],
    },
    {
      sectionId: "sec-skills",
      type: "skills",
      items: [],
    },
    {
      sectionId: "sec-education",
      type: "education",
      items: [
        {
          itemId: "item-edu",
          sourceId: "example-university-bsc",
          position: null,
          company: null,
          highlights: [],
        },
      ],
    },
  ],
};

export const sampleRenderInput: RenderInput = { master, cv };

/**
 * The bundled `sample` demo input (offline determinism + the design reference). Callers route the
 * `sample` id here; any real id fetches the gate-checked bundle via `getRenderBundle` (render/fetch.ts).
 */
export function getRenderInput(): RenderInput {
  return sampleRenderInput;
}
