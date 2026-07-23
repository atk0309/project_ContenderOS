"use client";

// Master editor (owner-only) — build/store the candidate's canonical CV. This is the keystone that
// makes the product usable with your own data (the Workspace tailors / drafts from the STORED master,
// loaded server-side). Fully keyless: no AI, just a structured form. Stable ids are generated once
// per row (hidden) so a tailored bullet's provenance anchor (`sourceId`) stays stable across edits.
//
// Reskinned to the Claude design's `isMaster` block (docs/design/Contender.dc.html): a
// canonical-source banner (+ "Add source" → import), a live profile-preview header, and eyebrow'd
// section cards with the design's add/remove affordances. NAMED DIVERGENCE: the mockup edits inline
// (contenteditable + "saves as you type") with a flat skill-chip model; we keep STRUCTURED INPUTS +
// an explicit, VALIDATED Save because the master PUT is a full replace requiring name+email and our
// schema is richer (location parts, website, profiles, skill level/keywords). See design-system.md.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Schemas } from "@/lib/api/client";
import { sampleRenderInput } from "@/render/fixtures";
import { Banner, buttonStyle, cardStyle, fieldLabel, inputStyle, textareaStyle } from "@/ui";
import { ImportModal } from "../ingest/ImportModal";
import { useSession } from "../SessionProvider";
import {
  type ApiCall,
  addLanguageFromInput,
  addSkillFromInput,
  chipLabel,
  contactParts,
  draftFromMaster,
  educationSummary,
  emptyDraft,
  firstInvalidEntry,
  getMasterRequest,
  type MasterDraft,
  newEducation,
  newHighlight,
  newProfile,
  newWork,
  putMasterRequest,
  toMaster,
} from "./logic";

type Phase = { status: "loading" } | { status: "load-error" } | { status: "ready" };

const mono = { fontFamily: "var(--mono)" } as const;

// The single open inline editor across the master page (only one chip/entry edits at a time). `uid` is
// the entry's key (a skill/language `uid`; an education `id`). Kept page-level so a Save-validation error
// can re-target it and so opening entry B closes A. `field` (optional) is the specific field to focus on
// open — set by a Save error for education (which has several required fields); otherwise the effect
// focuses the kind's first field.
type OpenKind = "skill" | "language" | "education";
type OpenEntry = { kind: OpenKind; uid: string; field?: string };

// The first field each editor focuses on a plain open (a Save error may override via `OpenEntry.field`).
const FIRST_FIELD: Record<OpenKind, string> = {
  skill: "name",
  language: "name",
  education: "institution",
};

// Shared DOM ids so the page-level focus effect can target an editor's field without prop-drilling refs.
// The display control's `aria-controls` points at the editor; Done returns focus to its display control;
// Remove strands focus to the add affordance — all resolved by id.
const chipButtonId = (kind: string, uid: string) => `${kind}-chip-${uid}`;
const chipEditorId = (kind: string, uid: string) => `${kind}-editor-${uid}`;
const chipEditorFieldId = (kind: string, uid: string, field: string) =>
  `${kind}-editor-${uid}-${field}`;
const chipAddInputId = (kind: string) => `${kind}-add-input`;
const chipAddNoteId = (kind: string) => `${kind}-add-note`;
const educationAddBtnId = "education-add-btn";

