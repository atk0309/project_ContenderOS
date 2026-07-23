/**
 * The hidden, chrome-free print surface. Mounts the ONE ResumeTemplate so the PDF Playwright prints
 * is the same document the Workspace live-preview shows (preview == PDF). No app shell, white page,
 * A4 geometry.
 *
 * Resolves the document by id: the bundled `sample` (offline determinism + the design reference)
 * stays on fixtures; any other id fetches the gate-checked {master, cv} from the backend, forwarding
 * the request's session cookie (for the PDF path, Chromium carries the cookie injected by the pdf
 * route). When the provenance gate blocks export (a net-new bullet awaits sign-off), the page renders
 * a clear blocked state instead of the document — so the printed PDF visibly refuses too (invariant 2).
 */
import { cookies } from "next/headers";
import { getRenderBundle } from "@/render/fetch";
import { getRenderInput } from "@/render/fixtures";
import { toResumeDocument } from "@/render/model";
import { ResumeTemplate } from "@/render/ResumeTemplate";

export const dynamic = "force-dynamic";

const PRINT_STYLE = "@page{size:A4;margin:0} html,body{background:#fff;margin:0;padding:0}";

function Surface({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Print geometry: A4, no browser headers/footers, document on white. */}
      <style>{PRINT_STYLE}</style>
      <main style={{ background: "#fff", minHeight: "100vh" }}>{children}</main>
    </>
  );
}

export default async function PrintPage({ params }: { params: Promise<{ cvId: string }> }) {
  const { cvId } = await params;

  if (cvId === "sample") {
    return (
      <Surface>
        <ResumeTemplate doc={toResumeDocument(getRenderInput())} />
      </Surface>
    );
  }

  const cookieHeader = (await cookies()).toString();
  const result = await getRenderBundle(cvId, cookieHeader);

  if (!result.ok) {
    const blocked = result.status === 409;
    return (
      <Surface>
        <div data-testid="render-blocked" style={{ padding: "48px", fontFamily: "sans-serif" }}>
          <h1 style={{ fontSize: "18px", margin: 0 }}>
            {blocked ? "Export blocked — sign-off required" : "Unable to render this CV"}
          </h1>
          <p style={{ color: "#555", marginTop: "12px", maxWidth: "40rem" }}>
            {blocked
              ? "This CV has net-new bullets the candidate hasn't approved yet. Sign them off to unblock export."
              : `The backend declined this request (status ${result.status}).`}
          </p>
          {blocked && result.blockedBulletIds.length > 0 && (
            <ul style={{ color: "#555", marginTop: "8px" }}>
              {result.blockedBulletIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          )}
        </div>
      </Surface>
    );
  }

  return (
    <Surface>
      <ResumeTemplate doc={toResumeDocument(result.input)} />
    </Surface>
  );
}
