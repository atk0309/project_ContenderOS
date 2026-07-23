/**
 * ResumeDocument -> ATS-plain text. Single-column, text-extractable, deterministic. This is both
 * the "ats-plain" export and the exact text the Gatekeeper/Editor read ("the CV as the recruiter
 * sees it"). Derived from the same ResumeDocument as the template and DOCX (invariant 3).
 */
import { formatLanguage, type ResumeDocument } from "./model";

export function toAtsText(doc: ResumeDocument): string {
  const lines: string[] = [];

  lines.push(doc.header.name);
  if (doc.header.title) lines.push(doc.header.title);
  const contact = [doc.header.location, doc.header.email, doc.header.phone, doc.header.link]
    .filter(Boolean)
    .join(" · ");
  if (contact) lines.push(contact);
  if (doc.summary) {
    lines.push("");
    lines.push(doc.summary);
  }

  for (const section of doc.sections) {
    lines.push("");
    lines.push(section.title.toUpperCase());

    if (section.kind === "experience") {
      for (const it of section.items) {
        const head = it.dates ? `${it.role} — ${it.dates}` : it.role;
        lines.push(head);
        if (it.org) lines.push(it.location ? `${it.org} · ${it.location}` : it.org);
        for (const b of it.bullets) lines.push(`- ${b.text}`);
      }
    } else if (section.kind === "skills") {
      lines.push(section.skills.join(", "));
    } else if (section.kind === "languages") {
      lines.push(section.languages.map(formatLanguage).join(", "));
    } else if (section.kind === "education") {
      for (const it of section.items) {
        const left = it.org ? `${it.role} · ${it.org}` : it.role;
        lines.push(it.dates ? `${left} — ${it.dates}` : left);
      }
    } else {
      // Exhaustive: a new ResumeSection kind must add a branch above, never silently enter the
      // education mapper (which reads `section.items`). Compile error if a kind is left unhandled.
      const unhandled: never = section;
      throw new Error(`unhandled section kind: ${JSON.stringify(unhandled)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