export default function MasterPage() {
  const router = useRouter();
  const { user } = useSession();
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [draft, setDraft] = useState<MasterDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  // The single open inline chip editor (a skill / language). Page-level so a Save-validation error can
  // re-target it and so opening chip B closes chip A. `null` = no editor open.
  const [open, setOpen] = useState<OpenEntry | null>(null);
  // The import flow is a modal opened from "Add source" (C4: Master absorbed Import). `/ingest`
  // redirects to `/master?import=1`, so honour that param to auto-open (owner only).
  const [importOpen, setImportOpen] = useState(false);
  // Set when an import applies: the SERVER master now has the new items, but the in-memory draft is the
  // pre-import copy — a full-replace Save would overwrite them. We deliberately do NOT auto-reload (a
  // silent reload into a live editor races back-to-back imports + edits resumed after the modal closes),
  // so instead block Save + Add-source and surface a one-click Reload. Cleared by any successful load().
  const [importNeedsReload, setImportNeedsReload] = useState(false);
  // JSON of the last loaded/saved draft — lets a post-import refresh tell pristine from edited so it
  // never silently overwrites unsaved edits with the server copy.
  const savedSnapshotRef = useRef<string>("");
  // The "Add source" trigger — focus returns here when the modal closes (the auto-open path has no
  // implicit trigger for the browser to restore focus to).
  const addSourceRef = useRef<HTMLButtonElement>(null);
  // Fires the `?import=1` auto-open exactly once (openImport's identity churns with the draft).
  const autoOpenedRef = useRef(false);

  const call = useCallback(<T,>(c: ApiCall): Promise<T> => api<T>(c.path, c.init), []);

  const load = useCallback(async () => {
    setMsg(null);
    // The shell's SessionProvider already gated auth; every allowlisted account is the owner.
    setPhase({ status: "loading" });
    // First run — no master saved yet. Start from a blank form.
    const startBlank = () => {
      const next = emptyDraft();
      setDraft(next);
      savedSnapshotRef.current = JSON.stringify(next);
      setImportNeedsReload(false);
      setPhase({ status: "ready" });
    };
    try {
      const master = await call<Schemas["MasterProfile"] | null>(getMasterRequest());
      if (master === null) {
        // An absent master reads as 200-null (probe parity with the review-latest GET).
        startBlank();
        return;
      }
      const next = draftFromMaster(master);
      setDraft(next);
      savedSnapshotRef.current = JSON.stringify(next);
      setImportNeedsReload(false); // editor is back in sync with the server
      setPhase({ status: "ready" });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        // Deploy-skew tolerance: an old backend still 404s a first run during the rollout
        // window. Kept alongside the null arm; removal is a tracked follow-up.
        startBlank();
      } else if (err instanceof ApiError && err.status === 401) {
        // Session expired mid-session (domain-call 401) — bounce to sign-in.
        router.replace("/sign-in");
      } else {
        // A transient load failure (500/502/proxy). Do NOT fall through to a blank draft —
        // saving would PUT an empty master over an existing one. Block editing; offer a retry.
        setPhase({ status: "load-error" });
      }
    }
  }, [call, router]);

  useEffect(() => {
    void load();
  }, [load]);

  // Focus the open editor's first (name) field whenever it opens or a Save error re-targets it. The
  // editor mounts on the render after `open` changes, so this runs post-commit and resolves the field
  // by id. A Save error creates a NEW `open` object (even for the same entry), so this refires and pulls
  // focus to the offending field. `null` (closed/toggled) is a no-op — Done/Remove place focus directly.
  useEffect(() => {
    if (!open) return;
    const field = open.field ?? FIRST_FIELD[open.kind];
    document.getElementById(chipEditorFieldId(open.kind, open.uid, field))?.focus();
  }, [open]);

  // Open the import modal — but only on a CLEAN draft. Import updates the SAVED master server-side, so
  // opening over unsaved edits would let a later full-replace Save silently overwrite the imported
  // items. Requiring a clean draft (and the modal making the editor inert via showModal) means the
  // draft stays pristine for the modal's lifetime, so the post-import reload below is always safe.
  const openImport = useCallback(() => {
    // A Save in flight is a full-replace PUT; opening the import over it would let that write land
    // AFTER the import's apply and overwrite the imported items. Wait for the save to settle first.
    if (saving) {
      setMsg({ kind: "bad", text: "Wait for your save to finish before importing." });
      return;
    }
    if (importNeedsReload) {
      setMsg({ kind: "bad", text: "Reload to pick up your last import before importing again." });
      return;
    }
    if (JSON.stringify(draft) !== savedSnapshotRef.current) {
      setMsg({
        kind: "bad",
        text: "Save or discard your changes first — importing updates your saved master.",
      });
      return;
    }
    setImportOpen(true);
  }, [draft, importNeedsReload, saving]);

  // An import landed in the SAVED master, so the in-memory draft is now stale. Flag it — do NOT
  // auto-reload (a silent reload into the live editor races back-to-back imports + resumed edits) —
  // so Save/Add-source pause and a one-click Reload appears behind the modal.
  const onImported = useCallback(() => {
    setImportNeedsReload(true);
  }, []);

  // Auto-open the import modal when arriving via `/ingest` → `/master?import=1`. Wait for `phase` to be
  // `ready` (so the draft + snapshot are loaded) and route through openImport() so the deep-link honours
  // the SAME guards (clean, not saving, not stale) as the button; the ref fires it exactly once. Read in
  // an effect (client-only) so the page needs no Suspense boundary for useSearchParams.
  useEffect(() => {
    if (autoOpenedRef.current || phase.status !== "ready") return;
    if (new URLSearchParams(window.location.search).get("import") === "1") {
      autoOpenedRef.current = true;
      // Strip the param so a reload / back-nav doesn't force the modal open again after it's dismissed.
      window.history.replaceState(null, "", "/master");
      openImport();
    }
  }, [phase.status, openImport]);

  const save = useCallback(async () => {
    setMsg(null);
    // The editor is stale after an import (the server master gained items this draft doesn't have); a
    // full-replace Save would overwrite them. Block until the owner reloads.
    if (importNeedsReload) {
      setMsg({ kind: "bad", text: "Reload to pick up your imported items before saving." });
      return;
    }
    const result = toMaster(draft);
    if (!result.ok) {
      setErrors(result.errors);
      // Auto-open + focus the first invalid chip editor (a blank skill/language name) so the offending
      // field is reachable without scanning the error list. Derived client-side from the SAME predicate
      // `toMaster` applies (never by parsing its error strings). Other errors stay on the banner.
      const invalid = firstInvalidEntry(draft);
      if (invalid) setOpen(invalid);
      setMsg({ kind: "bad", text: `Fix ${result.errors.length} field(s) before saving.` });
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const saved = await call<Schemas["MasterProfile"]>(putMasterRequest(result.master));
      const next = draftFromMaster(saved);
      setDraft(next);
      setOpen(null); // the reloaded draft has fresh chip uids — drop any stale open editor
      savedSnapshotRef.current = JSON.stringify(next);
      setMsg({ kind: "ok", text: "Saved. Open the Workspace to tailor or draft a CV." });
    } catch (err: unknown) {
      setMsg({ kind: "bad", text: errText(err) });
    } finally {
      setSaving(false);
    }
  }, [call, draft, importNeedsReload]);

  if (phase.status !== "ready") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
        {phase.status === "load-error" ? (
          <div style={{ ...cardStyle, maxWidth: 420, textAlign: "center" }}>
            <p
              style={{ margin: "0 0 14px", color: "var(--text-2)", fontSize: 13, lineHeight: 1.5 }}
            >
              Couldn&rsquo;t load your saved CV (a transient error). Editing is disabled so a save
              can&rsquo;t overwrite it.
            </p>
            <button type="button" onClick={() => void load()} style={buttonStyle("primary", false)}>
              Retry
            </button>
          </div>
        ) : (
          <span style={{ ...mono, fontSize: 12, color: "var(--text-3)", textAlign: "center" }}>
            Checking your session…
          </span>
        )}
      </div>
    );
  }

  // --- immutable updaters --------------------------------------------------------------------
  const set = (patch: Partial<MasterDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setWork = (i: number, patch: Partial<MasterDraft["work"][number]>) =>
    setDraft((d) => ({ ...d, work: d.work.map((w, k) => (k === i ? { ...w, ...patch } : w)) }));
  const setHi = (i: number, j: number, text: string) =>
    setDraft((d) => ({
      ...d,
      work: d.work.map((w, k) =>
        k === i
          ? { ...w, highlights: w.highlights.map((h, m) => (m === j ? { ...h, text } : h)) }
          : w,
      ),
    }));
  const patchEducation = (id: string, patch: Partial<MasterDraft["education"][number]>) =>
    setDraft((d) => ({
      ...d,
      education: d.education.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));
  // Skills/languages edit by `uid` (the chip editor holds an entry, not an index).
  const patchSkill = (uid: string, patch: Partial<MasterDraft["skills"][number]>) =>
    setDraft((d) => ({
      ...d,
      skills: d.skills.map((s) => (s.uid === uid ? { ...s, ...patch } : s)),
    }));
  const patchLanguage = (uid: string, patch: Partial<MasterDraft["languages"][number]>) =>
    setDraft((d) => ({
      ...d,
      languages: d.languages.map((l) => (l.uid === uid ? { ...l, ...patch } : l)),
    }));
  const setProfile = (i: number, patch: Partial<MasterDraft["profiles"][number]>) =>
    setDraft((d) => ({
      ...d,
      profiles: d.profiles.map((p, k) => (k === i ? { ...p, ...patch } : p)),
    }));

  const contacts = contactParts(draft);

  return (
    <div style={page}>
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Canonical-source banner — the master is the source of truth; "Add source" feeds it via
            import. The info (icon + copy) is grouped so `.cos-masterbanner` can stack the solid CTA
            full-width below it at phone width. */}
        <div style={banner} className="cos-masterbanner">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flex: 1, minWidth: 0 }}>
            <span aria-hidden style={bannerIcon}>
              <ShieldIcon />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                This is your master profile — the canonical source.
              </div>
              <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2, lineHeight: 1.5 }}>
                Every tailored CV starts from here. Editing it won’t change CVs you’ve already
                tailored.
              </div>
            </div>
          </div>
          {/* Solid accent CTA (the mockup's banner button) — keeps the label AA in light theme; the
              section "Add X" buttons stay the outlined accent-text style. Opens the import modal
              (C4: Master absorbed Import). */}
          <button
            ref={addSourceRef}
            type="button"
            onClick={openImport}
            disabled={saving || importNeedsReload}
            style={{
              ...addSourceBtn,
              opacity: saving || importNeedsReload ? 0.55 : 1,
              cursor: saving || importNeedsReload ? "default" : "pointer",
            }}
            className="cos-brighten cos-bannercta"
          >
            <PlusIcon /> Add source
          </button>
        </div>

        <div
          style={{
            ...mono,
            fontSize: 10.5,
            // Essential save-model hint (we diverge from the mockup's autosave) — --text-2 for AA.
            color: "var(--text-2)",
            display: "flex",
            alignItems: "center",
            gap: 7,
            margin: "-6px 2px 0",
          }}
        >
          <span aria-hidden style={{ display: "inline-flex", color: "var(--text-3)" }}>
            <PencilIcon />
          </span>
          Editing as {user.email} · changes save when you click Save
        </div>

        {msg ? <Banner kind={msg.kind} text={msg.text} /> : null}
        {importNeedsReload ? (
          <div style={{ ...cardStyle, borderColor: "var(--accent)" }}>
            <p
              style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text)", lineHeight: 1.5 }}
            >
              Imported into your master. Reload to see the new items here — Save and Add source are
              paused until then, so this editor can&rsquo;t overwrite the import.
            </p>
            <button type="button" onClick={() => void load()} style={buttonStyle("primary", false)}>
              Reload
            </button>
          </div>
        ) : null}
        {errors.length > 0 ? (
          <div style={{ ...cardStyle, borderColor: "var(--bad)" }}>
            <div style={{ ...mono, fontSize: 11, color: "var(--bad)", marginBottom: 6 }}>
              Please fix:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 12.5 }}>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* The editable body. While a post-import reload is pending (importNeedsReload) the WHOLE editor
            is `inert` — fields, add/remove, and Save are all disabled — so edits that couldn't be saved
            (and would be lost on Reload) can't be made. The Reload banner above stays interactive. */}
        <div
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
          inert={importNeedsReload || undefined}
        >
          {/* Profile preview — the candidate's identity at a glance, live from the draft below. The
              name is the page's <h1> (the section eyebrows are the h2s), so the editor has a heading
              outline; styled as the design's 24px display name. */}
          <div style={previewCard}>
            <h1
              style={{
                margin: 0,
                fontSize: 24,
                fontWeight: 600,
                letterSpacing: "-0.015em",
                color: "var(--text)",
              }}
            >
              {draft.name.trim() || "Your name"}
            </h1>
            {draft.label.trim() ? (
              <div style={{ fontSize: 14, color: "var(--text-2)", marginTop: 2 }}>
                {draft.label}
              </div>
            ) : null}
            {contacts.length > 0 ? (
              <div
                style={{
                  ...mono,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "5px 14px",
                  marginTop: 11,
                  fontSize: 11,
                  // Essential identity values (rubric §6) → --text-2 for AA, not the mockup's muted ink.
                  color: "var(--text-2)",
                }}
              >
                {contacts.map((c) => (
                  <span key={c.kind}>{c.value}</span>
                ))}
              </div>
            ) : null}
          </div>

          {/* Basics. Only Name + Email are required (mirrors the relaxed schema); the rest are
            recommended — a sparse import lands fine and nudges to fill these in here. */}
          <Section title="Basics">
            <Row>
              <Field
                label="Full name (required)"
                value={draft.name}
                onChange={(v) => set({ name: v })}
              />
              <Field
                label="Headline (recommended)"
                value={draft.label}
                onChange={(v) => set({ label: v })}
              />
            </Row>
            <Row>
              <Field
                label="Email (required)"
                value={draft.email}
                onChange={(v) => set({ email: v })}
              />
              <Field
                label="Phone (recommended)"
                value={draft.phone}
                onChange={(v) => set({ phone: v })}
              />
            </Row>
            <div style={{ ...mono, fontSize: 11, color: "var(--text-3)" }}>
              Location (recommended)
            </div>
            <Row>
              <Field label="City" value={draft.city} onChange={(v) => set({ city: v })} />
              <Field label="Region" value={draft.region} onChange={(v) => set({ region: v })} />
              <Field
                label="Country code"
                value={draft.countryCode}
                onChange={(v) => set({ countryCode: v })}
              />
            </Row>
            <Row>
              <Field
                label="Website (optional)"
                value={draft.url}
                onChange={(v) => set({ url: v })}
              />
            </Row>
          </Section>

          {/* Summary — its own card (the design's standalone Summary block), not folded into Basics. */}
          <Section title="Summary">
            <Area
              label="Professional summary (recommended)"
              value={draft.summary}
              onChange={(v) => set({ summary: v })}
            />
          </Section>

          {/* Profiles */}
          <Section
            title="Profiles"
            onAdd={() => set({ profiles: [...draft.profiles, newProfile()] })}
            addLabel="Add profile"
          >
            {draft.profiles.length === 0 ? <Empty text="No profiles yet." /> : null}
            {draft.profiles.map((p, i) => (
              <Row key={p.uid}>
                <Field
                  label="Network"
                  value={p.network}
                  onChange={(v) => setProfile(i, { network: v })}
                />
                <Field label="URL" value={p.url} onChange={(v) => setProfile(i, { url: v })} />
                <RemoveIcon
                  label={`Remove profile ${i + 1}`}
                  onClick={() => set({ profiles: draft.profiles.filter((_, k) => k !== i) })}
                />
              </Row>
            ))}
          </Section>

          {/* Work */}
          <Section
            title="Experience"
            onAdd={() => set({ work: [...draft.work, newWork()] })}
            addLabel="Add role"
          >
            {draft.work.length === 0 ? <Empty text="Add your first role." /> : null}
            {draft.work.map((w, i) => (
              <div key={w.id} style={entryBox}>
                <div style={entryHead}>
                  <span style={{ ...mono, fontSize: 11, color: "var(--text-2)" }}>
                    Role #{i + 1}
                  </span>
                  <RemoveIcon
                    label={`Remove role ${i + 1}`}
                    onClick={() => set({ work: draft.work.filter((_, k) => k !== i) })}
                  />
                </div>
                <Row>
                  <Field
                    label="Company"
                    value={w.company}
                    onChange={(v) => setWork(i, { company: v })}
                  />
                  <Field
                    label="Position"
                    value={w.position}
                    onChange={(v) => setWork(i, { position: v })}
                  />
                </Row>
                <Row>
                  <Field
                    label="Start"
                    value={w.startDate}
                    onChange={(v) => setWork(i, { startDate: v })}
                  />
                  <Field
                    label="End (blank = present)"
                    value={w.endDate}
                    onChange={(v) => setWork(i, { endDate: v })}
                  />
                </Row>
                <Field
                  label="Tags (comma-separated)"
                  value={w.tags}
                  onChange={(v) => setWork(i, { tags: v })}
                />
                <div style={{ marginTop: 10 }}>
                  <div style={{ ...mono, fontSize: 11, color: "var(--text-3)", marginBottom: 6 }}>
                    Bullets
                  </div>
                  {w.highlights.map((h, j) => (
                    <div key={h.id} style={bulletRow}>
                      <span
                        aria-hidden
                        style={{
                          color: "var(--text-3)",
                          flex: "none",
                          paddingTop: 9,
                          lineHeight: 1,
                        }}
                      >
                        ▪
                      </span>
                      <textarea
                        value={h.text}
                        rows={2}
                        aria-label={`Role ${i + 1} bullet ${j + 1}`}
                        onChange={(e) => setHi(i, j, e.target.value)}
                        style={{ ...textareaStyle, flex: 1 }}
                      />
                      <RemoveIcon
                        label={`Remove role ${i + 1} bullet ${j + 1}`}
                        onClick={() =>
                          setWork(i, { highlights: w.highlights.filter((_, m) => m !== j) })
                        }
                      />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setWork(i, { highlights: [...w.highlights, newHighlight()] })}
                    className="cos-addline"
                    style={addLineBtn}
                  >
                    <PlusIcon /> Add line
                  </button>
                </div>
              </div>
            ))}
          </Section>

          {/* Skills + Education side by side (the design's flex row) — Skills flex:2, Education flex:1;
              both wrap to full-width stacked at iPhone width (minWidth forces the wrap). `flex-start`
              (not the mockup's default stretch) so opening one card's editor doesn't stretch the other
              with dead space. */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 16 }}>
            {/* Skills — flat chips + an "Add a skill…" input (the design's cloud). Click a chip to edit
                its level/keywords in place; the × removes. Named divergence: a structured editor
                (level/keywords), not contenteditable. */}
            <ChipCard
              title="Skills"
              kind="skill"
              items={draft.skills}
              nameOf={(s) => s.name}
              qualifierOf={(s) => s.level}
              emptyText="No skills yet — add your first below."
              placeholder="Add a skill…"
              addAria="Add a skill"
              addFromInput={addSkillFromInput}
              onItems={(next) => set({ skills: next })}
              open={open}
              setOpen={setOpen}
              containerStyle={{ flex: 2, minWidth: 240 }}
              renderFields={(s) => (
                <Row>
                  <Field
                    label="Skill"
                    inputId={chipEditorFieldId("skill", s.uid, "name")}
                    value={s.name}
                    onChange={(v) => patchSkill(s.uid, { name: v })}
                  />
                  <Field
                    label="Level (optional)"
                    value={s.level}
                    onChange={(v) => patchSkill(s.uid, { level: v })}
                  />
                  <Field
                    label="Keywords (comma-separated)"
                    value={s.keywords}
                    onChange={(v) => patchSkill(s.uid, { keywords: v })}
                  />
                </Row>
              )}
            />

            {/* Education — the design's read-stack (degree / org / dates); each entry is a ≥44px button
                that expands in place to the structured fields (institution/area/studyType/start/end). */}
            <EducationCard
              items={draft.education}
              onItems={(next) => set({ education: next })}
              patch={patchEducation}
              open={open}
              setOpen={setOpen}
              containerStyle={{ flex: 1, minWidth: 220 }}
            />
          </div>

          {/* Languages — a shipped feature the mockup lacks; mirrors the Skills chip cloud exactly
              ("language · fluency" chips, add-input, dedupe, click-to-edit). Named extension. */}
          <ChipCard
            title="Languages"
            kind="language"
            items={draft.languages}
            nameOf={(l) => l.language}
            qualifierOf={(l) => l.fluency}
            emptyText="No languages yet — add your first below."
            placeholder="Add a language…"
            addAria="Add a language"
            addFromInput={addLanguageFromInput}
            onItems={(next) => set({ languages: next })}
            open={open}
            setOpen={setOpen}
            renderFields={(l) => (
              <Row>
                <Field
                  label="Language"
                  inputId={chipEditorFieldId("language", l.uid, "name")}
                  value={l.language}
                  onChange={(v) => patchLanguage(l.uid, { language: v })}
                />
                <Field
                  label="Fluency (optional)"
                  value={l.fluency}
                  onChange={(v) => patchLanguage(l.uid, { fluency: v })}
                />
              </Row>
            )}
          />

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "4px 0 40px" }}>
            <button
              type="button"
              onClick={save}
              disabled={saving || importNeedsReload}
              style={buttonStyle("primary", saving || importNeedsReload)}
            >
              {saving ? "Saving…" : "Save master CV"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(draftFromMaster(sampleRenderInput.master));
                setErrors([]);
                setMsg({
                  kind: "ok",
                  text: "Loaded the sample — edit it into your own CV, then save.",
                });
              }}
              style={buttonStyle("ghost", false)}
            >
              Start from sample
            </button>
          </div>
        </div>
      </div>

      {/* Import flow (C4): a modal opened from "Add source". A successful apply marks the editor stale
          (importNeedsReload) — Save + Add-source pause and the editor goes inert behind a one-click
          Reload banner (no racy auto-reload); closing the modal returns focus to the trigger. */}
      {importOpen ? (
        <ImportModal
          onClose={() => {
            setImportOpen(false);
            addSourceRef.current?.focus();
          }}
          onApplied={onImported}
        />
      ) : null}
    </div>
  );
}

