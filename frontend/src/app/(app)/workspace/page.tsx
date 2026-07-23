"use client";

// Workspace (owner-only) — the first real screen. Start an AI-free draft from your stored master, OR
// paste a job posting to tailor it → edit tailored bullets live against a real-time preview → sign
// off net-new bullets → export. The master is loaded server-side (invariant 2); the preview mounts
// the SAME `ResumeTemplate` the PDF prints (invariant 3), so what you see is what exports. The
// provenance/sign-off gate is enforced server-side; the disabled export controls are guidance.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type Schemas } from "@/lib/api/client";
import { BRAND_NAME } from "@/lib/brand";
import {
  type Checklist,
  consumeSseStream,
  emptyChecklist,
  reduceChecklist,
  type SseEvent,
} from "@/lib/sse";
import { Banner, buttonStyle, cardStyle, fieldLabel, inputStyle } from "@/ui";
import { applyRequest, blockedBulletIds, byCvRequest, conflictCode } from "../applications/logic";
import { getMasterRequest } from "../master/logic";
import { useAiReadiness } from "../ReadinessProvider";
import { DiffView } from "./DiffView";
import { EditorPanel } from "./EditorPanel";
import { GatekeeperEmpty, GatekeeperView } from "./GatekeeperView";
import {
  type ApiCall,
  acceptedThreads,
  applyFeedbackRequest,
  canApplyCorrections,
  checklistFromBundle,
  collectThreads,
  collectUnsignedBulletIds,
  type Decisions,
  type Drafts,
  decide,
  deleteReviewRequest,
  diffChangedBulletsFromSnapshot,
  dirtyBulletIds,
  editableBulletIds,
  editRequest,
  emptyBundle,
  exportUrl,
  failureLabel,
  foldSameBulletDecisions,
  fromMasterRequest,
  gatekeeperEmptyReason,
  gatekeeperFixes,
  gatekeeperKeywords,
  gatekeeperMustHaves,
  isAcceptableThread,
  parseRequest,
  readRequest,
  reduceReviewBundle,
  reviewAgentLabel,
  reviewedTextSnapshot,
  reviewLatestRequest,
  reviewStreamRequest,
  sameBulletApply,
  saveDecisionsRequest,
  signoffRequest,
  staleReviewBulletIds,
  type ThreadDecision,
  tailorRequest,
} from "./logic";
import { PostingSidebar } from "./PostingSidebar";
import { PreviewPanel } from "./PreviewPanel";
import { ReviewPanel } from "./ReviewPanel";
import { editorTextarea, mono, srOnly } from "./styles";
import { TopbarVerdict } from "./TopbarVerdict";
import { WorkspaceList } from "./WorkspaceList";

type RenderBundle = Schemas["RenderBundle"];
type ApplicationSummary = Schemas["ApplicationSummary"];

type Phase =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "needs-master" }
  | { status: "idle" }
  | { status: "parsing" }
  | { status: "tailoring" }
  | { status: "drafting" }
  | { status: "not-found" }
  | { status: "error"; cvId: string; message: string }
  | { status: "preview"; cvId: string; bundle: RenderBundle };

// The terminal RunDone captured from the stream (it carries `ok` + an optional `detail` the outcome
// object doesn't), surfaced as a run-level failure when `ok` is false.
type RunDoneInfo = { ok: boolean; detail: string | null };

// Move focus to a ref after the next paint (the review results land async). Module-scope, stable.
const focusSoon = (el: HTMLElement | null) => setTimeout(() => el?.focus(), 0);
// Whether an async settle (review-done / apply-done) may move focus + flip the tab. True only when
// focus is "idle" (body/none) or still inside the workspace `root`; false for a textarea (an active
// edit we must not interrupt) or any control the user has tabbed to OUTSIDE the workspace — so a
// multi-second review/apply can't steal focus from elsewhere on the page (WCAG 3.2.5).
const autoFocusOnSettle = (root: HTMLElement | null): boolean => {
  const ae = (
    typeof document !== "undefined" ? document.activeElement : null
  ) as HTMLElement | null;
  if (!ae || ae === document.body) return true;
  // A textarea OR an in-paper contentEditable bullet is an active edit we must not interrupt (DevPR14).
  if (ae.tagName === "TEXTAREA" || ae.isContentEditable) return false;
  return root?.contains(ae) ?? false;
};

// The persisted-review probe as a TRI-STATE (ADR 0013). A clean 2xx returns `{ ok, value }` where a
// null value means "no review stored"; a transport/5xx failure returns `{ ok: false }` = "couldn't
// load". The old inline `.catch(() => null)` collapsed a FAILED GET into null, indistinguishable from
// "absent", so any blip wiped the whole review on return (total blank — invariant 5: never swallow).
// A 401 is a real session failure — don't retry (the parallel bundle load surfaces it); any other
// error retries briefly, then reports `ok: false` (couldn't load), NEVER "absent". Module-scope, stable.
type ReviewLoad = { ok: true; value: Schemas["SavedReview"] | null } | { ok: false };
const loadSavedReview = async (path: string): Promise<ReviewLoad> => {
  const backoffMs = [150, 400];
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, value: await api<Schemas["SavedReview"] | null>(path) };
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) return { ok: false };
      if (attempt >= backoffMs.length) return { ok: false };
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }
  }
};

export default function WorkspacePage() {
  // `useSearchParams()` (read in WorkspaceClient) must sit under a Suspense boundary, or `next build`
  // fails on this statically-optimized route.
  return (
    <Suspense fallback={<SessionShell label="Checking your session…" />}>
      <WorkspaceClient />
    </Suspense>
  );
}

