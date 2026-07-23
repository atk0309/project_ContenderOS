/**
 * THE one CV template. Pure function of a ResumeDocument -> React. It is the live preview AND the
 * source the PDF prints (Playwright renders the hidden /print route, which mounts this) AND the
 * structural basis for DOCX/ats-text. A change here changes the exported document — treat every
 * edit as a render-path change and verify preview == PDF (Playwright MCP). No data fetching, no
 * state, no time/locale — given the same ResumeDocument it renders identical markup.
 *
 * Ported from Contender.dc.html (the 660px "paper" surface). Every bullet carries data-bullet-id so
 * the Workspace can anchor reviewer notes to a stable id (invariant 7).
 *
 * In-paper editing (DevPR14, ADR 0012): an OPTIONAL `editableBulletIds` prop turns those bullets into
 * `contentEditable` — preview-only. It is default-off and NEVER passed by the render/export path
 * (`/print`, pdf/docx/text), so with it absent the markup is byte-identical and exports are unaffected
 * (invariant 3). This stays a PURE function: the prop is the only input; all edit state/handlers live
 * in the client `PreviewPanel` (event-delegated off `data-bullet-id`), never here — so `/print` (an
 * RSC) is never handed an event handler.
 */
import type { CSSProperties } from "react";
import { formatLanguage, type ResumeDocument, type ResumeSection } from "./model";
import { FONT, PAGE, PAPER, SIZE } from "./template-tokens";

const paper: CSSProperties = {
  maxWidth: `${PAGE.maxWidthPx}px`,
  margin: "22px auto",
  background: PAPER.bg,
  border: `1px solid ${PAPER.rule}`,
  borderRadius: "3px",
  boxShadow: "0 24px 70px -34px rgba(0,0,0,.55)",
  padding: `${PAGE.padTopPx}px ${PAGE.padXPx}px ${PAGE.padBottomPx}px`,
  color: PAPER.ink,
  fontFamily: FONT.serif,
};

const sectionTitle: CSSProperties = {
  fontFamily: FONT.ui,
  fontSize: `${SIZE.sectionTitle}px`,
  fontWeight: 600,
  letterSpacing: ".13em",
  textTransform: "uppercase",
  color: PAPER.ink2,
  paddingBottom: "6px",
  marginBottom: "10px",
  borderBottom: `1px solid ${PAPER.rule}`,
};