function errText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) return err.message || "Some fields didn't pass validation.";
    return err.message || "Request failed.";
  }
  return "Something went wrong.";
}

// --- small presentational helpers ----------------------------------------------------------------

function Section({
  title,
  children,
  onAdd,
  addLabel,
}: {
  title: string;
  children: React.ReactNode;
  onAdd?: () => void;
  addLabel?: string;
}) {
  return (
    <section style={sectionCard}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 13,
        }}
      >
        {/* A real heading for the document outline, styled as the design's mono eyebrow. */}
        <h2 style={sectionEyebrow}>{title}</h2>
        {onAdd ? (
          <button type="button" onClick={onAdd} className="cos-addbtn" style={addSectionBtn}>
            <PlusIcon /> {addLabel}
          </button>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}

/** A chip-cloud editor card (Skills / Languages): flat chips + an "Add a …" input, click-a-chip to edit
 * its qualifier (skill level+keywords / language fluency) in a single inline editor below the cloud. The
 * open editor is page-level state (`open`/`setOpen`) so only one edits at a time across the page and a
 * Save error can re-target it; the rest (input text, "already added" note, the blank-name guard) is
 * local. Generic over the row shape (`T extends { uid }`); `renderFields` supplies the structured inputs,
 * and its name field must carry `id={chipEditorFieldId(kind, uid, "name")}` so the focus effect finds it.
 * Focus lifecycle: open/Save-error → the name field (page effect); Done → the chip; Remove → the add
 * input (stranded-focus). Chips are two SIBLING buttons in a styled span — never nested interactives. */
function ChipCard<T extends { uid: string }>({
  title,
  kind,
  items,
  nameOf,
  qualifierOf,
  emptyText,
  placeholder,
  addAria,
  addFromInput,
  onItems,
  renderFields,
  open,
  setOpen,
  containerStyle,
}: {
  title: string;
  kind: "skill" | "language";
  items: T[];
  nameOf: (t: T) => string;
  qualifierOf: (t: T) => string;
  emptyText: string;
  placeholder: string;
  addAria: string;
  addFromInput: (items: T[], raw: string) => T[] | null;
  onItems: (next: T[]) => void;
  renderFields: (item: T) => React.ReactNode;
  open: OpenEntry | null;
  setOpen: (next: OpenEntry | null) => void;
  containerStyle?: React.CSSProperties;
}) {
  const [input, setInput] = useState("");
  const [dup, setDup] = useState(false);
  const [blankError, setBlankError] = useState(false);
  // The singular of the section title for labels ("Skills" → "Skill", "Languages" → "Language").
  const singular = title.replace(/s$/, "");

  const openUid = open?.kind === kind ? open.uid : null;
  const openItem = openUid !== null ? items.find((i) => i.uid === openUid) : undefined;

  // Clear the inline blank-name error whenever the open target changes (switch chips / close / reopen).
  // `openUid` is a pure trigger (the body only resets state) — that's the intended dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: openUid triggers the reset by design.
  useEffect(() => {
    setBlankError(false);
  }, [openUid]);

  // Focus a still-mounted element by id (a chip button / the add input) synchronously from a handler —
  // it survives the re-render that unmounts the editor, so focus never strands on `<body>`.
  const focusById = (id: string) => document.getElementById(id)?.focus();

  const submit = () => {
    if (!input.trim()) return; // a blank Enter/click is a silent no-op, never an "already added" note
    const next = addFromInput(items, input);
    if (next === null) {
      setDup(true); // non-blank but a case-insensitive duplicate
      return;
    }
    onItems(next);
    setInput("");
    setDup(false);
    focusById(chipAddInputId(kind)); // keep focus in the input for rapid entry
  };

  const remove = (uid: string) => {
    onItems(items.filter((i) => i.uid !== uid));
    if (open?.kind === kind && open.uid === uid) setOpen(null);
    focusById(chipAddInputId(kind)); // stranded-focus precedent → the add input
  };

  const toggle = (uid: string) => {
    if (open?.kind === kind && open.uid === uid) {
      setOpen(null); // toggle the open chip closed (focus stays on the clicked chip)
      return;
    }
    setOpen({ kind, uid }); // opening B commits-and-closes A; the page effect focuses B's name field
  };

  const done = () => {
    if (!openItem) return;
    if (!nameOf(openItem).trim()) {
      setBlankError(true); // mirror addFromInput's blank rejection — keep the editor open
      return;
    }
    const uid = openItem.uid;
    setOpen(null);
    focusById(chipButtonId(kind, uid)); // Done returns focus to its chip
  };

  return (
    <section style={{ ...sectionCard, ...containerStyle }}>
      <div style={{ marginBottom: 13 }}>
        <h2 style={sectionEyebrow}>{title}</h2>
      </div>

      {items.length === 0 ? (
        <Empty text={emptyText} />
      ) : (
        <div style={chipCloud}>
          {items.map((item) => {
            const isOpen = open?.kind === kind && open.uid === item.uid;
            const name = nameOf(item);
            const label = name.trim() ? chipLabel(name, qualifierOf(item)) : "(unnamed)";
            return (
              <span key={item.uid} className="cos-chip">
                <button
                  type="button"
                  id={chipButtonId(kind, item.uid)}
                  className="cos-chip-body"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? chipEditorId(kind, item.uid) : undefined}
                  onClick={() => toggle(item.uid)}
                >
                  {label}
                </button>
                <button
                  type="button"
                  className="cos-chipx"
                  aria-label={`Remove ${name.trim() || singular}`}
                  onClick={() => remove(item.uid)}
                >
                  <span aria-hidden>×</span>
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* The single inline editor for the open chip — structured Field rows + a 44×44 Remove and Done. */}
      {openItem ? (
        <div id={chipEditorId(kind, openItem.uid)} style={chipEditor}>
          {renderFields(openItem)}
          {blankError ? (
            <div role="alert" style={{ ...mono, fontSize: 11, color: "var(--bad)", marginTop: 8 }}>
              {singular} name can’t be blank.
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
            <button type="button" onClick={done} style={buttonStyle("ghost", false)}>
              Done
            </button>
            <RemoveIcon
              label={`Remove ${nameOf(openItem).trim() || singular}`}
              onClick={() => remove(openItem.uid)}
            />
          </div>
        </div>
      ) : null}

      {/* Add row — Enter or the button appends (no <form> exists on the page, so an explicit onKeyDown). */}
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <input
          id={chipAddInputId(kind)}
          value={input}
          placeholder={placeholder}
          aria-label={addAria}
          aria-describedby={dup ? chipAddNoteId(kind) : undefined}
          onChange={(e) => {
            setInput(e.target.value);
            if (dup) setDup(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button type="button" onClick={submit} className="cos-addchip" style={addChipBtn}>
          Add
        </button>
      </div>
      {dup ? (
        <div
          id={chipAddNoteId(kind)}
          role="status"
          style={{ ...mono, fontSize: 11, color: "var(--text-2)", marginTop: 6 }}
        >
          “{input.trim()}” is already added.
        </div>
      ) : null}
    </section>
  );
}

/** Education editor card — the design's read-stack (degree / org / dates) per entry, each a ≥44px button
 * that expands IN PLACE to the structured fields. Shares ChipCard's open-editor lifecycle (page-level
 * `open`, one editor at a time, Save-error re-target + per-field focus). "Add education" appends a blank
 * entry and opens it; Done blocks a blank institution (the "name" analog); Remove strands focus to the
 * Add button. Education-specific (fixed fields), so it renders its own Field rows rather than a render
 * prop. */
function EducationCard({
  items,
  onItems,
  patch,
  open,
  setOpen,
  containerStyle,
}: {
  items: MasterDraft["education"];
  onItems: (next: MasterDraft["education"]) => void;
  patch: (id: string, p: Partial<MasterDraft["education"][number]>) => void;
  open: OpenEntry | null;
  setOpen: (next: OpenEntry | null) => void;
  containerStyle?: React.CSSProperties;
}) {
  const kind = "education";
  const [blankError, setBlankError] = useState(false);

  const openId = open?.kind === kind ? open.uid : null;
  const openItem = openId !== null ? items.find((e) => e.id === openId) : undefined;

  // Reset the inline blank-institution error whenever the open target changes (a pure trigger).
  // biome-ignore lint/correctness/useExhaustiveDependencies: openId triggers the reset by design.
  useEffect(() => {
    setBlankError(false);
  }, [openId]);

  const focusById = (id: string) => document.getElementById(id)?.focus();

  const add = () => {
    const entry = newEducation();
    onItems([...items, entry]);
    setOpen({ kind, uid: entry.id }); // open the new entry (the page effect focuses Institution)
  };

  const remove = (id: string) => {
    onItems(items.filter((e) => e.id !== id));
    if (open?.kind === kind && open.uid === id) setOpen(null);
    focusById(educationAddBtnId); // stranded-focus → the Add button (education has no add input)
  };

  const toggle = (id: string) => {
    if (open?.kind === kind && open.uid === id) {
      setOpen(null);
      return;
    }
    setOpen({ kind, uid: id });
  };

  const done = () => {
    if (!openItem) return;
    if (!openItem.institution.trim()) {
      setBlankError(true); // mirror ChipCard's blank-name guard on the primary field
      return;
    }
    const id = openItem.id;
    setOpen(null);
    focusById(chipButtonId(kind, id)); // Done returns focus to its row button
  };

  return (
    <section style={{ ...sectionCard, ...containerStyle }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 13,
        }}
      >
        <h2 style={sectionEyebrow}>Education</h2>
        <button
          type="button"
          id={educationAddBtnId}
          onClick={add}
          className="cos-addbtn"
          style={addSectionBtn}
        >
          <PlusIcon /> Add education
        </button>
      </div>

      {items.length === 0 ? <Empty text="No education yet." /> : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((e) => {
          const isOpen = open?.kind === kind && open.uid === e.id;
          const summary = educationSummary(e);
          const fid = (name: string) => chipEditorFieldId(kind, e.id, name);
          const mainLine = summary.blank ? "New education entry" : summary.degree || summary.org;
          return (
            <div key={e.id}>
              <button
                type="button"
                id={chipButtonId(kind, e.id)}
                className="cos-edurow"
                aria-expanded={isOpen}
                aria-controls={isOpen ? chipEditorId(kind, e.id) : undefined}
                onClick={() => toggle(e.id)}
                style={eduRowBtn}
              >
                <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
                  {mainLine}
                </span>
                {/* org as a secondary line only when the degree is the main line (never repeat it) */}
                {summary.degree && summary.org ? (
                  <span style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 2 }}>
                    {summary.org}
                  </span>
                ) : null}
                {summary.dates ? (
                  <span style={{ ...mono, fontSize: 11, color: "var(--text-3)", marginTop: 3 }}>
                    {summary.dates}
                  </span>
                ) : null}
              </button>

              {isOpen ? (
                <div id={chipEditorId(kind, e.id)} style={chipEditor}>
                  <Row>
                    <Field
                      label="Institution"
                      inputId={fid("institution")}
                      value={e.institution}
                      onChange={(v) => patch(e.id, { institution: v })}
                    />
                    <Field
                      label="Area"
                      inputId={fid("area")}
                      value={e.area}
                      onChange={(v) => patch(e.id, { area: v })}
                    />
                  </Row>
                  <Row>
                    <Field
                      label="Study type"
                      inputId={fid("studyType")}
                      value={e.studyType}
                      onChange={(v) => patch(e.id, { studyType: v })}
                    />
                    <Field
                      label="Start"
                      inputId={fid("startDate")}
                      value={e.startDate}
                      onChange={(v) => patch(e.id, { startDate: v })}
                    />
                    <Field
                      label="End"
                      inputId={fid("endDate")}
                      value={e.endDate}
                      onChange={(v) => patch(e.id, { endDate: v })}
                    />
                  </Row>
                  {blankError ? (
                    <div
                      role="alert"
                      style={{ ...mono, fontSize: 11, color: "var(--bad)", marginTop: 8 }}
                    >
                      Institution can’t be blank.
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
                    <button type="button" onClick={done} style={buttonStyle("ghost", false)}>
                      Done
                    </button>
                    <RemoveIcon
                      label={summary.blank ? "Remove education entry" : `Remove ${mainLine}`}
                      onClick={() => remove(e.id)}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  inputId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputId?: string;
}) {
  return (
    <label style={{ flex: "1 1 180px", minWidth: 0, display: "block" }}>
      <span style={fieldLabel}>{label}</span>
      <input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
  );
}

function Area({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={fieldLabel}>{label}</span>
      <textarea
        value={value}
        rows={3}
        onChange={(e) => onChange(e.target.value)}
        style={textareaStyle}
      />
    </label>
  );
}

function RemoveIcon({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="cos-removeicon"
      style={removeIconBtn}
    >
      <TrashIcon />
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ ...mono, fontSize: 11.5, color: "var(--text-3)" }}>{text}</div>;
}

// --- icons (aria-hidden; the buttons carry the accessible label) ---------------------------------

function PlusIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3l8 4v5c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V7z" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 20l4-1 11-11-3-3L5 16z" />
    </svg>
  );
}

// --- styles -------------------------------------------------------------------------------------

const page = { minHeight: "100vh", padding: "24px 24px 0" } as const;

const banner = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "13px 15px",
  border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--line))",
  borderRadius: 12,
  background: "color-mix(in srgb, var(--accent) 7%, var(--panel))",
} as const;

const bannerIcon = {
  width: 24,
  height: 24,
  flex: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--accent)",
} as const;

// Banner CTA — SOLID accent (the mockup's banner button); --on-accent on --accent clears AA in both
// themes, unlike accent-text on the banner's accent tint.
const addSourceBtn = {
  flex: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--on-accent)",
  textDecoration: "none",
  background: "var(--accent)",
  border: "none",
  borderRadius: 8,
  padding: "7px 12px",
  cursor: "pointer",
} as const;

// Section "Add X" — OUTLINED accent-text on the panel (≈4.6:1 AA, matches the mockup's section adds).
// `background` lives in `.cos-addbtn` so its :hover tint can win (inline would beat the stylesheet).
const addSectionBtn = {
  flex: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--accent)",
  border: "1px solid color-mix(in srgb, var(--accent) 38%, var(--line))",
  borderRadius: 7,
  padding: "5px 10px",
  cursor: "pointer",
} as const;

const previewCard = {
  border: "1px solid var(--line)",
  borderRadius: 13,
  background: "var(--panel)",
  padding: "20px 22px",
} as const;

const sectionCard = {
  border: "1px solid var(--line)",
  borderRadius: 13,
  background: "var(--panel)",
  padding: "16px 18px",
} as const;

const sectionEyebrow = {
  margin: 0,
  fontFamily: "var(--mono)",
  fontSize: 10,
  // Explicit 400 — the mockup's eyebrow weight. NEVER delete the property: these render as <h2>,
  // and the UA stylesheet would bold them right back.
  fontWeight: 400,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--text-3)",
} as const;

// Skill / language chip cloud + inline editor (S7). The chip pill and its hover + tap-target `::after`
// live in `.cos-chip*` in globals.css (styling a chip inline would beat the stylesheet hover). Cloud gap
// is 12px EXACTLY → a 44px row pitch given the chips' −6px vertical `::after` inset (no overlap; AGENTS §7).
const chipCloud = { display: "flex", flexWrap: "wrap", gap: 12 } as const;

const chipEditor = {
  marginTop: 14,
  border: "1px solid var(--line)",
  borderRadius: 11,
  padding: "13px 14px",
  background: "var(--panel-2)",
} as const;

// Education read-stack row (S7). A full-width ≥44px button that expands the editor in place. background +
// border live in `.cos-edurow` (transparent → a panel-2 tint on hover) so the hover wins; the 1px border
// is present-but-transparent by default so the hover firms it with no layout shift (border-box).
const eduRowBtn = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  width: "100%",
  minHeight: 44,
  boxSizing: "border-box",
  textAlign: "left",
  padding: "7px 9px",
  borderRadius: 9,
  cursor: "pointer",
} as const;

// The cloud's "Add" button (the mockup's neutral button). background + border live in `.cos-addchip` so
// its :hover can win; the rest is inline. Sized to match the sibling add-input (form-height, like the
// rest of the structured editor — the C2 structured-inputs divergence), not the 44px chip target.
const addChipBtn = {
  flex: "none",
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--text)",
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
} as const;

const entryBox = {
  border: "1px solid var(--line)",
  borderRadius: 11,
  padding: "13px 14px",
  background: "var(--panel-2)",
} as const;

const entryHead = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
} as const;

const bulletRow = { display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" } as const;

const addLineBtn = {
  // color + border live in `.cos-addline` (so its :hover can win — inline would beat the stylesheet).
  alignSelf: "flex-start",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  marginTop: 3,
  fontSize: 11.5,
  fontWeight: 500,
  background: "transparent",
  borderRadius: 7,
  padding: "5px 10px",
  cursor: "pointer",
} as const;

// Borderless icon button — light like the mockup, but a full 44px tap target (AGENTS §7) rather than
// the mockup's 26px. color + background live in `.cos-removeicon` so its :hover danger tint can win.
const removeIconBtn = {
  flex: "none",
  width: 44,
  height: 44,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  cursor: "pointer",
} as const;
