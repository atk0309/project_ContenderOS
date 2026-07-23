// Same-origin proxy for the backend's /workspaces/* endpoints (tailor + persist, preview, sign off,
// gate-checked export). Browser hits app.<domain>/workspaces/...; this forwards to the private
// backend with the session cookie. Node runtime: the Edge runtime can't reach Railway's internal
// IPv6 hosts. See lib/proxy.ts. Server-side render fetches go direct via render/fetch.ts instead.
import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ingress cap so a giant upload can't be buffered into the Node proxy's memory by proxyToBackend's
// arrayBuffer() before the backend's byte cap runs. Generous over the backend's 10 MiB to leave room
// for multipart framing.
const MAX_PROXY_BODY_BYTES = 12 * 1024 * 1024;

type Ctx = { params: Promise<{ path: string[] }> };

async function handler(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  // The PDF-ingest upload MUST declare a sane content-length (a browser always does for a File body)
  // so a chunked/headerless body can't slip past this and be buffered unbounded. Other workspace
  // routes (small JSON) only reject a present, over-cap length — a missing one passes through.
  const isUpload = req.method === "POST" && path.at(-2) === "ingest" && path.at(-1) === "file";
  const declared = Number(req.headers.get("content-length"));
  const validLength = Number.isFinite(declared) && declared > 0;
  if ((validLength && declared > MAX_PROXY_BODY_BYTES) || (isUpload && !validLength)) {
    return new Response(JSON.stringify({ detail: "That upload is too large or unsupported." }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }
  return proxyToBackend(req, "workspaces", path);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
