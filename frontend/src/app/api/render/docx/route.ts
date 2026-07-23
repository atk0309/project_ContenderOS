/**
 * GET /api/render/docx?cvId=...
 * Builds the DOCX from the same ResumeDocument as the preview/PDF, via the `docx` lib. Content is
 * deterministic; raw `.docx` bytes are not yet byte-identical (ZIP timestamps — see renderer.md).
 * The `sample` id renders the bundled fixture; any other id fetches the gate-checked bundle from the
 * backend (forwarding the session cookie) and refuses before producing the file (invariant 2).
 */
import { renderResumeDocx } from "@/render/docx-mapper";
import { getRenderBundle } from "@/render/fetch";
import { getRenderInput } from "@/render/fixtures";
import { toResumeDocument } from "@/render/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cvId = url.searchParams.get("cvId") ?? "sample";

  let doc: ReturnType<typeof toResumeDocument>;
  if (cvId === "sample") {
    doc = toResumeDocument(getRenderInput());
  } else {
    const result = await getRenderBundle(cvId, req.headers.get("cookie") ?? "");
    if (!result.ok) {
      return Response.json(
        { detail: "render blocked", blockedBulletIds: result.blockedBulletIds },
        { status: result.status },
      );
    }
    doc = toResumeDocument(result.input);
  }

  const bytes = await renderResumeDocx(doc);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": DOCX_TYPE,
      "content-disposition": `attachment; filename="cv-${cvId}.docx"`,
    },
  });
}
