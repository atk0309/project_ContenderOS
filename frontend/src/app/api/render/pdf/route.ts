/**
 * GET /api/render/pdf?cvId=...&variant=pretty|ats-plain
 * Prints the hidden /print/[cvId] page to PDF with Chromium (Playwright). Because it prints the
 * exact page the live preview renders, the PDF matches the preview by construction (invariant 3) and
 * is visually/content-stable for the pinned Playwright/Chromium + self-hosted fonts. NOTE: raw PDF
 * bytes are NOT byte-identical run-to-run — Chromium embeds time-dependent metadata (/CreationDate,
 * /ModDate, trailer /ID). Normalizing that metadata for true byte-stability is a tracked follow-up
 * (docs/architecture/renderer.md); preview==PDF parity is Playwright-MCP-verified, not the node gate.
 *
 * Auth handoff: the /print page fetches the gate-checked bundle from the private backend, but the
 * headless Chromium request carries no session cookie of its own. So we (1) precheck the gated export
 * with the caller's cookie and relay any non-200 (401/403/404/409) WITHOUT launching Chromium, then
 * (2) inject that same session cookie into the browser context so /print renders the bundle the
 * precheck authorized. `sample` is the offline fixture and skips both.
 */
import { chromium } from "playwright";
import { getRenderBundle } from "@/render/fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cvId = url.searchParams.get("cvId") ?? "sample";
  const cookieHeader = req.headers.get("cookie") ?? "";

  // Precheck the gate before paying for a browser launch. Skipped for the offline `sample` fixture.
  if (cvId !== "sample") {
    const result = await getRenderBundle(cvId, cookieHeader);
    if (!result.ok) {
      return Response.json(
        { detail: "render blocked", blockedBulletIds: result.blockedBulletIds },
        { status: result.status },
      );
    }
  }

  const printUrl = `${url.origin}/print/${encodeURIComponent(cvId)}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    // Hand the caller's session to Chromium so /print's backend fetch is authorized as the same user.
    const cookies = parseCookies(cookieHeader, url.origin);
    if (cookies.length > 0) await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(printUrl, { waitUntil: "networkidle" });
    await page.emulateMedia({ media: "print" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="cv-${cvId}.pdf"`,
      },
    });
  } finally {
    await browser.close();
  }
}

/** Turn a `Cookie:` header into Playwright cookie records scoped to the print origin. */
function parseCookies(
  header: string,
  origin: string,
): { name: string; value: string; url: string }[] {
  if (!header) return [];
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url: origin };
    })
    .filter((c) => c.name.length > 0);
}
