/**
 * ResumeDocument -> DOCX, via the `docx` lib, sharing colours + type scale with the template
 * (template-tokens.ts) so it stays in lockstep with the preview/PDF (invariant 3). DOCX is a
 * different medium — structural fidelity, not pixel parity. The document model is deterministic, but
 * `docx`/JSZip stamps the package with wall-clock time, so `.docx` bytes are not yet byte-identical
 * run-to-run (see docs/architecture/renderer.md — ZIP-timestamp normalization is a tracked follow-up).
 */
import { BorderStyle, Document, HeadingLevel, Packer, Paragraph, TabStopType, TextRun } from "docx";
import { formatLanguage, type ResumeDocument } from "./model";
import { DOCX_FONT, docxHalfPoints, PAPER, SIZE } from "./template-tokens";

const INK = PAPER.ink.replace("#", "");
const INK2 = PAPER.ink2.replace("#", "");
const INK3 = PAPER.ink3.replace("#", "");

const hairline = {
  style: BorderStyle.SINGLE,
  size: 6,
  color: PAPER.rule.replace("#", ""),
} as const;

function sectionHeading(title: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 120 },
    border: { bottom: hairline },
    children: [
      new TextRun({
        text: title.toUpperCase(),
        font: DOCX_FONT.ui,
        size: docxHalfPoints(SIZE.sectionTitle),
        bold: true,
        color: INK2,
        characterSpacing: 28,
      }),
    ],
  });
}

export function buildResumeDocx(doc: ResumeDocument): Document {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [
        new TextRun({
          text: doc.header.name,
          font: DOCX_FONT.serif,
          size: docxHalfPoints(SIZE.name),
          bold: true,
          color: INK,
        }),
      ],
    }),
  );
  if (doc.header.title) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: doc.header.title,
            font: DOCX_FONT.serif,
            size: docxHalfPoints(SIZE.title),
            italics: true,
            color: INK2,
          }),
        ],
      }),
    );
  }
  const contact = [doc.header.location, doc.header.email, doc.header.phone, doc.header.link]
    .filter(Boolean)
    .join("  ·  ");
  if (contact) {
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        border: { bottom: hairline },
        children: [
          new TextRun({
            text: contact,
            font: DOCX_FONT.mono,
            size: docxHalfPoints(SIZE.contact),
            color: INK2,
          }),
        ],
      }),
    );
  }

  if (doc.summary) {
    children.push(
      new Paragraph({
        spacing: { before: 160, after: 80 },
        children: [
          new TextRun({
            text: doc.summary,
            font: DOCX_FONT.serif,
            size: docxHalfPoints(SIZE.summary),
            color: INK,
          }),
        ],
      }),
    );
  }

  for (const section of doc.sections) {
    children.push(sectionHeading(section.title));

    if (section.kind === "experience") {
      for (const it of section.items) {
        children.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: 9026 }],
            children: [
              new TextRun({
                text: it.role,
                font: DOCX_FONT.serif,
                size: docxHalfPoints(SIZE.role),
                bold: true,
                color: INK,
              }),
              ...(it.dates
                ? [
                    new TextRun({
                      text: `\t${it.dates}`,
                      font: DOCX_FONT.mono,
                      size: docxHalfPoints(SIZE.dates),
                      color: INK3,
                    }),
                  ]
                : []),
            ],
          }),
        );
        const org = it.location ? `${it.org} · ${it.location}` : it.org;
        if (org) {
          children.push(
            new Paragraph({
              spacing: { after: 60 },
              children: [
                new TextRun({
                  text: org,
                  font: DOCX_FONT.serif,
                  size: docxHalfPoints(SIZE.org),
                  italics: true,
                  color: INK2,
                }),
              ],
            }),
          );
        }
        for (const b of it.bullets) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              children: [
                new TextRun({
                  text: b.text,
                  font: DOCX_FONT.serif,
                  size: docxHalfPoints(SIZE.bullet),
                  color: INK,
                }),
              ],
            }),
          );
        }
      }
    } else if (section.kind === "skills") {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: section.skills.join("   ·   "),
              font: DOCX_FONT.ui,
              size: docxHalfPoints(SIZE.skill),
              color: INK,
            }),
          ],
        }),
      );
    } else if (section.kind === "languages") {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: section.languages.map(formatLanguage).join("   ·   "),
              font: DOCX_FONT.ui,
              size: docxHalfPoints(SIZE.skill),
              color: INK,
            }),
          ],
        }),
      );
    } else if (section.kind === "education") {
      for (const it of section.items) {
        const left = it.org ? `${it.role} · ${it.org}` : it.role;
        children.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: 9026 }],
            children: [
              new TextRun({
                text: left,
                font: DOCX_FONT.serif,
                size: docxHalfPoints(SIZE.eduRole),
                color: INK,
              }),
              ...(it.dates
                ? [
                    new TextRun({
                      text: `\t${it.dates}`,
                      font: DOCX_FONT.mono,
                      size: docxHalfPoints(SIZE.dates),
                      color: INK3,
                    }),
                  ]
                : []),
            ],
          }),
        );
      }
    } else {
      // Exhaustive: a new ResumeSection kind must add a branch above, never silently enter the
      // education mapper (which reads `section.items`). Compile error if a kind is left unhandled.
      const unhandled: never = section;
      throw new Error(`unhandled section kind: ${JSON.stringify(unhandled)}`);
    }
  }

  return new Document({ sections: [{ children }] });
}

/** Build the DOCX and return its bytes. Content is deterministic for a given ResumeDocument. */
export async function renderResumeDocx(doc: ResumeDocument): Promise<Buffer> {
  return Packer.toBuffer(buildResumeDocx(doc));
}