function ExperienceSection({
  section,
  editableBulletIds,
}: {
  section: Extract<ResumeSection, { kind: "experience" }>;
  editableBulletIds?: ReadonlySet<string>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {section.items.map((it) => (
        <div key={it.itemId}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: "12px",
            }}
          >
            <div style={{ fontSize: `${SIZE.role}px`, fontWeight: 600, color: PAPER.ink }}>
              {it.role}
            </div>
            <div
              style={{
                fontFamily: FONT.mono,
                fontSize: `${SIZE.dates}px`,
                color: PAPER.ink3,
                whiteSpace: "nowrap",
              }}
            >
              {it.dates}
            </div>
          </div>
          <div
            style={{
              fontSize: `${SIZE.org}px`,
              color: PAPER.ink2,
              fontStyle: "italic",
              margin: "1px 0 8px",
            }}
          >
            {it.location ? `${it.org} · ${it.location}` : it.org}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
            {it.bullets.map((b) => (
              <div key={b.id} data-line={b.id} style={{ position: "relative" }}>
                <div style={{ display: "flex", gap: "9px", alignItems: "flex-start" }}>
                  <span
                    style={{ flex: "none", color: PAPER.ink3, paddingTop: "3px", lineHeight: 1 }}
                  >
                    ▪
                  </span>
                  {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role + aria-label are gated on
                      the SAME editable condition — whenever aria-label is present the role is "textbox"
                      (which supports it); biome can't see the correlation across the two ternaries. */}
                  <div
                    data-bullet-id={b.id}
                    // Preview-only edit affordance (DevPR14): present only when PreviewPanel passes the
                    // set; each `|| undefined` / ternary omits the attribute entirely otherwise →
                    // byte-identical export. An editable bullet is a multiline textbox for AT.
                    contentEditable={editableBulletIds?.has(b.id) || undefined}
                    suppressContentEditableWarning
                    role={editableBulletIds?.has(b.id) ? "textbox" : undefined}
                    aria-label={editableBulletIds?.has(b.id) ? "Edit résumé bullet" : undefined}
                    aria-multiline={editableBulletIds?.has(b.id) || undefined}
                    style={{
                      flex: 1,
                      fontSize: `${SIZE.bullet}px`,
                      lineHeight: 1.56,
                      color: PAPER.ink,
                    }}
                  >
                    {b.text}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ResumeTemplate({
  doc,
  editableBulletIds,
}: {
  doc: ResumeDocument;
  editableBulletIds?: ReadonlySet<string>;
}) {
  return (
    <article style={paper}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "16px",
          paddingBottom: "14px",
          borderBottom: `2px solid ${PAPER.ink}`,
        }}
      >
        <div>
          <div
            style={{
              fontSize: `${SIZE.name}px`,
              fontWeight: 600,
              letterSpacing: "-.015em",
              lineHeight: 1.05,
            }}
          >
            {doc.header.name}
          </div>
          {doc.header.title ? (
            <div
              style={{
                fontSize: `${SIZE.title}px`,
                color: PAPER.ink2,
                marginTop: "5px",
                fontStyle: "italic",
              }}
            >
              {doc.header.title}
            </div>
          ) : null}
        </div>
        <div
          style={{
            fontFamily: FONT.mono,
            fontSize: `${SIZE.contact}px`,
            lineHeight: 1.7,
            color: PAPER.ink2,
            textAlign: "right",
            whiteSpace: "nowrap",
          }}
        >
          {doc.header.location ? <div>{doc.header.location}</div> : null}
          {doc.header.email ? <div>{doc.header.email}</div> : null}
          {doc.header.phone ? <div>{doc.header.phone}</div> : null}
          {doc.header.link ? <div>{doc.header.link}</div> : null}
        </div>
      </header>

      {doc.summary ? (
        <div data-line="summary" style={{ padding: "14px 0 4px" }}>
          <div style={{ fontSize: `${SIZE.summary}px`, lineHeight: 1.62, color: PAPER.ink }}>
            {doc.summary}
          </div>
        </div>
      ) : null}

      {doc.sections.map((section) => (
        <section key={section.sectionId} style={{ marginTop: "20px" }}>
          <div style={sectionTitle}>{section.title}</div>

          {section.kind === "experience" ? (
            <ExperienceSection section={section} editableBulletIds={editableBulletIds} />
          ) : null}

          {section.kind === "skills" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px 9px" }}>
              {section.skills.map((sk) => (
                <span
                  key={sk}
                  style={{
                    fontFamily: FONT.ui,
                    fontSize: `${SIZE.skill}px`,
                    color: PAPER.ink,
                    background: PAPER.bg2,
                    border: `1px solid ${PAPER.rule}`,
                    borderRadius: "5px",
                    padding: "3px 9px",
                  }}
                >
                  {sk}
                </span>
              ))}
            </div>
          ) : null}

          {section.kind === "languages" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px 9px" }}>
              {section.languages.map((lang) => (
                <span
                  key={lang.id}
                  style={{
                    fontFamily: FONT.ui,
                    fontSize: `${SIZE.skill}px`,
                    color: PAPER.ink,
                    background: PAPER.bg2,
                    border: `1px solid ${PAPER.rule}`,
                    borderRadius: "5px",
                    padding: "3px 9px",
                  }}
                >
                  {formatLanguage(lang)}
                </span>
              ))}
            </div>
          ) : null}

          {section.kind === "education"
            ? section.items.map((it) => (
                <div
                  key={it.itemId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: "12px",
                  }}
                >
                  <div>
                    <span style={{ fontSize: `${SIZE.eduRole}px`, fontWeight: 600 }}>
                      {it.role}
                    </span>
                    {it.org ? (
                      <span
                        style={{
                          fontSize: `${SIZE.org}px`,
                          color: PAPER.ink2,
                          fontStyle: "italic",
                        }}
                      >
                        {" · "}
                        {it.org}
                      </span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      fontFamily: FONT.mono,
                      fontSize: `${SIZE.dates}px`,
                      color: PAPER.ink3,
                    }}
                  >
                    {it.dates}
                  </div>
                </div>
              ))
            : null}
        </section>
      ))}
    </article>
  );
}
