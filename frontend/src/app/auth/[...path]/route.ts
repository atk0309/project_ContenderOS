// Same-origin proxy for the backend's /auth/* endpoints (sign-in, session, magic-link + Entra
// callbacks). Browser hits app.<domain>/auth/...; this forwards to the private backend. Node
// runtime: the Edge runtime can't reach Railway's internal IPv6 hosts. See lib/proxy.ts.
import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function handler(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  return proxyToBackend(req, "auth", path);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
