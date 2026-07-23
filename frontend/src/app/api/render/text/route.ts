/**
 * GET /api/render/text?cvId=...
 * The ats-plain text export — also the exact text the Gatekeeper/Editor read. Derived from the same
 * ResumeDocument as the preview/PDF/DOCX (invariant 3). Deterministic. The `sample` id renders the
 * bundled fixture; any other id fetches the gate-checked bundle from the backend (forwarding the
 * session cookie) and refuses with the upstream status before producing text (invariant 2).
 */
import { getRenderBundle } from "@/render/fetch";
import { getRenderInput } from "@/render/fixtures";
import { toResumeDocument } from "@/render/model";
import { toAtsText } from "@/render/text-mapper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cvId = url.searchParams.get("cvId") ?? "sample";

  if (cvId === "sample") {
    return new Response(toAtsText(toResumeDocument(getRenderInput())), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const result = await getRenderBundle(cvId, req.headers.get("cookie") ?? "");
  if (!result.ok) {
    return Response.json(
      { detail: "render blocked", blockedBulletIds: result.blockedBulletIds },
      { status: result.status },
    );
  }

  return new Response(toAtsText(toResumeDocument(result.input)), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
