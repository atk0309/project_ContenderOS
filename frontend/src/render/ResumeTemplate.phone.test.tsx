/**
 * DevPR9 — the header phone must reach EVERY render output. It flows from `MasterProfile.basics.phone`
 * through `headerOf()` (the one mapping that previously dropped it) onto the shared `ResumeDocument`,
 * which the HTML template (preview == PDF source), the ATS-plain text, and the DOCX all derive from
 * (invariant 3 — one model, four outputs). We test the MAPPING (not a hand-built `ResumeDocument`, which
 * would bypass the bug) with a DISTINCTIVE value so a passing test proves the field threads end-to-end.
 *
 * The DOCX is a deflated zip, so we inflate `word/document.xml` (no external dep — the central
 * directory + node `zlib.inflateRawSync`) to assert phone actually reaches it, ordered with the rest.
 */
import { inflateRawSync } from "node:zlib";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderResumeDocx } from "./docx-mapper";
import { sampleRenderInput } from "./fixtures";
import { type RenderInput, toResumeDocument } from "./model";
import { ResumeTemplate } from "./ResumeTemplate";
import { toAtsText } from "./text-mapper";

const PHONE = "+00 111 222 333"; // distinctive synthetic value; not the fixture placeholder

// Read one entry's text from a .docx (zip) with no external dep, via the central directory — which
// always carries the real compressed size + local-header offset even when a data descriptor is used.
// docx/JSZip writes raw DEFLATE (method 8) or STORE (0); ZIP deflate is header-less → inflateRawSync.
function unzipEntryText(buf: Buffer, name: string): string {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--; // End Of Central Directory
  if (eocd < 0) throw new Error("no EOCD record");
  let cd = buf.readUInt32LE(eocd + 16); // central directory offset
  const target = Buffer.from(name);
  while (cd + 46 <= buf.length && buf.readUInt32LE(cd) === 0x02014b50) {
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOff = buf.readUInt32LE(cd + 42);
    if (buf.subarray(cd + 46, cd + 46 + nameLen).equals(target)) {
      const dataStart =
        localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(dataStart, dataStart + compSize);
      return (method === 8 ? inflateRawSync(data) : Buffer.from(data)).toString("utf8");
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip entry not found: ${name}`);
}

const withPhone = (phone: string): RenderInput => ({
  ...sampleRenderInput,
  master: {
    ...sampleRenderInput.master,
    basics: { ...sampleRenderInput.master.basics, phone },
  },
});

describe("header phone (DevPR9)", () => {
  it("headerOf maps basics.phone onto the ResumeDocument header", () => {
    expect(toResumeDocument(withPhone(PHONE)).header.phone).toBe(PHONE);
  });

  it("renders phone in the HTML template (the preview == PDF source)", () => {
    const html = renderToStaticMarkup(<ResumeTemplate doc={toResumeDocument(withPhone(PHONE))} />);
    expect(html).toContain(PHONE);
  });

  it("includes phone in the ATS-plain text", () => {
    expect(toAtsText(toResumeDocument(withPhone(PHONE)))).toContain(PHONE);
  });

  it("includes phone in the .docx, ordered email → phone → link", async () => {
    const buf = await renderResumeDocx(toResumeDocument(withPhone(PHONE)));
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK"); // real zip
    const xml = unzipEntryText(buf, "word/document.xml");
    expect(xml).toContain(PHONE);
    // The contact run joins location · email · phone · link — assert phone sits after email and
    // before the profile link, so the order matches the HTML/ATS surfaces (one model, four outputs).
    expect(xml.indexOf("sample@example.com")).toBeLessThan(xml.indexOf(PHONE));
    expect(xml.indexOf(PHONE)).toBeLessThan(xml.indexOf("https://example.com/profile"));
  });

  it("omits the phone line when basics.phone is empty (conditional render, no stray separator)", () => {
    const doc = toResumeDocument(withPhone(""));
    expect(doc.header.phone).toBe("");
    const html = renderToStaticMarkup(<ResumeTemplate doc={doc} />);
    expect(html).toContain("sample@example.com"); // the other contact lines still render
    // ATS join filters falsy, so an empty phone never produces a dangling " · " separator.
    expect(toAtsText(doc)).not.toContain(" ·  · ");
  });
});
