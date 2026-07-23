// Same-origin proxy for the backend's /ai/* endpoints (Parser now; Tailor + the review fan-out
// land here as SSE). proxyToBackend streams the upstream body, so server-sent events pass straight
// through. Node runtime for private-network reach. See lib/proxy.ts.
import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function handler(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  return proxyToBackend(req, "ai", path);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