function WorkspaceClient() {
  const router = useRouter();
  const { tailor: aiReadiness, review: reviewReadiness } = useAiReadiness();
  const searchParams = useSearchParams();
  const cvParam = searchParams.get("cv");
  // The Gatekeeper subview (B3) is a `?view=gatekeeper` MODE of this same route — not a separate page —
  // so the in-session review verdict (ADR 0011 subview; the run now persists + rehydrates per ADR 0013)
  // survives entering it. The mount effect keys on `cvParam` only, so toggling `view` never reloads the
  // CV or drops the in-session review.
  const viewParam = searchParams.get("view");
  // The cv currently loaded into `preview`. Guards the deep-link effect against re-entry when
  // `openCreated` syncs the URL, and lets Retry force a reload by clearing it.
  const loadedCvRef = useRef<string | null>(null);
  // Synchronous single-flight guard for apply: `applying` state lags a render, so a fast double
  // confirm/Enter could fire two POSTs before the button repaints. The ref flips immediately.
  const applyInFlightRef = useRef(false);
  // Same guard for review — a fast double-click would otherwise fire two billed fan-out runs.
  const reviewInFlightRef = useRef(false);
  // The review streams (SSE fan-out): an AbortController per run cancels the reader on Stop or unmount;
  // `mountedRef` gates setState from the long-lived reader; `reviewCancelledRef` distinguishes a user
  // Stop (no warning) from a passive drop; `runDoneRef` captures the terminal RunDone (the spine calls
  // onEvent for it before returning) so a run-level failure can be surfaced honestly.
  const reviewAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const reviewCancelledRef = useRef(false);
  const runDoneRef = useRef<RunDoneInfo | null>(null);
  // The review panel heading — focus lands here on stream-done so a screen reader / keyboard user is
  // taken to the results (unless they're mid-edit in a bullet — see runReview).
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);
  // Bumped by "Clear review" (S4) — an async review op (a retry GET) that started before the clear must
  // drop its stale result instead of rehydrating the just-cleared run (Codex P2). A "release the clearing
  // gate once the in-flight decisions PUT also settles" latch (Codex P2 — a late decisions PUT must not
  // land pre-clear decisions on a same-version re-run).
  const reviewGenRef = useRef(0);
  const clearReleaseWaitRef = useRef(false);
  // The Preview pane wrapper — apply-settle moves focus here (the review heading is hidden on the
  // Preview tab at narrow widths, so focusing it would drop focus to <body>).
  const previewPaneRef = useRef<HTMLDivElement>(null);
  // The whole workspace column wrapper (.ws-cols). A settle handler only auto-moves focus when focus
  // is "idle" (body) or still inside the workspace — never when the user has tabbed away to a control
  // elsewhere (WCAG 3.2.5 focus-not-stolen). See `autoFocusOnSettle` below.
  const wsRootRef = useRef<HTMLDivElement>(null);
  // --- Review persistence (S4 / ADR 0013): silent autosave of per-finding decisions + rehydration ---
  // `decisionsRef` mirrors `decisions` and is written EAGERLY (before React commits) so the parent-owned
  // decide handler reads a synchronous post-toggle snapshot even under rapid clicks — replacing the old
  // functional-updater's race protection. `reviewRef` mirrors the in-memory review's identity for the
  // stale-closure-free abort + PUT-version lookups. `persistedFreshRef` is the cvId-KEYED gate: a PUT
  // fires only when it equals the current review's cvId (set at run_done/rehydrate, null while a run is
  // unpersisted). `pendingRef`/`inFlightRef` drive a single-flight, trailing-latest PUT queue;
  // `flushDecisionsRef` lets that queue re-drive itself without churning the callback identity.
  const decisionsRef = useRef<Decisions>({});
  const reviewRef = useRef<{ cvId: string; version: number } | null>(null);
  const persistedFreshRef = useRef<string | null>(null);
  const pendingRef = useRef<Decisions | null>(null);
  const inFlightRef = useRef(false);
  const flushDecisionsRef = useRef<() => void>(() => {});
  // Set true by the explicit "‹ Workspace" back action so the re-firing mount effect keeps the list
  // (skips the master probe that could flash "needs-master") and WorkspaceList takes focus on mount.
  const backNavRef = useRef(false);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [rawText, setRawText] = useState("");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [mutating, setMutating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showApply, setShowApply] = useState(false);
  // One-shot: the back button sets this so the freshly-mounted WorkspaceList moves focus to its heading
  // (a keyboard/SR user isn't stranded on <body>). Reset via onListHeadingFocused so a cold /workspace
  // load never steals focus to the heading.
  const [focusListHeading, setFocusListHeading] = useState(false);
  const onListHeadingFocused = useCallback(() => setFocusListHeading(false), []);
  // The Posting drawer (B1): a per-CV slide-in showing the stored JobSpec source. Only the `preview`
  // phase has a bundle, and a keyless draft's `jobSpec` is null — the trigger guards on both.
  const [showPosting, setShowPosting] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  // A "Clear review" DELETE is in flight — gate Re-run until it settles so the delete can't remove a
  // freshly-started run's row (Codex P2). Brief (one query); not a spinner.
  const [clearing, setClearing] = useState(false);
  // Live per-agent progress for the streaming run: the checklist (keyed by agentId) + a single
  // replaceable status sentence — the ONLY thing the screen-reader hears (AgentChecklist owns the one
  // aria-live region). A run-level note (interrupted / stopped / couldn't-complete) shows in the card.
  const [checklist, setChecklist] = useState<Checklist>(emptyChecklist);
  const [reviewStatusLine, setReviewStatusLine] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);
  // A polite SR announcement for the settled outcome — AgentChecklist's own live region stops updating
  // once the stream ends (it unmounts), so this carries "review complete / couldn't run" at settle.
  // Empty while streaming, so it never competes with the checklist's region (dec #9: one at a time).
  const [reviewAnnounce, setReviewAnnounce] = useState("");
  // The advisory review, STAMPED with the {cvId, version} it judged + built progressively as each
  // adjudicator's report streams in. TWO-level freshness (dec #1, revised by ADR 0016): a saved edit
  // (version bump) marks the whole-CV verdict + panel threads STALE (`versionDrifted` — shown, never
  // hidden), and the bullet inline notes survive per-bullet (`reviewSameCv` + `staleIds`) so accepts
  // aren't lost when you save one manual edit. `version` is the baseVersion we requested — the
  // server's 409 guard makes that exactly the version it reviewed (RunDone carries none).
  const [review, setReview] = useState<{
    cvId: string;
    version: number;
    bundle: Schemas["ReviewBundle"];
    // Bullet texts at review-start: a SAVED edit deletes the draft, so dirty-only can't tell a bullet
    // drifted from what was judged — this snapshot can (PR-4 per-bullet lifecycle).
    reviewedText: Record<string, string>;
  } | null>(null);
  // PR-4: accept/reject by threadKey (survives an unrelated bullet's save), + the Corrector apply's
  // own single-flight + in-flight/error state (distinct from the tracker's `applying`/`applyError`).
  const [decisions, setDecisions] = useState<Decisions>({});
  // Save-state (S4), all scoped to the CURRENT review + reset when it changes. `reviewRestored` = this
  // review was rehydrated from persistence (drives the restored provenance caption). `saveFailed` = a
  // run_done arrived `ok` but `detail === "save_failed"` (the review couldn't be persisted → it won't
  // survive leaving the page; the gate stays null so nothing is PUT). `decideSaveFailed` = a decisions
  // PUT failed on an otherwise-persisted run (a soft note; retried on the next click, no auto-retry loop).
  const [reviewRestored, setReviewRestored] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [decideSaveFailed, setDecideSaveFailed] = useState(false);
  // The persisted-review GET FAILED after retries (transport/5xx) on the current cv — distinct from a
  // clean 200-null "no review". Drives a non-blocking "Couldn't load your saved review — Retry" in the
  // panel so a transient failure never reads as "the review vanished" (invariant 5). Reset per load/run.
  const [reviewLoadFailed, setReviewLoadFailed] = useState(false);
  const [applyingFeedback, setApplyingFeedback] = useState(false);
  const [applyFeedbackError, setApplyFeedbackError] = useState<string | null>(null);
  const applyFeedbackInFlightRef = useRef(false);
  // Optimistic apply paint (DevPR29): bulletId → suggested text, shown INSTANTLY while the Corrector
  // runs, reconciled by the server's re-grounded bundle on success and cleared on EVERY outcome
  // (finally) so a failed apply never leaves fake text on the paper (invariant 3). Render-only —
  // separate from `drafts` (so it never marks a bullet dirty / blocks the apply).
  const [optimistic, setOptimistic] = useState<Record<string, string>>({});
  // Post-correction flash: a monotonic nonce (null = idle). Each successful Apply bumps it so the
  // preview's overlay band remounts and the `flashfix` keyframe re-fires; it auto-clears after the
  // animation. Date-free (a ref counter) — no render-path concern, just a re-trigger key.
  const [flash, setFlash] = useState<number | null>(null);
  const flashNonceRef = useRef(0);
  // B2c: which pane shows below the ws-tabs breakpoint (<1120px). Desktop shows all three; this only
  // gates the narrow single-pane view. Default "preview" (matches the design) so a loaded CV lands on
  // the paper; the settle handlers flip it to "reviewers" (review done) / "preview" (apply done).
  const [wsTab, setWsTab] = useState<"editor" | "preview" | "reviewers">("preview");
  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => mountedRef.current && setFlash(null), 1400);
    return () => clearTimeout(t);
  }, [flash]);

  // Read a persisted CV into `preview`, with the deep-link error taxonomy. `shouldApply` lets the
  // mount effect drop a result after unmount; Retry calls it directly. Sets the ref so the post-create
  // URL sync doesn't double-load.
  //
  // The single review rehydrate commit (S4 / ADR 0013), shared by loadCv's restore branch AND the
  // panel's Retry: restore the verdict + decisions + a synthesized settled checklist and open the
  // decisions PUT gate on THIS cv. No focus/tab move — a restore isn't a fresh run's settle.
  const rehydrateReviewState = useCallback((cvId: string, saved: Schemas["SavedReview"]) => {
    reviewRef.current = { cvId, version: saved.bundle.cvVersion };
    decisionsRef.current = saved.decisions;
    pendingRef.current = null;
    persistedFreshRef.current = cvId; // rehydrate-commit → decisions PUTs allowed for this cv
    setReview({
      cvId,
      version: saved.bundle.cvVersion,
      bundle: saved.bundle,
      reviewedText: saved.reviewedText,
    });
    setDecisions(saved.decisions);
    setChecklist(checklistFromBundle(saved.bundle));
    setReviewRestored(true);
    setSaveFailed(false);
    setDecideSaveFailed(false);
    // A prior run's interruption message (from a stream a switch aborted) must not leak onto the
    // restored review — restore is silent + carries no run-level error.
    setReviewError(null);
    setReviewAnnounce("");
  }, []);

  const loadCv = useCallback(
    async (cvId: string, shouldApply: () => boolean = () => true): Promise<void> => {
      // Abort a still-live review stream when SWITCHING to a DIFFERENT cv (S4): browser Back/Forward
      // mid-stream keeps the SSE reader alive (list↔detail is one component; the visible back button is
      // disabled while busy, history nav isn't), and its frames fold into whatever `review` is current.
      // Key on cvId MISMATCH — re-opening the SAME cv (A→list→re-open-A) must NOT abort its own stream.
      if (reviewRef.current && reviewRef.current.cvId !== cvId) reviewAbortRef.current?.abort();
      const c = readRequest(cvId);
      const byCv = byCvRequest(cvId);
      const latest = reviewLatestRequest(cvId);
      try {
        // Read the bundle, the applied-lock probe, and the persisted latest review IN PARALLEL, then
        // commit a single state — so an applied CV redirects to the tracker with NO flash of the editable
        // editor. `by-cv` answers 200 `null` for an unapplied CV and fails OPEN to the editor. The review
        // probe is a TRI-STATE (`loadSavedReview`): a clean 200-null = "no review" (ADR 0013), but a
        // transport/5xx failure = "couldn't load" — NEVER silently "absent" (the old `.catch(()=>null)`
        // wiped the whole review on any blip → total blank, invariant 5).
        const reviewLoad = loadSavedReview(latest.path);
        const [bundle, appn] = await Promise.all([
          api<RenderBundle>(c.path, c.init),
          api<ApplicationSummary | null>(byCv.path).catch(() => null),
        ]);
        if (!shouldApply()) return;
        if (appn) {
          router.replace(`/applications/${encodeURIComponent(appn.id)}`);
          return;
        }
        const loaded = await reviewLoad;
        if (!shouldApply()) return;
        loadedCvRef.current = cvId;
        setDrafts({});
        // Rehydrate / reconcile the persisted review (S4). Rehydrate ONLY when there's no in-memory
        // review or it's for ANOTHER cv — retryLoad re-runs loadCv, and a 200-null must not wipe a valid
        // in-memory review for the SAME cv. `reviewRef` is the stale-closure-free source of the current
        // review's cvId (loadCv's deps are just [router]).
        const inMemForAnother = reviewRef.current !== null && reviewRef.current.cvId !== cvId;
        const shouldRehydrate = reviewRef.current === null || inMemForAnother;
        // A FAILED probe leaves review state untouched (a valid in-memory review for THIS cv survives —
        // never wiped) and flags the panel Retry. A clean 200-null rehydrates/clears exactly as before.
        // BOTH branches gate on `loaded.ok` so a failed probe (saved=null) can't fall into the clear
        // branch and wipe another cv's in-memory review on a transient blip.
        setReviewLoadFailed(!loaded.ok);
        const saved = loaded.ok ? loaded.value : null;
        if (loaded.ok && saved && shouldRehydrate) {
          // ONE state commit (shared with the panel's Retry): restore verdict + decisions + settled
          // checklist and open the decisions PUT gate on THIS cv.
          rehydrateReviewState(cvId, saved);
        } else if (loaded.ok && !saved && inMemForAnother) {
          // 200-null for a DIFFERENT cv than the in-memory review → clear the stale review in the same
          // commit, else it lingers across the switch and the restored caption would lie.
          reviewRef.current = null;
          decisionsRef.current = {};
          pendingRef.current = null;
          persistedFreshRef.current = null;
          setReview(null);
          setDecisions({});
          setReviewRestored(false);
          setSaveFailed(false);
          setDecideSaveFailed(false);
          setReviewError(null); // drop a stale run-level error from the aborted prior stream
          setReviewAnnounce("");
        }
        setPhase({ status: "preview", cvId, bundle });
      } catch (err: unknown) {
        if (!shouldApply()) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        // Mid-session revocation (de-allowlisted → server 403, the pinned contract): the
        // access-removed phase, not the generic error (which would offer a pointless Retry).
        if (err instanceof ApiError && err.status === 403) {
          setPhase({ status: "forbidden" });
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setPhase({ status: "not-found" });
          return;
        }
        setPhase({ status: "error", cvId, message: errText(err) });
      }
    },
    [router, rehydrateReviewState],
  );

  // Mount/refresh gate + deep-link load. Keyed on the `?cv=` param, NEVER on `phase`: reading `phase`
  // here would make biome's exhaustive-deps force it into the array, so the effect would re-fire on
  // every transition and stomp in-flight tailoring/drafts. The ref guard turns `openCreated`'s
  // post-create `router.replace(?cv=…)` into a no-op instead of a double-load.
  useEffect(() => {
    if (cvParam && loadedCvRef.current === cvParam) return;
    // The shell's SessionProvider already resolved auth (401 -> /sign-in); every allowlisted
    // account is an owner, so there is no client-side role gate — a server 403 (mid-session
    // revocation) lands on the `forbidden` phase below.
    let active = true;
    (async () => {
      // Deep-link: a valid `?cv=` wins over the master-existence gate — read_cv serves the CV's own
      // stored master snapshot, so it renders even if the workspace master was later cleared.
      if (cvParam) {
        await loadCv(cvParam, () => active);
        return;
      }
      // Entering the bare `/workspace` list (B1 absorbed the dashboard here): clear the deep-link
      // guard so returning to a previously-open `?cv=` — Back/Forward, or re-clicking its card —
      // re-reads it, instead of the `loadedCvRef === cvParam` early-return skipping the load and
      // leaving the list rendered under a CV URL.
      loadedCvRef.current = null;
      // Explicit "‹ Workspace" back action already set phase→idle synchronously; skip the master probe
      // so a cleared master can't flash "needs-master" over the list the user just asked for.
      if (backNavRef.current) {
        backNavRef.current = false;
        if (active) setPhase({ status: "idle" });
        return;
      }
      // No `?cv=`: the existing create-mode gate (idle, or needs-master when the probe reads the
      // master as absent — 200-null, probe parity with the review-latest GET).
      try {
        const master = await api<Schemas["MasterProfile"] | null>(getMasterRequest().path);
        if (active) setPhase(master === null ? { status: "needs-master" } : { status: "idle" });
      } catch (e: unknown) {
        if (!active) return;
        // Session expired since the shell resolved it (domain-call 401) — a 401 here must bounce
        // to sign-in, not drop the user onto the editor.
        if (e instanceof ApiError && e.status === 401) {
          router.replace("/sign-in");
          return;
        }
        // Mid-session revocation: the probe's 403 must NOT fall silently to idle (the old
        // behaviour) — surface the access-removed phase.
        if (e instanceof ApiError && e.status === 403) {
          setPhase({ status: "forbidden" });
          return;
        }
        // 404 arm kept for deploy skew: an old backend still 404s an absent master during the
        // rollout window (removal is a tracked follow-up). Transient errors still fall to idle.
        setPhase(
          e instanceof ApiError && e.status === 404
            ? { status: "needs-master" }
            : { status: "idle" },
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [cvParam, loadCv, router]);

  // Re-check the lock on a Back/bfcache restore: after applying we `router.push("/applications")`,
  // leaving `/workspace?cv=<applied>` in history, and a bfcache restore replays neither the mount
  // effect nor a fresh load (its guard ref is still set). So on `pageshow(persisted)`/visibility we
  // re-run ONLY the `by-cv` check and redirect — never reload the bundle, which would clobber
  // in-memory drafts. A `null` body (not applied) is a no-op.
  useEffect(() => {
    if (!cvParam) return;
    const recheck = () => {
      api<ApplicationSummary | null>(byCvRequest(cvParam).path)
        .then((appn) => {
          if (appn) router.replace(`/applications/${encodeURIComponent(appn.id)}`);
        })
        .catch(() => {});
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) recheck();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cvParam, router]);

  const call = useCallback(<T,>(c: ApiCall): Promise<T> => api<T>(c.path, c.init), []);

  // "Clear review" (persist-until-cleared): delete the persisted run server-side, then wipe every piece
  // of review state so the panel + diff + in-margin markers reset. The DELETE is idempotent (0-row-safe),
  // so clearing a save_failed/never-persisted run still succeeds and the client wipe is the visible effect.
  // Mirrors loadCv's stale-review clear branch (+ checklist + reviewLoadFailed). Diff/inline notes derive
  // from `review`, so they empty for free.
  const clearReview = useCallback(
    (cvId: string) => {
      if (
        !window.confirm(
          "Clear this review? This removes the run, your accept/reject decisions, and the diff.",
        )
      ) {
        return;
      }
      // Wipe the client SYNCHRONOUSLY on confirm — no `await` window in which a `?cv=` switch, the
      // back button (which nulls `loadedCvRef`), or a Re-run could race the wipe (Codex P2). The DELETE
      // is idempotent, so the wipe is the source of truth; fire it in the background and only surface a
      // failure (the row could otherwise rehydrate on a later reload). Mirrors loadCv's clear branch.
      reviewAbortRef.current?.abort();
      reviewInFlightRef.current = false;
      reviewGenRef.current += 1; // invalidate any in-flight review op (a retry GET) — Codex P2
      reviewRef.current = null;
      decisionsRef.current = {};
      pendingRef.current = null;
      persistedFreshRef.current = null; // close the decisions-PUT gate so a late flush drops silently
      setReview(null);
      setDecisions({});
      setChecklist(emptyChecklist());
      setReviewing(false);
      setReviewRestored(false);
      setSaveFailed(false);
      setDecideSaveFailed(false);
      setReviewLoadFailed(false);
      setReviewError(null);
      setReviewAnnounce("");
      focusSoon(panelHeadingRef.current); // Clear unmounts the button — don't strand focus on <body>
      // Gate a Re-run until the DELETE settles: an unconditional latest-only DELETE that lands AFTER a
      // fresh run persisted would remove the new row (Codex P2). The clear is fast (one query), so this
      // is a brief disable, not a spinner.
      setClearing(true);
      clearReleaseWaitRef.current = false;
      void call<Schemas["OkResponse"]>(deleteReviewRequest(cvId))
        .catch((err) => {
          if (mountedRef.current) setMsg({ kind: "bad", text: errText(err) });
        })
        .finally(() => {
          if (!mountedRef.current) return;
          // Don't re-enable Review while a pre-clear decisions PUT is still in flight — a late
          // /review/decisions could otherwise land its old accept/reject onto a same-version re-run
          // (Codex P2). Defer to the flush completion, which releases the gate when it settles.
          if (inFlightRef.current) clearReleaseWaitRef.current = true;
          else setClearing(false);
        });
    },
    [call],
  );

  // After any create, read the persisted bundle back (read-after-create): the server is the
  // authority on the {master, cv} snapshot, so we render exactly what was stored rather than
  // reconstructing it client-side.
  const openCreated = useCallback(
    async (created: Schemas["CreatedCV"]) => {
      const bundle = await call<RenderBundle>(readRequest(created.id));
      loadedCvRef.current = created.id;
      setDrafts({});
      setReviewLoadFailed(false); // a brand-new CV never had a review probe — clear any prior cv's flag
      setPhase({ status: "preview", cvId: created.id, bundle });
      // Make the new CV reload-safe + shareable. The ref guard turns the resulting `?cv=` effect
      // re-run into a no-op (no double-read, no draft clobber).
      router.replace(`/workspace?cv=${encodeURIComponent(created.id)}`);
    },
    [call, router],
  );

  // Retry for the `error` phase: re-read the same cv directly (the `?cv=` param hasn't changed, so the
  // effect won't re-fire on its own).
  const retryLoad = useCallback(() => {
    if (cvParam) loadCv(cvParam);
  }, [cvParam, loadCv]);

  // Retry for a FAILED saved-review probe (the panel's "Retry"). Re-probes ONLY the review for the
  // on-screen cv and rehydrates it in place — unlike `retryLoad` it does NOT reload the bundle or clear
  // drafts (so unsaved edits survive), and it commits only while still on the SAME cv (`loadedCvRef`),
  // so a nav during the probe/backoff is dropped instead of yanking the UI back to a stale document.
  const retryReview = useCallback(async () => {
    const cvId = loadedCvRef.current;
    if (!cvId) return;
    const gen = reviewGenRef.current; // a Clear during this GET must drop the stale rehydrate (Codex P2)
    const loaded = await loadSavedReview(reviewLatestRequest(cvId).path);
    // navigated away OR cleared while in flight → drop the stale commit (never rehydrate a cleared run).
    if (!mountedRef.current || loadedCvRef.current !== cvId || reviewGenRef.current !== gen) return;
    if (!loaded.ok) {
      setReviewLoadFailed(true); // still failing — keep the note + Retry
      return;
    }
    setReviewLoadFailed(false);
    // ok + null → no review is stored for this cv (e.g. a save_failed run) — nothing to rehydrate.
    if (loaded.value) rehydrateReviewState(cvId, loaded.value);
  }, [rehydrateReviewState]);

  const tailor = useCallback(async () => {
    setMsg(null);
    // A failed re-tailor must not discard the current CV — restore the prior preview (with its
    // in-memory drafts) rather than dropping to idle.
    const restore: Phase = phase.status === "preview" ? phase : { status: "idle" };
    setPhase({ status: "parsing" });
    try {
      const jobSpec = await call<Schemas["JobSpec"]>(parseRequest(rawText));
      setPhase({ status: "tailoring" });
      // The stored master is loaded server-side — only the job is sent.
      await openCreated(await call<Schemas["CreatedCV"]>(tailorRequest(jobSpec)));
    } catch (err: unknown) {
      setMsg({ kind: "bad", text: errText(err) });
      setPhase(restore);
    }
  }, [call, rawText, phase, openCreated]);

  // Keyless path: a verbatim draft from the stored master (no AI, no provider key needed).
  const startDraft = useCallback(async () => {
    setMsg(null);
    const restore: Phase = phase.status === "preview" ? phase : { status: "idle" };
    setPhase({ status: "drafting" });
    try {
      await openCreated(await call<Schemas["CreatedCV"]>(fromMasterRequest()));
    } catch (err: unknown) {
      setMsg({ kind: "bad", text: errText(err) });
      setPhase(restore);
    }
  }, [call, phase, openCreated]);

  // Single-flight mutation (edit / sign-off): serialized via `mutating` so two writes can't race.
  // On a 409 (the server's optimistic lock — a concurrent write/stale tab) reload the latest and
  // keep the user's draft so they can re-apply it.
  const mutate = useCallback(
    async (cvId: string, c: ApiCall, onOk: (b: RenderBundle) => void) => {
      setMutating(true);
      setMsg(null);
      try {
        onOk(await call<RenderBundle>(c));
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 409) {
          // An applied CV refuses edits with a `cvLocked` code — it's locked in another tab. Redirect
          // to the tracker rather than reload-retry-409 forever in the editor.
          if (conflictCode(err.message) === "cvLocked") {
            const appn = await call<ApplicationSummary | null>(byCvRequest(cvId)).catch(() => null);
            if (appn) {
              router.replace(`/applications/${encodeURIComponent(appn.id)}`);
              return;
            }
          }
          try {
            const fresh = await call<RenderBundle>(readRequest(cvId));
            setPhase({ status: "preview", cvId, bundle: fresh });
            setMsg({
              kind: "bad",
              text: "This CV changed elsewhere — reloaded the latest. Re-apply your edit and save.",
            });
          } catch (reload: unknown) {
            setMsg({ kind: "bad", text: errText(reload) });
          }
        } else if (err instanceof ApiError && err.status === 403) {
          // Mid-session revocation on a save (de-allowlisted → server 403): the access-removed
          // phase with the pinned copy — the same arm as loadCv — never the raw
          // `{"detail":"Not allowlisted"}` body in the generic banner.
          setPhase({ status: "forbidden" });
        } else {
          setMsg({ kind: "bad", text: errText(err) });
        }
      } finally {
        setMutating(false);
      }
    },
    [call, router],
  );

  const saveBullet = useCallback(
    (cvId: string, bulletId: string, text: string, baseVersion: number) =>
      mutate(cvId, editRequest(cvId, bulletId, text, baseVersion), (bundle) => {
        setDrafts((d) => {
          // Clear the draft ONLY if it still matches what we just saved (normalised both sides). If the
          // user typed a NEWER in-paper edit while this save was in flight, keep that draft so its own
          // blur commits it — an unconditional clear would silently drop the newer edit (DevPR14 race).
          const cur = d[bulletId];
          if (
            cur === undefined ||
            cur.replace(/\s+/g, " ").trim() !== text.replace(/\s+/g, " ").trim()
          )
            return d;
          const { [bulletId]: _saved, ...rest } = d;
          return rest;
        });
        setPhase({ status: "preview", cvId, bundle });
      }),
    [mutate],
  );

  const signOff = useCallback(
    (cvId: string, bulletIds: string[], baseVersion: number) =>
      mutate(cvId, signoffRequest(cvId, bulletIds, baseVersion), (bundle) =>
        setPhase({ status: "preview", cvId, bundle }),
      ),
    [mutate],
  );

  // Fold each SSE frame into the live checklist + the progressively-built ReviewBundle, and capture the
  // terminal RunDone (the spine calls onEvent for it before returning). Functional setState (the reader
  // is long-lived — a closed-over `review` would merge into a stale seed and drop all but the last
  // report); `mountedRef` gates against an unmounted setState.
  const onReviewEvent = useCallback((ev: SseEvent, runCvId: string) => {
    if (!mountedRef.current) return;
    // A within-route CV switch (Back/Forward mid-stream) keeps this reader alive — list↔detail is one
    // component — so a stray frame must not touch ANY run-scoped rail state (checklist, status line,
    // runDoneRef, bundle) unless this run IS the review on screen. POSITIVE match: a null reviewRef
    // (the switched-to CV had no stored review, so loadCv cleared it) is stale too — a truthy-only
    // check would let the old stream's frames repaint the new CV's rail. loadCv aborts on the switch;
    // this whole-body guard is the belt-and-braces (the abort races the last frame or two).
    if (reviewRef.current?.cvId !== runCvId) return;
    setChecklist((c) => reduceChecklist(c, ev));
    setReview((prev) =>
      prev && prev.cvId === runCvId
        ? { ...prev, bundle: reduceReviewBundle(prev.bundle, ev) }
        : prev,
    );
    if (ev.type === "agent_started") setReviewStatusLine(`${reviewAgentLabel(ev.agentId)}…`);
    else if (ev.type === "agent_progress") setReviewStatusLine(ev.note);
    else if (ev.type === "run_done") runDoneRef.current = { ok: ev.ok, detail: ev.detail ?? null };
  }, []);

  // Run the advisory AI review over the stored CV via the SSE fan-out (Fact-Checker + Spotter always,
  // + Editor + Gatekeeper when the CV targets a job). Reports render the moment they land; per-agent
  // failures + a run-level failure surface honestly (invariant 5). Never gates export. `baseVersion`
  // lets the server reject (409) a stale tab BEFORE billing; the bundle is stamped with it (the server
  // reviewed exactly that version). The client rebuilds the bundle from the stream frames (no resultRef
  // GET on stream completion); the run is persisted server-side (ADR 0013) and rehydrated by `loadCv` on
  // the next visit via `reviewLatestRequest`.
  const runReview = useCallback(
    async (cvId: string, baseVersion: number, reviewedText: Record<string, string>) => {
      if (reviewInFlightRef.current) return; // synchronous double-submit guard (state lags a render)
      reviewInFlightRef.current = true;
      setReviewing(true);
      setMsg(null);
      setReviewError(null);
      setReviewAnnounce("");
      setDecisions({}); // a fresh review starts a fresh decision set (dec #6: clear on re-tailor/re-run)
      decisionsRef.current = {};
      pendingRef.current = null;
      persistedFreshRef.current = null; // gate closed until this run persists (run_done ok && !save_failed)
      setReviewRestored(false); // a fresh run is not a restore
      setSaveFailed(false);
      setReviewLoadFailed(false); // a fresh run supersedes a prior failed-load note
      setDecideSaveFailed(false);
      setApplyFeedbackError(null); // clear a prior apply failure so it doesn't linger under the new run
      setChecklist(emptyChecklist());
      setReviewStatusLine("Starting the review…");
      setReview({ cvId, version: baseVersion, bundle: emptyBundle(baseVersion), reviewedText });
      reviewRef.current = { cvId, version: baseVersion };
      reviewCancelledRef.current = false;
      const controller = new AbortController();
      reviewAbortRef.current = controller;
      try {
        const outcome = await consumeSseStream(
          reviewStreamRequest(cvId, baseVersion),
          controller.signal,
          (ev) => onReviewEvent(ev, cvId),
        );
        if (!mountedRef.current) return; // unmounted mid-stream — never setState
        // Superseded-run guard: a within-route CV switch mid-stream repoints `reviewRef` (loadCv's
        // rehydrate/clear). EVERY settle-path write below — error captions, the persisted-fresh
        // gate open (which would re-key decision PUTs to the WRONG cv and silently buffer the
        // on-screen cv's decisions forever), the settle flush, announce, tab flip — must apply
        // only if this run is still the review on screen. The `finally` cleanup still runs.
        if (reviewRef.current?.cvId !== cvId) return;
        if (outcome.kind === "http_error") {
          setReview(null); // discard the seeded empty bundle — nothing was reviewed
          reviewRef.current = null;
          persistedFreshRef.current = null;
          if (outcome.status === 401) {
            router.replace("/sign-in");
            return;
          }
          if (outcome.status === 409) {
            // Stale tab: nothing was reviewed. Reload the latest so the user can re-run on it.
            const fresh = await call<RenderBundle>(readRequest(cvId)).catch(() => null);
            if (mountedRef.current && fresh) setPhase({ status: "preview", cvId, bundle: fresh });
            setMsg({
              kind: "bad",
              text: "This CV changed elsewhere — reloaded the latest. Review it again.",
            });
          } else if (outcome.status === 503) {
            setMsg({
              kind: "bad",
              text: "The AI reviewers aren't configured — set both provider keys in Admin (/admin).",
            });
          } else {
            setMsg({ kind: "bad", text: outcome.detail || "Review failed." });
          }
          return;
        }
        if (outcome.kind === "run_done") {
          // ok: keep the progressively-built bundle (reviewFresh shows it). !ok: a run-level failure —
          // keep whatever landed, surface honestly (never the raw exception class name).
          if (!outcome.ok) {
            // `onReviewEvent` set runDoneRef on the run_done frame this same run (the outcome IS that
            // frame), so this read is always current; finally clears it for the next run.
            const detail = runDoneRef.current?.detail ?? null;
            const msg = `Review couldn't complete — ${detail ? failureLabel(detail) : "re-run"}.`;
            setReviewError(msg);
            setReviewAnnounce(msg);
          } else {
            // ok — BUT a `RunDone(ok=true, detail="save_failed")` means the review completed yet couldn't
            // be persisted (ADR 0013). Only a truly-persisted run opens the decisions PUT gate; a
            // save_failed run keeps decisions LOCAL for this session + shows the degraded rail note.
            const detail = runDoneRef.current?.detail ?? null;
            if (detail === "save_failed") {
              setSaveFailed(true);
              persistedFreshRef.current = null;
            } else {
              persistedFreshRef.current = cvId; // gate open: this run's row is stored → PUTs allowed
              // Settle flush: persist any decisions made MID-stream (they only buffered while reviewing).
              // Read the REF, not render-scope state (this closure holds the post-reset `{}`), pinned to
              // the run's cvId via the gate + reviewRef.
              if (Object.keys(decisionsRef.current).length > 0) {
                pendingRef.current = decisionsRef.current;
                flushDecisionsRef.current();
              }
            }
            setReviewAnnounce("Review complete.");
            // Surface the results at narrow widths + take focus to them — BUT only if the user isn't
            // mid-edit in a bullet (flipping to Reviewers would hide their textarea out from under
            // them; at desktop the flip is a no-op since all panes show) and hasn't tabbed away to a
            // control elsewhere on the page (don't steal focus — WCAG 3.2.5).
            if (autoFocusOnSettle(wsRootRef.current)) {
              setWsTab("reviewers");
              focusSoon(panelHeadingRef.current);
            }
          }
          return;
        }
        // dropped: keep partial reports; distinguish a deliberate Stop from a passive drop.
        {
          const msg = reviewCancelledRef.current
            ? "You stopped the review — re-run when ready."
            : "Review interrupted — re-run.";
          setReviewError(msg);
          setReviewAnnounce(msg);
        }
      } finally {
        reviewAbortRef.current = null;
        reviewInFlightRef.current = false;
        runDoneRef.current = null; // hygiene for the next run (after this run's read)
        if (mountedRef.current) setReviewing(false);
      }
    },
    [call, router, onReviewEvent],
  );

  const cancelReview = useCallback(() => {
    reviewCancelledRef.current = true;
    reviewAbortRef.current?.abort();
  }, []);

  // Abort an in-flight review on unmount (navigation/apply) so the reader can't setState after teardown.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reviewAbortRef.current?.abort();
    };
  }, []);

  // Keepalive flush (S4 / DevPR23): on pagehide / tab-hidden, best-effort persist the buffered decisions
  // via fetch(keepalive:true) so a click made just before leaving isn't lost. Best-effort ONLY — the
  // contract stays click-time persistence; fires only when the gate is set, and skips a payload over
  // ~60KB (keepalive's 64KB cap is reachable at the schema's decision bounds).
  useEffect(() => {
    const beacon = () => {
      const meta = reviewRef.current;
      if (!meta || persistedFreshRef.current !== meta.cvId) return; // gate closed → nothing to persist
      const pending = pendingRef.current;
      if (pending === null) return;
      const req = saveDecisionsRequest(meta.cvId, pending, meta.version);
      const payload = typeof req.init?.body === "string" ? req.init.body : "";
      if (payload.length > 60_000) return; // over the keepalive budget — the click-time PUT is the path
      void fetch(req.path, {
        ...req.init,
        credentials: "include",
        headers: { "content-type": "application/json" },
        keepalive: true,
      }).catch(() => {});
    };
    const onPageHide = () => beacon();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") beacon();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Export is version-guarded: a stale tab must not export a CV newer than the one it's showing
  // ("what you see is what you export"). Open the tab synchronously inside the click gesture (or a
  // popup blocker kills it), re-check the server version, then navigate it to the export — or close
  // it and reload the preview if another tab advanced the CV.
  const exportAs = useCallback(
    async (cvId: string, baseVersion: number, kind: "pdf" | "docx" | "text") => {
      const win = window.open("", "_blank");
      if (!win) {
        setMsg({ kind: "bad", text: "Allow pop-ups for this site to export." });
        return;
      }
      setMutating(true);
      setMsg(null);
      try {
        const fresh = await call<RenderBundle>(readRequest(cvId));
        if (fresh.cv.version !== baseVersion) {
          win.close();
          setPhase({ status: "preview", cvId, bundle: fresh });
          setMsg({
            kind: "bad",
            text: "This CV changed elsewhere — reloaded the latest. Review it, then export.",
          });
          return;
        }
        win.location.href = exportUrl(cvId, kind);
      } catch (err: unknown) {
        win.close();
        setMsg({ kind: "bad", text: errText(err) });
      } finally {
        setMutating(false);
      }
    },
    [call],
  );

  // Apply: lock the finished CV to a job and move it to the tracker. POST with the version the user is
  // viewing — `canExport` already guarantees no unsaved drafts, and apply is a normal fetch that can
  // read the 409 body, so there's no exportAs-style pre-read. Branch the server's machine `code`:
  // a recoverable in-dialog failure (422 / generic) keeps the dialog open with the typed values; a
  // CV-changed-underneath 409 closes it, reloads the latest, and asks the user to review.
  const doApply = useCallback(
    async (
      cvId: string,
      baseVersion: number,
      fields: { jobTitle: string; company: string; jobUrl: string; note: string },
    ) => {
      if (applyInFlightRef.current) return;
      applyInFlightRef.current = true;
      const trimmed = (s: string): string | undefined => (s.trim() === "" ? undefined : s.trim());
      setApplying(true);
      setApplyError(null);
      try {
        await call<Schemas["Application"]>(
          applyRequest({
            cvId,
            baseVersion,
            jobTitle: trimmed(fields.jobTitle),
            company: trimmed(fields.company),
            jobUrl: trimmed(fields.jobUrl),
            note: trimmed(fields.note),
          }),
        );
        setShowApply(false);
        router.push("/applications");
      } catch (err: unknown) {
        if (!(err instanceof ApiError)) {
          setApplyError("Something went wrong — try again.");
          return;
        }
        if (err.status === 422) {
          setApplyError("Enter a job title to track this application.");
          return;
        }
        const code = conflictCode(err.message);
        if (code === "alreadyApplied") {
          setShowApply(false);
          router.push("/applications");
          return;
        }
        if (err.status === 409 && (code === "stale" || blockedBulletIds(err.message).length > 0)) {
          // The CV advanced elsewhere, or a net-new bullet is unsigned again — reload + ask to review.
          setShowApply(false);
          await loadCv(cvId);
          setMsg({ kind: "bad", text: "This CV changed — review it, then apply again." });
          return;
        }
        // Any other status (500, or a 403/404 after a session role change) — don't leak the raw body.
        setApplyError("Couldn’t apply this CV — please try again.");
      } finally {
        applyInFlightRef.current = false;
        setApplying(false);
      }
    },
    [call, router, loadCv],
  );

  // Apply the accepted review threads as Corrector rewrites → a re-grounded RenderBundle (PR-4). The
  // gate already guarantees ≥1 accepted thread + no unsaved drafts. Single-flight; the Claude call is
  // multi-second with no SSE, so announce start/finish via the one polite region. On success reload
  // the bundle, clear review + decisions, and clear drafts (a stale no-op draft would overlay the OLD
  // text over the correction → preview ≠ PDF, invariant 3); `canExport`/`unsigned` re-derive from it.
  const applyFeedback = useCallback(
    async (cvId: string, baseVersion: number, threads: Schemas["AcceptedThread"][]) => {
      if (applyFeedbackInFlightRef.current) return;
      applyFeedbackInFlightRef.current = true;
      setApplyingFeedback(true);
      setApplyFeedbackError(null);
      setMsg(null); // clear a lingering stale/review banner so it can't survive a successful apply
      setReviewAnnounce("Applying corrections…");
      // Paint each accepted bullet's suggested text NOW (render-only overlay); the server's re-grounded
      // bundle reconciles it on success. Cleared in `finally` on every path (success/409/422/503) so a
      // failure can't strand fake text — export stays blocked by `writeBusy` during the window.
      const paint: Record<string, string> = {};
      for (const t of threads) if (t.suggestedRevision) paint[t.anchorId] = t.suggestedRevision;
      setOptimistic(paint);
      try {
        const next = await call<RenderBundle>(applyFeedbackRequest(cvId, baseVersion, threads));
        if (!mountedRef.current) return;
        setPhase({ status: "preview", cvId, bundle: next });
        setDrafts({});
        // ADR 0014: KEEP the review — don't tear it down. Mark the applied bullets resolved (mirroring
        // the server's `resolvedAnchorIds`) so ONLY their notes flip to a ✓ chip; the review stays at
        // its reviewed version, so the whole-CV verdict shows stale-marked (drift is a presentation
        // signal — ADR 0016 keeps drifted surfaces visible, never hidden) while the candidate's
        // OTHER inline notes stay live. `reviewRef` (cvId/version), the persisted-gate refs
        // (`persistedFreshRef`/`reviewRestored`/`saveFailed`), and buffered `pendingRef` are ALL left
        // untouched: a persisted review keeps PUTting surviving-note dismissals; a save_failed
        // (in-memory-only) one keeps its null gate. Decisions are left intact too — a resolved bullet
        // is non-actionable (`isAcceptableThread` gates on `resolved`), so a lingering accept is inert,
        // while other staged accepts survive for a later batch Apply. The functional update no-ops if
        // history-nav moved the review off this CV mid-apply (never mark the wrong run resolved).
        const appliedIds = threads.map((t) => t.anchorId);
        setReview((r) =>
          r && r.cvId === cvId
            ? {
                ...r,
                bundle: {
                  ...r.bundle,
                  resolvedAnchorIds: [...new Set([...r.bundle.resolvedAnchorIds, ...appliedIds])],
                },
              }
            : r,
        );
        setDecideSaveFailed(false); // apply success clears the soft decision-save note (S4)
        // The Diff subview derives from review.reviewedText vs the re-grounded CV (ADR 0015) — nothing to
        // capture here; it recomputes from persisted state and survives navigation.
        const unsignedNow = collectUnsignedBulletIds(next.cv).length;
        setReviewAnnounce(
          `Applied ${threads.length} correction${threads.length > 1 ? "s" : ""}.${
            unsignedNow > 0
              ? ` ${unsignedNow} bullet${unsignedNow > 1 ? "s" : ""} now need sign-off.`
              : ""
          }`,
        );
        // Flash the freshly-corrected preview (overlay band, never a template bullet — invariant 3);
        // at narrow widths switch to the Preview tab so the flash is visible and move focus to the
        // (visible) preview pane — NOT the review heading, which is hidden on the Preview tab. Both the
        // tab flip and the focus move are gated by autoFocusOnSettle (same as the review handler) so an
        // apply that settles while the user tabbed away can't yank their pane/focus (WCAG 3.2.5).
        flashNonceRef.current += 1;
        setFlash(flashNonceRef.current);
        if (autoFocusOnSettle(wsRootRef.current)) {
          setWsTab("preview");
          focusSoon(previewPaneRef.current);
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        if (err instanceof ApiError && err.status === 409) {
          // cvLocked → loadCv redirects a locked CV to the tracker; any other 409 is a concurrent
          // change → reload + ask to re-review (the apply route's stale 409 is a plain detail body).
          await loadCv(cvId);
          if (conflictCode(err.message) !== "cvLocked") {
            setMsg({ kind: "bad", text: "This CV changed — review it again, then apply." });
          }
          return;
        }
        const text =
          err instanceof ApiError && err.status === 503
            ? "The AI reviewers aren't configured — set both provider keys in Admin (/admin)."
            : err instanceof ApiError && err.status === 422
              ? "Couldn’t apply those corrections — reload and re-run Review."
              : err instanceof ApiError && err.status === 502
                ? "The corrector had trouble responding — try Apply again." // parse/truncation, not config
                : errText(err);
        setApplyFeedbackError(text);
        setReviewAnnounce(text); // shown in the silent panel slot, so announce it (one region, dec #9)
      } finally {
        applyFeedbackInFlightRef.current = false;
        if (mountedRef.current) {
          setApplyingFeedback(false);
          // Reconcile: on success the server bundle (setPhase) already holds the re-grounded text, so
          // dropping the overlay is seamless; on any failure this rolls the optimistic paint back.
          setOptimistic({});
        }
      }
    },
    [call, loadCv],
  );

  // --- Decisions autosave (S4 / ADR 0013): single-flight, trailing-latest PUT of the WHOLE snapshot ---
  // A PUT fires ONLY when `persistedFreshRef` equals the current review's cvId (a persisted run). On
  // failure we keep `pending` and show ONE soft note — NO auto-retry (the next click/flush re-drives);
  // a failure that lands after the gate moved off this cvId (apply/cv-switch race) drops SILENTLY. A 409
  // (version mismatch) is treated like a live error: buffer + note.
  const flushDecisions = useCallback(() => {
    if (inFlightRef.current) return; // single-flight; the trailing value re-flushes on completion
    const meta = reviewRef.current;
    if (!meta || persistedFreshRef.current !== meta.cvId) return; // gate unset/mismatched → buffer only
    const pending = pendingRef.current;
    if (pending === null) return; // nothing new to persist
    inFlightRef.current = true;
    const { cvId, version } = meta;
    const req = saveDecisionsRequest(cvId, pending, version);
    api<Schemas["OkResponse"]>(req.path, req.init)
      .then(() => {
        inFlightRef.current = false;
        // A clear deferred re-enabling Review until this in-flight PUT settled (Codex P2) — release now.
        if (clearReleaseWaitRef.current && mountedRef.current) {
          clearReleaseWaitRef.current = false;
          setClearing(false);
        }
        if (pendingRef.current === pending) pendingRef.current = null; // saved exactly this snapshot
        if (mountedRef.current) setDecideSaveFailed(false);
        // Trailing-latest: a newer decision that arrived mid-flight is still buffered → flush it now.
        if (pendingRef.current !== null && mountedRef.current) flushDecisionsRef.current();
      })
      .catch(() => {
        inFlightRef.current = false;
        if (clearReleaseWaitRef.current && mountedRef.current) {
          clearReleaseWaitRef.current = false;
          setClearing(false);
        }
        // The gate OR the on-screen review moved off this cvId while in flight (apply/cv-switch
        // race) → drop THIS failure silently (never caption another cv's rail for it) — but a
        // decision for the CURRENT cv may have buffered while this obsolete PUT was in flight;
        // kick the trailing flush so it isn't stranded until the next click (flushDecisions
        // itself re-validates the gate ↔ on-screen review before sending anything).
        if (
          persistedFreshRef.current !== cvId ||
          reviewRef.current?.cvId !== cvId ||
          !mountedRef.current
        ) {
          if (pendingRef.current !== null && mountedRef.current) flushDecisionsRef.current();
          return;
        }
        setDecideSaveFailed(true); // keep `pending`; the next click/flush retries it
      });
  }, []);
  flushDecisionsRef.current = flushDecisions;

  // Buffer the latest decisions snapshot + attempt a flush (called from onDecide + the settle flush).
  const syncDecisions = useCallback(
    (next: Decisions) => {
      pendingRef.current = next;
      flushDecisions();
    },
    [flushDecisions],
  );

  // The single parent-owned decisions handler (replaces EditorPanel's `setDecisions` + PreviewPanel's
  // inline `decide`): take a post-toggle snapshot from the REF (synchronous, race-proof under rapid
  // clicks), write through the ref + state, then enqueue exactly that snapshot for persistence.
  const onDecide = useCallback(
    (key: string, d: ThreadDecision) => {
      const next = decide(decisionsRef.current, key, d);
      decisionsRef.current = next;
      setDecisions(next);
      syncDecisions(next);
    },
    [syncDecisions],
  );

  const preview = phase.status === "preview" ? phase : null;
  const bundle = preview?.bundle ?? null;
  // Land each newly-loaded/created CV on the Preview pane at narrow widths (the default only applies on
  // first mount). Keyed on cvId, so it does NOT fire on review/apply of the same CV (those set the tab
  // themselves) — only when a different CV becomes active.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on cvId alone.
  useEffect(() => {
    setWsTab("preview");
  }, [preview?.cvId]);
  const working =
    phase.status === "parsing" || phase.status === "tailoring" || phase.status === "drafting";
  const busyLabel =
    phase.status === "parsing" ? "Parsing…" : phase.status === "tailoring" ? "Tailoring…" : null;

  const workById = useMemo(
    () => new Map((bundle?.master.work ?? []).map((w) => [w.id, w])),
    [bundle],
  );
  // Persisted bullet text by id — lets the in-paper commit (blur) skip a no-op save (which would
  // version-bump the CV and stale the review/diff for nothing).
  const bulletTextById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of bundle?.cv.sections ?? [])
      for (const it of s.items) for (const b of it.highlights) m.set(b.bulletId, b.text);
    return m;
  }, [bundle]);
  // Commit an in-paper edit on blur (DevPR14). Guarded by `applyFeedbackInFlightRef` so the blur that
  // fires when a correction-apply re-render strips contentEditable doesn't resurrect a draft after the
  // apply cleared them (mechanism #3 — the ref spans the whole apply-settle window, unlike the
  // `applyingFeedback` state which resets in `finally`). A no-op (unchanged after normalising the
  // contentEditable's whitespace) just drops the transient draft; the server `/edit` re-trims + bounds.
  const commitPaperBullet = (bulletId: string, text: string) => {
    if (applyFeedbackInFlightRef.current || !preview) return;
    // No draft → the user focused/blurred WITHOUT editing → never touch it (a commit would version-bump
    // for nothing). A draft exists only after a real `input`.
    if (drafts[bulletId] === undefined) return;
    const persisted = bulletTextById.get(bulletId);
    const normalized = text.replace(/\s+/g, " ").trim();
    // Compare with the SAME normalisation on both sides so a whitespace-only diff isn't a "change".
    if (persisted === undefined || normalized === persisted.replace(/\s+/g, " ").trim()) {
      setDrafts((d) => {
        const { [bulletId]: _omit, ...rest } = d;
        return rest;
      });
      return;
    }
    saveBullet(preview.cvId, bulletId, normalized, preview.bundle.cv.version);
  };
  // DevPR16: the left navigator jumps to + focuses the matching bullet on the CV paper (the single
  // editable surface). `setWsTab` brings the paper into view at narrow widths (panes stay mounted); the
  // setTimeout(0) is the shipped focusSoon defer-past-render pattern. Scroll always lands the user on the
  // line (reduced-motion honoured); focus only when the bullet is currently contentEditable — while a
  // write is in flight PreviewPanel suspends edits, so the bullet is a plain <div> and focus would no-op.
  const selectBullet = (bulletId: string) => {
    setWsTab("preview");
    setTimeout(() => {
      const el = previewPaneRef.current?.querySelector<HTMLElement>(
        `[data-bullet-id="${CSS.escape(bulletId)}"]`,
      );
      if (!el) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      if (el.isContentEditable) el.focus({ preventScroll: true });
    }, 0);
  };
  const unsigned = bundle ? collectUnsignedBulletIds(bundle.cv) : [];
  const dirty = bundle ? dirtyBulletIds(bundle, drafts) : [];
  // Any in-flight WRITE/billed op — gates Save / Sign-off / Review / Tailor / apply so two writers
  // can't race the same CV (the tracker `applying` navigates away; folded in for completeness).
  const writeBusy = mutating || applyingFeedback || applying;
  // `busy` adds the advisory review. Export is the EXCEPTION: an in-progress review never blocks
  // exporting an already-clean CV (the review is advisory, invariant 2), so it uses `writeBusy`.
  const busy = writeBusy || reviewing;
  const canExport = !!bundle && unsigned.length === 0 && dirty.length === 0 && !writeBusy;
  // Why export is blocked, prioritised so the reason names the FIRST thing to fix: unsaved edits block
  // BOTH sign-off and export, so they lead (and mention sign-off too if also pending); then unsigned
  // net-new bullets; then an in-flight write. One source for the bar's accessible name + tooltip.
  const exportBlockedReason: string | null = canExport
    ? null
    : dirty.length > 0
      ? unsigned.length > 0
        ? `Export blocked — save your edits first, then sign off ${unsigned.length} net-new bullet${unsigned.length > 1 ? "s" : ""}`
        : "Export blocked — save your edits first"
      : unsigned.length > 0
        ? `Export blocked — ${unsigned.length} net-new bullet${unsigned.length > 1 ? "s" : ""} need sign-off`
        : writeBusy
          ? "Export blocked — finish the current action first"
          : "Export blocked";
  // TWO-LEVEL freshness (dec #1, revised by ADR 0016). The Gatekeeper verdict + non-bullet panel
  // threads are whole-CV judgments a single edit invalidates — but a version drift now marks them
  // STALE instead of hiding them (a committed Save/Apply bumps cv.version → each region's single
  // carrier shows the canonical stale phrase / "Out of date" chip; nothing vanishes, invariant 5
  // honest both ways). Bullet inline notes stay SAME-cv, stale PER-bullet (the snapshot catches a
  // saved-text drift the deleted draft can't). The in-flight stream renders independently (on
  // `reviewing`), so a keystroke never blanks it.
  const reviewSameCv = review !== null && !!preview && !!bundle && review.cvId === preview.cvId;
  const reviewVersionFresh =
    reviewSameCv && review !== null && review.version === bundle?.cv.version;
  const versionDrifted = reviewSameCv && !reviewVersionFresh;
  // Verdict + panel threads — SAME-cv (stale-marked when drifted), no longer version-gated (ADR 0016).
  const panelBundle = reviewSameCv && review ? review.bundle : null;
  const inlineThreads = reviewSameCv && review ? collectThreads(review.bundle) : []; // bullet notes
  const editableIds = bundle ? editableBulletIds(bundle.cv) : new Set<string>();
  const staleIds =
    reviewSameCv && review && bundle
      ? staleReviewBulletIds(review.reviewedText, bundle.cv, drafts)
      : new Set<string>();
  // The Diff (ADR 0015): every bullet whose SAVED text now differs from the review-start baseline
  // (`reviewedText`) — cumulative across applies + manual edits, and derived (both inputs rehydrate on
  // remount, so it survives navigation). Saved CV, not the draft overlay, so an unsaved keystroke never
  // shows as a change. `review===null` → []. Plain const (above the early returns) — no hook ordering.
  const changedSinceReview =
    reviewSameCv && review && preview
      ? diffChangedBulletsFromSnapshot(review.reviewedText, preview.bundle.cv)
      : [];
  const hasLiveDiff = changedSinceReview.length > 0;
  // Batch "Apply corrections" is whole-bullet like the in-paper path: accepting one note on a line
  // consumes the whole line (ADR 0014), so fold each accepted bullet's non-rejected siblings in — else
  // an undecided sibling is silently resolved-and-dropped. Honest count + payload from ONE projection.
  const foldedDecisions = foldSameBulletDecisions(decisions, inlineThreads);
  // ONE accepted projection feeds the Apply button, the inline count, and the POST (dec #4).
  const accepted = acceptedThreads(inlineThreads, foldedDecisions, staleIds, editableIds);
  const canApply = canApplyCorrections({
    acceptedCount: accepted.length,
    dirty: dirty.length,
    busy,
  });
  // Render the Apply control whenever ≥1 editable-bullet thread exists (stale or not) so its disabled
  // reason can show even when every accept just went stale (R2-ui5).
  const hasEligibleInline = inlineThreads.some((t) =>
    isAcceptableThread(t, new Set<string>(), editableIds),
  );
  const anyAcceptedDecision = inlineThreads.some((t) => decisions[t.key] === "accepted");
  // Reviewers-tab badge: ACTIONABLE inline notes still awaiting attention — bullet-anchored on an
  // editable bullet, not stale, not a supported fact-check (isAcceptableThread), and not yet rejected
  // (undecided or accepted ≈ the design's open+working). Excludes panel-only / section / supported
  // notes so the count matches what the user can act on. 0 hides the badge.
  const reviewerNoteCount = inlineThreads.filter(
    (t) => isAcceptableThread(t, staleIds, editableIds) && decisions[t.key] !== "rejected",
  ).length;
  const applyDisabledReason = applyingFeedback
    ? "Applying…"
    : dirty.length > 0
      ? "Save your edits first."
      : accepted.length === 0 && anyAcceptedDecision
        ? "Your accepted notes are stale — re-run Review."
        : accepted.length === 0
          ? "Accept a bullet note to apply."
          : null;

  if (phase.status === "not-found") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <section style={{ ...card, maxWidth: 440, textAlign: "center" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>CV not found</h1>
          <p style={{ margin: "0 0 16px", color: "var(--text-2)", fontSize: 13, lineHeight: 1.5 }}>
            This tailored CV doesn&rsquo;t exist or was removed — the link may be wrong, or it was
            deleted.
          </p>
          <a href="/" style={backLink}>
            Back to your CVs →
          </a>
        </section>
      </div>
    );
  }

  if (phase.status === "error") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <section style={{ ...card, maxWidth: 440, textAlign: "center" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>Couldn&rsquo;t load this CV</h1>
          <p style={{ margin: "0 0 16px", color: "var(--text-2)", fontSize: 13, lineHeight: 1.5 }}>
            {phase.message}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={retryLoad} style={primaryBtn(false)}>
              Try again
            </button>
            <a href="/" style={{ ...ghostBtn(false), textDecoration: "none" }}>
              Back to your CVs
            </a>
          </div>
        </section>
      </div>
    );
  }

  if (phase.status === "needs-master") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <section style={{ ...card, maxWidth: 440, textAlign: "center" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>Set up your CV first</h1>
          <p style={{ margin: "0 0 16px", color: "var(--text-2)", fontSize: 13, lineHeight: 1.5 }}>
            The Workspace tailors and drafts from your master CV. Add your experience once — no AI
            or API key needed — then come back here to draft or tailor.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <a
              href="/master"
              style={{
                display: "inline-block",
                background: "var(--accent)",
                color: "var(--on-accent)",
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
                borderRadius: 9,
                padding: "9px 16px",
              }}
            >
              Edit your CV →
            </a>
            <a
              href="/master?import=1"
              style={{
                display: "inline-block",
                border: "1px solid var(--line-strong)",
                color: "var(--text-2)",
                fontSize: 13,
                textDecoration: "none",
                borderRadius: 9,
                padding: "9px 16px",
              }}
            >
              Import from a CV / LinkedIn doc
            </a>
          </div>
        </section>
      </div>
    );
  }

  if (phase.status === "loading" || phase.status === "forbidden") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <span
          style={{
            ...mono,
            fontSize: 12,
            color: "var(--text-3)",
            textAlign: "center",
            maxWidth: 360,
          }}
        >
          {phase.status === "forbidden"
            ? "Your access was removed — sign in with an allowlisted account."
            : "Checking your session…"}
        </span>
      </div>
    );
  }

  // Gatekeeper subview (B3) — a `?view=gatekeeper` mode of this route (ADR 0011): the live, per-CV
  // recruiter/ATS verdict from the in-session review, with the designed empty/stale states when there's
  // none. Owner-only (the whole Workspace is). Placed before the idle/main returns so the param wins.
  if (viewParam === "gatekeeper") {
    const verdict = panelBundle?.gatekeeper ?? null;
    const backToCv = () =>
      preview && router.push(`/workspace?cv=${encodeURIComponent(preview.cvId)}`);
    if (verdict && preview) {
      const jobSpec = preview.bundle.jobSpec ?? null;
      return (
        <GatekeeperView
          verdict={verdict}
          jobSpec={jobSpec}
          mustHaves={gatekeeperMustHaves(jobSpec, verdict)}
          keywords={gatekeeperKeywords(jobSpec, verdict)}
          // Pure builder (logic.ts): applied = resolved AND bullet-anchored (ADR 0014's
          // resolvedAnchorIds holds bulletIds only — a cross-kind id collision must not read
          // applied). `versionDrifted` splits the blocked fall-through: `stale` (banner-explained,
          // no tag) only when drifted; a fresh review's draft-blocked bullet reads `blocked-dirty`.
          fixes={gatekeeperFixes(
            inlineThreads,
            preview.bundle.cv,
            staleIds,
            editableIds,
            versionDrifted,
          )}
          // A drifted verdict renders the full read under ONE stale banner (ADR 0016) — the region's
          // single carrier — instead of the old GatekeeperEmpty("drifted") swap.
          stale={versionDrifted}
          onBack={backToCv}
          // Bullet-anchored fixes are correctable in the editor's accept→Corrector flow — take the user
          // there (the inline note renders on its bullet). Land on the Editor tab at narrow widths.
          onOpenFix={() => {
            setWsTab("editor");
            backToCv();
          }}
        />
      );
    }
    // The empty/stale reason keys off the REAL signals, not the absent verdict (invariant 5 — a null
    // `gatekeeper` field alone can't tell a no-job draft from a failed agent from a never-run review).
    // `reviewFailed` = a settled run-level failure for THIS cv (so it reads "failed", not "never
    // reviewed"); the precedence lives in `gatekeeperEmptyReason` (pure + unit-tested). `panelBundle`
    // is same-cv since ADR 0016, so gate `gateFailed` HERE with `!versionDrifted` (a drifted run's
    // old failure must read "drifted", not "failed") — the pure precedence itself is NOT reordered
    // (failed-before-running stays correct for a live run).
    const gateFailed =
      !versionDrifted && (panelBundle?.failures.some((f) => f.agentId === "gatekeeper") ?? false);
    const reason = gatekeeperEmptyReason({
      hasPreview: !!preview,
      hasJobSpec: !!preview?.bundle.jobSpec,
      gateFailed,
      reviewing,
      versionDrifted,
      reviewFailed: reviewSameCv && reviewError !== null,
    });
    return (
      <GatekeeperEmpty
        reason={reason}
        onBack={backToCv}
        onOpenWorkspace={() => router.push("/workspace")}
      />
    );
  }

  // Diff subview (ADR 0015) — a `?view=diff` mode of this route: every bullet whose saved text now
  // differs from the review-start baseline (`changedSinceReview`), derived + cumulative + neutral. It
  // recomputes from persisted state on each visit, so it survives navigation/reload (no captured copy,
  // no stale state). `changedSinceReview` is [] without a same-cv review → graceful empty state.
  if (viewParam === "diff") {
    // Exit always returns to the loaded doc (cv-preserving); only a no-cv arrival falls to the list.
    const exitToDoc = () =>
      preview
        ? router.push(`/workspace?cv=${encodeURIComponent(preview.cvId)}`)
        : router.push("/workspace");
    return <DiffView bullets={changedSinceReview} onExit={exitToDoc} />;
  }

  // No ?cv=: the Workspace landing absorbs the old Home dashboard — the owner's CVs as application
  // cards + the New-application modal. (needs-master is handled above; this branch means a master exists.)
  if (phase.status === "idle") {
    return (
      <WorkspaceList
        tailorReadiness={aiReadiness}
        focusHeadingOnMount={focusListHeading}
        onHeadingFocused={onListHeadingFocused}
      />
    );
  }

  return (
    <div className="ws-page">
      {/* The contextual top bar: back to the application list + "Tailoring to <role>" on
          the left; the live Gatekeeper verdict + Posting + Tailor + sign-off/Export + Applied on the
          right. The 3-format export collapses into one Export ▾ menu; when export is blocked it becomes
          a non-actionable "Export blocked" pill (the Sign off N action carries the fix). Keyless drafts
          (no jobSpec) omit the Tailoring-to/verdict/Posting affordances. DevPR13 makes this the
          full-bleed viewport-bound shell bar. */}
      <header
        className="ws-topbar"
        style={{
          minHeight: 54,
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            onClick={() => {
              // Drafts are an unsaved client overlay (Save persists them); navigating away drops them.
              // Confirm before discarding rather than disable — the user may intend to leave.
              if (
                dirty.length > 0 &&
                !window.confirm("You have unsaved edits that will be lost. Leave anyway?")
              ) {
                return;
              }
              // Switch to the list DETERMINISTICALLY rather than relying on the `useSearchParams`
              // effect re-firing on a same-route query-only nav (the Bug-2 failure). Keep the SOFT
              // nav so an in-flight advisory review stream survives (see the disabled-gate note below).
              backNavRef.current = true;
              setFocusListHeading(true);
              loadedCvRef.current = null;
              setPhase({ status: "idle" });
              router.push("/workspace");
            }}
            // Gate on WRITE ops only, NOT `busy` — an in-flight AI review is advisory (invariant 2), so
            // it must never block leaving. Navigating to the LIST does NOT unmount (list↔detail is one
            // component), so the stream keeps running there and, if it reaches RunDone, persists +
            // rehydrates on the next visit. We deliberately do NOT abort on this click (an abort would
            // cancel the server task before it saves). Caveat: this only KEEPS an incomplete run alive
            // while the document lives — a later HARD nav from the list (a raw-`<a>` cv card / new-draft
            // `location.assign`) or a reload tears the fetch down and abandons a not-yet-settled run.
            // That's acceptable: the review is advisory and re-runnable (same as the always-allowed
            // browser Back). `working` (an unpersisted tailor) and `writeBusy` (a mid-apply setPhase would pop the editor back up)
            // still gate.
            disabled={working || writeBusy}
            title={
              working || writeBusy
                ? "Finish the current action first"
                : dirty.length > 0
                  ? "You have unsaved edits — leaving will discard them"
                  : "Back to your workspace"
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              minHeight: 44,
              padding: "0 11px 0 8px",
              borderRadius: 8,
              border: "1px solid var(--line)",
              background: "transparent",
              color: "var(--text-2)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: working || writeBusy ? "default" : "pointer",
              opacity: working || writeBusy ? 0.55 : 1,
            }}
          >
            <span aria-hidden>‹</span> Workspace
          </button>
          <h1
            style={{
              margin: 0,
              minWidth: 0,
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {preview?.bundle.jobSpec?.company ?? BRAND_NAME}
          </h1>
          {/* Persistent entry to the Diff — gated on hasLiveDiff ALONE (not the jobSpec block below), so
              a manual-edit-only session with no open marker can still reach it. Low-emphasis, flex:none. */}
          {hasLiveDiff && preview ? (
            <button
              type="button"
              className="cos-ghostbtn"
              onClick={() =>
                router.push(`/workspace?cv=${encodeURIComponent(preview.cvId)}&view=diff`)
              }
              style={{
                flex: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                // 44px touch target (matches the workspace's other actions) — keep the compact look
                // via padding, not a short box. Codex P2.
                minHeight: 44,
                padding: "0 11px",
                borderRadius: 7,
                border: "1px solid var(--line)",
                background: "transparent",
                color: "var(--text-2)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              View diff
            </button>
          ) : null}
          {preview?.bundle.jobSpec ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
                paddingLeft: 13,
                borderLeft: "1px solid var(--line)",
              }}
            >
              <span
                style={{
                  ...mono,
                  fontSize: 10,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "var(--text-3)",
                  flex: "none",
                }}
              >
                Tailoring to
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: "var(--text)",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {preview.bundle.jobSpec.title}
              </span>
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          {/* The live Gatekeeper verdict — whenever a same-cv review carries one (stale-marked with
              an "Out of date" chip when version-drifted, ADR 0016); opens the full Gatekeeper subview
              preserving `?cv=`. Extracted to the presentational `TopbarVerdict` (testable header
              region); the visible "<decision> <score>/100" stays in the accessible name (WCAG 2.5.3). */}
          {panelBundle?.gatekeeper && preview ? (
            <TopbarVerdict
              verdict={panelBundle.gatekeeper}
              stale={versionDrifted}
              onOpen={() =>
                router.push(`/workspace?cv=${encodeURIComponent(preview.cvId)}&view=gatekeeper`)
              }
            />
          ) : null}
          {preview?.bundle.jobSpec ? (
            <button
              type="button"
              onClick={() => setShowPosting(true)}
              style={buttonStyle("ghostLink")}
            >
              Posting
            </button>
          ) : null}
          {/* Tailor / re-tailor against the job-posting text in the left column — moved out of the job
              card into the bar. A definitive `not-ready` swaps it for a one-click Admin nudge. */}
          {aiReadiness === "not-ready" ? (
            <a
              href="/admin"
              style={{ ...buttonStyle("ghostLink"), textDecoration: "none" }}
              title="Add a provider key + a strong-tier model in Admin to enable AI tailoring"
            >
              Configure AI → Admin
            </a>
          ) : (
            <button
              type="button"
              onClick={tailor}
              disabled={working || busy || rawText.trim() === ""}
              style={buttonStyle("ghostLink", working || busy || rawText.trim() === "")}
              title="Tailor to this job with AI"
            >
              {busyLabel ?? (preview ? "Re-tailor" : "Tailor")}
            </button>
          )}
          {preview ? (
            <>
              {unsigned.length > 0 ? (
                <button
                  type="button"
                  onClick={() => signOff(preview.cvId, unsigned, preview.bundle.cv.version)}
                  disabled={dirty.length > 0 || busy}
                  style={buttonStyle("primary", dirty.length > 0 || busy)}
                  title={
                    dirty.length > 0
                      ? "Save your edits first"
                      : `Approve ${unsigned.length} net-new bullet${unsigned.length > 1 ? "s" : ""} before export`
                  }
                >
                  {mutating ? "Working…" : `Sign off ${unsigned.length}`}
                </button>
              ) : null}
              {canExport ? (
                <details className="ws-export" style={{ position: "relative" }}>
                  <summary
                    style={{
                      ...buttonStyle("primary"),
                      listStyle: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    Export <span aria-hidden>▾</span>
                  </summary>
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "calc(100% + 6px)",
                      zIndex: 20,
                      minWidth: 150,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      padding: 6,
                      background: "var(--panel)",
                      border: "1px solid var(--line)",
                      borderRadius: 10,
                      boxShadow: "0 12px 30px -16px rgba(0, 0, 0, 0.45)",
                    }}
                  >
                    {(["pdf", "docx", "text"] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => exportAs(preview.cvId, preview.bundle.cv.version, kind)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          textAlign: "left",
                          minHeight: 44,
                          padding: "8px 12px",
                          borderRadius: 7,
                          border: "none",
                          background: "transparent",
                          color: "var(--text)",
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        {kind === "text" ? "ATS text" : kind.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </details>
              ) : (
                <button
                  type="button"
                  aria-disabled="true"
                  // Focusable (not `disabled`) so a keyboard / screen-reader user reaches the blocked
                  // reason in the accessible name; the no-op handler keeps it inert.
                  onClick={(e) => e.preventDefault()}
                  aria-label={exportBlockedReason ?? "Export blocked"}
                  title={exportBlockedReason ?? "Export blocked"}
                  style={{
                    ...buttonStyle("ghostLink"),
                    minHeight: 44,
                    border: "1px solid var(--warn)",
                    background: "color-mix(in srgb, var(--warn) 16%, transparent)",
                    color: "var(--text)",
                    cursor: "default",
                  }}
                >
                  Export blocked
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setApplyError(null);
                  setShowApply(true);
                }}
                disabled={!canExport}
                aria-label="Applied — move to tracking"
                style={{ ...buttonStyle("ghostLink", !canExport), minHeight: 44 }}
                title="Lock this CV to a job and move it to your Applications tracker"
              >
                Applied
              </button>
            </>
          ) : null}
        </div>
      </header>

      {showPosting && preview?.bundle.jobSpec ? (
        <PostingSidebar jobSpec={preview.bundle.jobSpec} onClose={() => setShowPosting(false)} />
      ) : null}

      {/* Status banner (tailoring / review / apply / stale) — hoisted ABOVE the tab panes so an error
          raised from the Reviewers or Preview tab is never hidden inside a `display:none` editor pane. */}
      {msg ? (
        <div className="ws-banner">
          <Banner kind={msg.kind} text={msg.text} />
        </div>
      ) : null}

      {/* Editor / Preview / Reviewers switcher — hidden on desktop (all three panes show), shown only
          below the ws-tabs breakpoint (globals.css `.ws-tabbar`). A `role="group"` of `aria-pressed`
          toggle buttons, NOT an ARIA tablist: at desktop all three panes render at once (no tab
          metaphor), and we don't implement roving-tabindex/arrow-keys — so plain toggles are honest
          and correct at both widths. Only meaningful once a CV exists. */}
      {preview ? (
        <div className="ws-tabbar">
          {(
            [
              ["editor", "Editor"],
              ["preview", "Preview"],
              ["reviewers", "Reviewers"],
            ] as const
          ).map(([key, label]) => {
            const active = wsTab === key;
            const isReviewers = key === "reviewers";
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                aria-label={
                  isReviewers && reviewerNoteCount > 0
                    ? `Reviewers, ${reviewerNoteCount} open note${reviewerNoteCount > 1 ? "s" : ""}`
                    : undefined
                }
                onClick={() => setWsTab(key)}
                className="ws-tab-btn"
                style={{
                  // Active state reads from the accent underline + tint; the LABEL stays --text/--text-2
                  // so it clears WCAG-AA in both themes (bright --accent fails AA on light — rubric §6).
                  color: active ? "var(--text)" : "var(--text-2)",
                  borderBottomColor: active ? "var(--accent)" : "transparent",
                  ...(active
                    ? { background: "color-mix(in srgb, var(--accent) 8%, transparent)" }
                    : {}),
                }}
              >
                {label}
                {isReviewers && reviewerNoteCount > 0 ? (
                  <span
                    aria-hidden
                    style={{ ...mono, fontSize: 10, color: "var(--text-3)", marginLeft: 6 }}
                  >
                    {reviewerNoteCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* The attribute stays PRESENT while `preview` is null (parsing/tailoring/drafting) so the
          ≥1120 viewport-locked pane bounds hold (they key on presence, not value) — but the value
          clamps to "editor": below 1120 the stacked gating shows the pane for the active value,
          and during a slow/failing create the ONLY meaningful content is the compose/editor pane
          (a "preview" clamp would blank the screen and strand the job-posting controls). */}
      <div ref={wsRootRef} className="ws-cols" data-ws-tab={preview ? wsTab : "editor"}>
        {/* Left pane: the job-posting compose + the structured editor. */}
        <section className="ws-left">
          <article className="ws-tab-editor" style={card}>
            <label
              htmlFor="job"
              style={{ display: "block", fontSize: 12, color: "var(--text-2)", marginBottom: 6 }}
            >
              Job posting
            </label>
            <textarea
              id="job"
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="Paste the job description here…"
              rows={7}
              aria-label="Job posting"
              style={{ ...editorTextarea, minHeight: 120 }}
            />
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {/* No-AI verbatim draft from the master. Tailor / Configure-AI moved to the top bar
                  (DevPR12); this card is now just the posting compose + the no-AI path. */}
              <button
                type="button"
                onClick={startDraft}
                disabled={working || busy}
                style={ghostBtn(working || busy)}
                title="Build a verbatim CV from your master — no AI or API key needed"
              >
                {phase.status === "drafting" ? "Drafting…" : "Start a draft (no AI)"}
              </button>
            </div>
          </article>

          {preview ? (
            <div className="ws-tab-editor ws-editor-group">
              <EditorPanel
                cv={preview.bundle.cv}
                drafts={drafts}
                applyingFeedback={applyingFeedback}
                workById={workById}
                inlineThreads={inlineThreads}
                staleIds={staleIds}
                // Show the FOLDED decisions so the editor badge matches what batch Apply sends: once a
                // note on a multi-note line is accepted, its non-rejected siblings show accepted too
                // (they're rewritten together — ADR 0014); reject one to exclude it. Display == payload
                // (`acceptedCount` already uses the folded projection). Codex P2.
                decisions={foldedDecisions}
                onDecide={onDecide}
                acceptedCount={accepted.length}
                onSelectBullet={selectBullet}
              />
            </div>
          ) : null}
        </section>

        {/* Center pane: the live preview (the same template the PDF prints). tabIndex=-1 keeps it a
            programmatic apply-settle focus target (the shipped, gate-allowed pattern); keyboard reach
            of the bounded pane arrives with the in-paper editable content in DevPR14. */}
        <div
          ref={previewPaneRef}
          tabIndex={-1}
          className="ws-tab-preview"
          style={{ outline: "none" }}
        >
          <PreviewPanel
            bundle={bundle}
            drafts={drafts}
            optimistic={optimistic}
            working={working}
            flash={flash}
            editableBulletIds={editableIds}
            // Suspend in-paper editing while a review STREAMS too (busy = writeBusy || reviewing): an
            // edit committed mid-run bumps the CV version, and save_review then refuses to persist the
            // run (save_failed) — so the review vanishes on the next remount. Editing an un-reviewed
            // snapshot mid-stream was incoherent anyway (apply is already blocked during a review).
            editsSuspended={busy}
            onDraftBullet={(id, text) => setDrafts((d) => ({ ...d, [id]: text }))}
            onCommitBullet={commitPaperBullet}
            // DevPR17: in-margin markers + the in-place ReviewNote (reuse the shipped review wiring).
            cv={preview?.bundle.cv}
            inlineThreads={inlineThreads}
            decisions={decisions}
            staleIds={staleIds}
            editableIds={editableIds}
            reviewing={reviewing}
            dirtyCount={dirty.length}
            busy={busy}
            applying={applyingFeedback}
            hasLiveDiff={hasLiveDiff}
            onAcceptFix={(t) => {
              if (!preview) return;
              // The clicked thread PLUS every NON-REJECTED note on the SAME bullet — whole-bullet
              // resolve (ADR 0014) consumes the whole bullet on apply and flips its other notes to
              // resolved, so an undecided same-bullet critique would otherwise be silently dropped and
              // never reach the Corrector (it can't be applied on a second pass). Sending them together
              // matches the server's whole-bullet rewrite; explicit rejects stay excluded. Still a
              // one-bullet fast call; OTHER bullets' staged accepts stay staged for a later batch Apply.
              // Read the REF so a just-staged accept isn't missed.
              const sameBullet = sameBulletApply(t, inlineThreads, decisionsRef.current);
              applyFeedback(
                preview.cvId,
                preview.bundle.cv.version,
                acceptedThreads(inlineThreads, sameBullet, staleIds, editableIds),
              );
            }}
            onSignOff={(bulletId) =>
              preview && signOff(preview.cvId, [bulletId], preview.bundle.cv.version)
            }
            onDismiss={(key) => onDecide(key, "rejected")}
            onViewDiff={() =>
              preview && router.push(`/workspace?cv=${encodeURIComponent(preview.cvId)}&view=diff`)
            }
          />
        </div>

        {/* Right pane: the AI review panel (trigger + live checklist + verdict + per-agent threads +
            Apply corrections). Moved out of the left column into its own pane (DevPR13); the rail
            rebuild (roster + comments + gatekeeper card) lands in DevPR15. */}
        {preview ? (
          <aside className="ws-tab-reviewers">
            <ReviewPanel
              cv={preview.bundle.cv}
              bundle={panelBundle}
              reviewing={reviewing}
              mutating={mutating || applyingFeedback}
              clearing={clearing}
              versionDrifted={versionDrifted}
              // Save-state captions (S4) — all reviewSameCv-gated so a stale review for another cv can't
              // caption the one on screen (matches how versionDrifted is derived).
              reviewRestored={reviewSameCv && reviewRestored}
              saveFailed={reviewSameCv && saveFailed}
              decideSaveFailed={reviewSameCv && decideSaveFailed}
              // NOT reviewSameCv-gated (unlike the others): a failed load means there is NO in-memory
              // review to be "same cv" with — gating it would hide the note exactly when the panel is
              // blank. loadCv resets it per cv, so it always reflects the on-screen cv's probe.
              reviewLoadFailed={reviewLoadFailed}
              onRetryReview={retryReview}
              dirtyCount={dirty.length}
              checklist={checklist}
              statusLine={reviewStatusLine}
              reviewError={reviewError}
              reviewReadiness={reviewReadiness}
              headingRef={panelHeadingRef}
              onReview={() =>
                runReview(
                  preview.cvId,
                  preview.bundle.cv.version,
                  reviewedTextSnapshot(preview.bundle.cv),
                )
              }
              onCancel={cancelReview}
              onOpenGatekeeper={() =>
                router.push(`/workspace?cv=${encodeURIComponent(preview.cvId)}&view=gatekeeper`)
              }
              showApply={hasEligibleInline}
              acceptedCount={accepted.length}
              canApply={canApply}
              applyDisabledReason={applyDisabledReason}
              applying={applyingFeedback}
              applyError={applyFeedbackError}
              onApply={() => applyFeedback(preview.cvId, preview.bundle.cv.version, accepted)}
              onClearReview={() => clearReview(preview.cvId)}
            />
          </aside>
        ) : null}

        {/* The single settle-time aria-live region (dec #9), hoisted so a "review complete" /
            "applied N corrections" announcement is spoken on any tab. srOnly is position:absolute,
            so it never affects the flex layout. */}
        <div role="status" aria-live="polite" style={srOnly}>
          {reviewAnnounce}
        </div>
      </div>
      {showApply && preview ? (
        <ApplyDialog
          applying={applying}
          error={applyError}
          onSubmit={(fields) => doApply(preview.cvId, preview.bundle.cv.version, fields)}
          onDismiss={() => {
            setShowApply(false);
            setApplyError(null);
          }}
        />
      ) : null}
    </div>
  );
}

// Capture job URL/title/note and confirm the lock. A native <dialog> via showModal() (browser owns
// modality + focus trap + restore), but submission is a real <form onSubmit> — NOT method="dialog",
// which closes synchronously and so couldn't stay open + preserve the typed values when apply fails.
// Cancel/Escape route through the dialog's close event to onDismiss — but BOTH are inert while
// `applying`, so dismissing mid-flight can't strand the in-flight apply (which would otherwise
// navigate a "cancelled" user, or drop a failure into an unmounted dialog).
function ApplyDialog({
  applying,
  error,
  onSubmit,
  onDismiss,
}: {
  applying: boolean;
  error: string | null;
  onSubmit: (fields: { jobTitle: string; company: string; jobUrl: string; note: string }) => void;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const [jobTitle, setJobTitle] = useState("");
  const [company, setCompany] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    firstRef.current?.focus();
  }, []);
  // On a failure the parent re-surfaces the dialog with an error — pull focus back to the title field.
  useEffect(() => {
    if (error) firstRef.current?.focus();
  }, [error]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="apply-title"
      aria-describedby="apply-body"
      onClose={onDismiss}
      // Escape fires a cancelable `cancel` before `close` — block it while applying so the dialog
      // can't be dismissed out from under an in-flight apply.
      onCancel={(e) => {
        if (applying) e.preventDefault();
      }}
      style={{
        ...card,
        maxWidth: 460,
        width: "calc(100% - 2rem)",
        boxShadow: "0 12px 40px rgba(0, 0, 0, 0.35)",
      }}
    >
      <h2 id="apply-title" style={{ margin: "0 0 6px", fontSize: 15 }}>
        Mark as applied
      </h2>
      <p
        id="apply-body"
        style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}
      >
        This locks the exact CV you&rsquo;re viewing to the job and moves it to your Applications
        tracker &mdash; it can&rsquo;t be edited afterwards.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ jobTitle, company, jobUrl, note });
        }}
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <label>
          <span style={fieldLabel}>Job title</span>
          <input
            ref={firstRef}
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder="e.g. Senior Engineer — blank uses this CV's job title, if it has one"
            style={dialogInput}
          />
        </label>
        <label>
          <span style={fieldLabel}>Company</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} style={dialogInput} />
        </label>
        <label>
          <span style={fieldLabel}>Job posting URL (optional)</span>
          <input
            type="url"
            value={jobUrl}
            onChange={(e) => setJobUrl(e.target.value)}
            placeholder="https://…"
            style={dialogInput}
          />
        </label>
        <label>
          <span style={fieldLabel}>Note (optional)</span>
          <textarea
            value={note}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            style={{ ...editorTextarea, fontSize: 16 }}
          />
        </label>
        {error ? <Banner kind="bad" text={error} /> : null}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            flexWrap: "wrap",
            marginTop: 4,
          }}
        >
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            disabled={applying}
            style={ghostBtn(applying)}
          >
            Cancel
          </button>
          <button type="submit" disabled={applying} style={primaryBtn(applying)}>
            {applying ? "Applying…" : "Mark as applied"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function errText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503 || err.status === 502) {
      return "The AI provider isn't configured yet — set an API key in Admin (/admin).";
    }
    return err.message || "Request failed.";
  }
  return "Something went wrong.";
}

function SessionShell({ label }: { label: string }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <span
        style={{
          ...mono,
          fontSize: 12,
          color: "var(--text-3)",
          textAlign: "center",
          maxWidth: 360,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// App-chrome styles come from src/ui (one canonical source); these thin local aliases keep this file's
// many call-sites unchanged. Bespoke editor styles now live in ./styles (shared with the split-out
// preview/editor/review components).
const card = cardStyle;

const backLink = {
  ...buttonStyle("primary"),
  display: "inline-block",
  textDecoration: "none",
} as const;

const primaryBtn = (disabled: boolean) => buttonStyle("primary", disabled);
const ghostBtn = (disabled: boolean) => buttonStyle("ghost", disabled);
// 16px so iOS Safari doesn't zoom on focus (the shared inputStyle is 13px) — the Apply dialog is a
// mobile-facing form (frontend/AGENTS.md notes the same intentional 16px variant for ingest).
const dialogInput = { ...inputStyle, fontSize: 16 } as const;
