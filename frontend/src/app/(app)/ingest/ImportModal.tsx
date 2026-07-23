"use client";

// Import modal (owner-only) — build your master profile from a pasted CV / LinkedIn document or an
// uploaded PDF, opened from the Master editor's "Add source" (C4: Master absorbed Import). Paste/drop →
// the Extractor (server-side) streams per-agent progress (SSE) → reviewable proposals → accept / edit /
// decline each (the ingestion analogue of the sign-off gate, invariant 2: the server is the authority
// on what enters the master) → Apply merges the accepted set into the master. A native <dialog> via
// showModal() so the BROWSER owns modality (inert background, focus trap, focus-restore); dismissal
// routes through the close event to onClose. One open run per workspace; the recent-imports list is the
// primary recovery surface if the modal is closed mid-run. No CV is rendered here (invariant 3).
import { useRouter } from "next/navigation";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Schemas } from "@/lib/api/client";
import { consumeSseStream } from "@/lib/sse";
import { AgentChecklist, Banner, IconButton, tagStyle } from "@/ui";
import { fromMasterRequest } from "../workspace/logic";
import {
  acceptedCount,
  agentLabel,
  applyRunRequest,
  bulkDecideRequest,
  type Checklist,
  type Drafts,
  decideProposalRequest,
  dirtyNetNewPendingProposalIds,
  dirtyPendingProposalIds,
  discardRunRequest,
  editedContent,
  emptyChecklist,
  extractedNothing,
  getRunRequest,
  hasPendingUpdateProposals,
  ingestErrorMessage,
  isFileTooLarge,
  isPdfFile,
  isProposalDirty,
  joinRecommended,
  judgeUnavailable,
  listRunsRequest,
  netNewPendingCount,
  netNewPendingItems,
  openRun,
  orderedProposals,
  type ProposalDraft,
  parseDetail,
  pendingCount,
  proposalVerdictLabel,
  proposalVerdictReason,
  recommendedMissing,
  reduceChecklist,
  relationshipLabel,
  type SseEvent,
  seedDraft,
  streamIngestRequest,
  unitKindLabel,
  uploadStreamRequest,
} from "./logic";

type RunBundle = Schemas["IngestionRunBundle"];
type IngestRun = Schemas["IngestionRun"];
type Proposal = Schemas["IngestionProposal"];
type ApplyResult = Schemas["ApplyResult"];
type ProposalAction = Schemas["ProposalAction"];

type Phase = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

const mono = { fontFamily: "var(--mono)" } as const;

// Move focus after a render (the target only mounts once the new state paints). Module-scope so it
// closes over nothing and stays a stable reference across the callbacks that use it.
const focusSoon = (ref: RefObject<HTMLElement | null>) => setTimeout(() => ref.current?.focus(), 0);

export function ImportModal({
  onClose,
  onApplied,
}: {
  /** Called when the dialog closes (the browser restores focus to the trigger). */
  onClose: () => void;
  /** Called after a successful Apply so the host (Master editor) can reload its draft. */
  onApplied?: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const loadedRunRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set true by an apply action so the summary's callback ref focuses it on mount (a11y). A callback
  // ref fires exactly when the node attaches (after commit), which a post-apply setTimeout(0)/effect
  // raced: the summary div mounts a render AFTER `applied` is set (status flips on a second setState),
  // so the ref wasn't attached yet. The flag also keeps a deep-link reload of an applied run — where
  // the same div mounts — from stealing focus on plain navigation.
  const justAppliedRef = useRef(false);
  const focusSummaryOnMount = useCallback((el: HTMLDivElement | null) => {
    if (el && justAppliedRef.current) {
      justAppliedRef.current = false;
      el.focus();
    }
  }, []);
  // A failed apply renders `applyBlock` below the proposals — far from the sticky Apply bar the owner
  // just clicked, so a 422/409/error read as "nothing happened". Pull it into view + take focus when it
  // mounts. `applyBlock` is set to null before each attempt, so the node unmounts/remounts per failure
  // and this fires once each (no justApplied-style flag needed — it's only ever set by a live failure,
  // never on reload). Stable identity → React doesn't re-run it on rerender. Instant scroll (default
  // behavior) respects reduced-motion, which globals.css doesn't neutralise for smooth scrolling.
  const focusBlockOnMount = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus();
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Guards a double-submit across the two arms: the `busy` state lags a render, so a fast
  // paste-then-upload double-tap could fire two run-creating POSTs (the backend's one-open-run 409
  // is the backstop, but we shouldn't rely on it). A ref flips synchronously.
  const inFlight = useRef(false);
  // Same lag, guarding apply: the in-app confirm replaced the synchronous window.confirm, so a fast
  // double-click on the dialog's Import button could POST twice before `busy` paints. Flip a ref first.
  const applyInFlight = useRef(false);
  // Streaming ingest (F3b): an AbortController per run cancels the SSE on the escape hatch or on
  // unmount; `mountedRef` gates setState from the long-lived reader so a cancel-vs-unmount abort is
  // distinguishable (unmount → bail silently; cancel → recover).
  const streamAbortRef = useRef<AbortController | null>(null);
  // Distinguishes the user's escape hatch (abandon the run) from a passive network drop (recover it).
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);

  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [runs, setRuns] = useState<IngestRun[]>([]);
  const [current, setCurrent] = useState<RunBundle | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [busy, setBusy] = useState<null | "submitting" | "deciding" | "applying">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  // A failed apply, surfaced in one place near where the owner clicked (not the top banner, which sits
  // off-screen above the sticky Apply bar). `identity`/`stale` are the blocking 422/409 cases; `error`
  // catches every other failure so NO apply outcome can land silently off-screen.
  const [applyBlock, setApplyBlock] = useState<{
    kind: "stale" | "identity" | "error";
    message: string;
  } | null>(null);
  // Live per-agent progress for the streaming run (F3b): the checklist (keyed by agentId) + a single
  // replaceable status sentence — the ONLY thing in the aria-live region, so a screen reader hears the
  // delta, not the whole evolving list.
  const [checklist, setChecklist] = useState<Checklist>(emptyChecklist);
  const [statusLine, setStatusLine] = useState("");
  // An in-app confirmation, replacing native window.confirm (which some browsers silently suppress —
  // making Apply/Discard abort with no feedback). One modal at a time; the discard variant carries its
  // target so every discard entry point routes through the same prompt.
  const [pendingConfirm, setPendingConfirm] = useState<
    { kind: "apply" } | { kind: "discard"; runId: string; proposals: Proposal[] } | null
  >(null);

  // Cancel any in-flight stream + stop setState once the component is gone (the reader can outlive
  // it). Set the flag true in SETUP so React StrictMode's mount→unmount→remount (next dev) doesn't
  // leave it stuck false and bail every subsequent stream.
  useEffect(() => {
    mountedRef.current = true;
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    return () => {
      mountedRef.current = false;
      streamAbortRef.current?.abort();
    };
  }, []);

  // Resolve the current run from the server: the open run (resumed) or none. The recent-imports list is
  // the recovery surface — closing the modal mid-run leaves the run open server-side, and re-opening
  // resumes it here. Used on open, on a submit timeout, and after discard. (No URL sync: the modal has
  // no route to deep-link, so the open run lives in `current`/`loadedRunRef`, not `?run=`.)
  const recover = useCallback(async () => {
    const list = await api<IngestRun[]>(listRunsRequest().path);
    setRuns(list);
    const open = openRun(list);
    if (open) {
      const bundle = await api<RunBundle>(getRunRequest(open.id).path);
      loadedRunRef.current = open.id;
      setCurrent(bundle);
    } else {
      loadedRunRef.current = null;
      setCurrent(null);
    }
  }, []);

  // Recovery on open. Resumes any run left open server-side (the modal can be closed and
  // re-opened mid-import); the recent-imports list backs it up. The shell's SessionProvider
  // already resolved auth (401 -> /sign-in); every allowlisted account is the owner.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await recover();
        if (active) setPhase({ status: "ready" });
      } catch (err: unknown) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        setPhase({ status: "error", message: ingestErr(err) });
      }
    })();
    return () => {
      active = false;
    };
  }, [router, recover]);

  const refreshRuns = useCallback(async () => {
    setRuns(await api<IngestRun[]>(listRunsRequest().path));
  }, []);

  // The shared success tail for BOTH arms: land on the freshly-opened run's review. Each arm clears
  // its OWN input separately (paste → text, upload → file + the native input) so a stale value can't
  // survive into the next import.
  const landOnRun = useCallback(
    (bundle: RunBundle) => {
      loadedRunRef.current = bundle.run.id;
      setCurrent(bundle);
      setDrafts({});
      setApplied(null);
      void refreshRuns();
      focusSoon(headingRef);
    },
    [refreshRuns],
  );

  // 409 (a run is already open) / 502 / edge timeout / network — DON'T dead-end on the input view:
  // an idle timeout looks like 502 while the run still completes. Re-resolve so the UI lands on the
  // open run (review or "still running"), not a dead form. Shared by both arms.
  const recoverFrom = useCallback(async () => {
    setMsg({ kind: "bad", text: "That's taking longer than expected — checking your imports…" });
    try {
      await recover();
    } catch (e: unknown) {
      setMsg({ kind: "bad", text: ingestErr(e) });
    }
  }, [recover]);

  // Feed each SSE event into the live checklist; only the single status sentence sits in the
  // aria-live region (a screen reader hears the delta, not the whole list).
  const onSseEvent = useCallback((ev: SseEvent) => {
    if (!mountedRef.current) return;
    setChecklist((c) => reduceChecklist(c, ev));
    if (ev.type === "agent_started") setStatusLine(`${agentLabel(ev.agentId)}…`);
    else if (ev.type === "agent_progress") setStatusLine(ev.note);
  }, []);

  // The shared streaming spine for both arms: open the SSE stream, drive the checklist, then land on
  // the run. `RunDone{ok}` → reload the bundle (ok → onSuccess clears the input + lands on review;
  // not-ok → land on the failed card, KEEPING the input). A pre-flight 422/503/413 → banner; 409/
  // transient/cancel/EOF → recover onto the open run. `mountedRef` gates state so an unmount-abort
  // bails silently while a cancel-abort recovers; `onSettled` resets the file input on every path.
  const runIngestStream = useCallback(
    async (
      call: { path: string; init?: RequestInit },
      onSuccess: (b: RunBundle) => void,
      onSettled?: () => void,
    ) => {
      inFlight.current = true;
      setBusy("submitting");
      setMsg(null);
      setApplyBlock(null);
      setChecklist(emptyChecklist());
      setStatusLine("Reading your document…");
      cancelledRef.current = false;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      try {
        const outcome = await consumeSseStream(call, controller.signal, onSseEvent);
        if (!mountedRef.current) return; // unmounted mid-stream — never setState
        if (outcome.kind === "http_error") {
          if (outcome.status === 401) {
            router.replace("/sign-in");
            return;
          }
          if (outcome.status === 422 || outcome.status === 503 || outcome.status === 413) {
            setMsg({ kind: "bad", text: ingestErrorMessage(outcome.status, outcome.detail) });
          } else {
            await recoverFrom(); // 409 a run is already open / transient → land on the open run
          }
          return;
        }
        if (outcome.kind === "run_done" && outcome.resultRef) {
          const bundle = await api<RunBundle>(getRunRequest(outcome.resultRef).path);
          if (!mountedRef.current) return;
          if (outcome.ok) onSuccess(bundle);
          else landOnRun(bundle); // failed run → the failed card (keeps the user's input)
          return;
        }
        // Dropped without a terminal RunDone.
        if (outcome.kind === "dropped" && outcome.runId) {
          if (cancelledRef.current) {
            // The user hit the escape hatch. Don't blindly discard: if the run actually FINISHED
            // (proposals committed, status `review`) in the gap before `run_done` reached us — or it
            // already reached a terminal state — discarding would silently destroy a completed import
            // (`discard_run` treats `review` as open). Reload it: only abandon one still mid-flight;
            // otherwise land on it so the user can check the imports they stopped for.
            try {
              const bundle = await api<RunBundle>(getRunRequest(outcome.runId).path);
              if (!mountedRef.current) return;
              if (bundle.run.status !== "extracting" && bundle.run.status !== "reconciling") {
                setMsg(null);
                landOnRun(bundle);
                return;
              }
              const d = discardRunRequest(outcome.runId);
              await api<IngestRun>(d.path, d.init);
            } catch {
              /* gone / already terminal — fall through to the recovery list */
            }
            if (!mountedRef.current) return;
            setMsg(null); // a deliberate stop isn't an error — no "taking longer than expected" banner
            try {
              await recover();
            } catch {
              /* the recent-runs list re-resolves on the next load */
            }
            return;
          }
          // A passive network drop: load the EXACT run via the X-Run-Id header (a terminal `failed`
          // shows its card — `recover`'s open-run list would miss it; an orphaned extracting run shows
          // the still-running view with its own Refresh / Discard).
          try {
            const bundle = await api<RunBundle>(getRunRequest(outcome.runId).path);
            if (!mountedRef.current) return;
            landOnRun(bundle);
            return;
          } catch {
            /* run id gone / unreadable → fall back to the recovery list */
          }
        }
        if (!mountedRef.current) return;
        await recoverFrom();
      } catch {
        if (mountedRef.current) await recoverFrom();
      } finally {
        streamAbortRef.current = null;
        inFlight.current = false;
        if (mountedRef.current) setBusy(null);
        onSettled?.();
      }
    },
    [router, recover, recoverFrom, landOnRun, onSseEvent],
  );

  // The escape hatch from a watched stream (a stall would otherwise sit behind keepalives forever):
  // abort the reader → consumeSseStream returns "dropped" → recover lands on the open run's
  // still-running view with its own Refresh / Discard.
  const cancelStream = useCallback(() => {
    cancelledRef.current = true;
    streamAbortRef.current?.abort();
  }, []);

  const submit = useCallback(() => {
    if (!text.trim() || inFlight.current) return;
    void runIngestStream(streamIngestRequest(text), (bundle) => {
      setText("");
      landOnRun(bundle);
    });
  }, [text, runIngestStream, landOnRun]);

  // The upload arm: same streaming spine, the upload request builder (multipart; the browser sets the
  // Content-Type boundary), and `resetInput` as `onSettled` so the native input clears on every path.
  const submitFile = useCallback(() => {
    if (!file || inFlight.current) return;
    const resetInput = () => {
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    if (isFileTooLarge(file)) {
      setMsg({
        kind: "bad",
        text: "That PDF is too large — please keep it under 10 MB and 30 pages.",
      });
      resetInput();
      return;
    }
    if (!isPdfFile(file)) {
      setMsg({ kind: "bad", text: "Please choose a PDF file." });
      resetInput();
      return;
    }
    void runIngestStream(uploadStreamRequest(file), (bundle) => landOnRun(bundle), resetInput);
  }, [file, runIngestStream, landOnRun]);

  // Reload the run bundle after a concurrent change (409), keeping drafts so the user can re-apply.
  const reloadKeepingDrafts = useCallback(async (runId: string, note: string) => {
    try {
      setCurrent(await api<RunBundle>(getRunRequest(runId).path));
      setMsg({ kind: "bad", text: note });
    } catch (e: unknown) {
      setMsg({ kind: "bad", text: ingestErr(e) });
    }
  }, []);

  const decide = useCallback(
    async (p: Proposal, action: ProposalAction) => {
      if (!current || busy) return;
      const runId = current.run.id;
      const edited = action === "decline" ? null : (editedContent(p, drafts[p.proposalId]) ?? null);
      const req = decideProposalRequest(runId, p.proposalId, {
        action,
        edited,
        baseVersion: p.version,
      });
      setBusy("deciding");
      setMsg(null);
      setApplyBlock(null);
      try {
        const bundle = await api<RunBundle>(req.path, req.init);
        setCurrent(bundle);
        setDrafts((d) => {
          const { [p.proposalId]: _saved, ...rest } = d;
          return rest;
        });
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        if (err instanceof ApiError && err.status === 409) {
          await reloadKeepingDrafts(
            runId,
            "This import changed elsewhere — reloaded it. Re-apply your change and save.",
          );
        } else {
          setMsg({ kind: "bad", text: ingestErr(err) });
        }
      } finally {
        setBusy(null);
      }
    },
    [current, drafts, busy, router, reloadKeepingDrafts],
  );

  const acceptAll = useCallback(async () => {
    if (!current || busy) return;
    // "Add all new items" only ever flips NET-NEW proposals; enrich/correction are accepted per item
    // (the server also re-derives this and 422s any non-net-new id — invariant 2).
    const items = netNewPendingItems(current.proposals);
    if (items.length === 0) return;
    const req = bulkDecideRequest(current.run.id, items, "accept");
    setBusy("deciding");
    setMsg(null);
    setApplyBlock(null);
    try {
      const bundle = await api<RunBundle>(req.path, req.init);
      setCurrent(bundle);
      focusSoon(headingRef);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/sign-in");
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        await reloadKeepingDrafts(current.run.id, "This import changed elsewhere — reloaded it.");
      } else {
        setMsg({ kind: "bad", text: ingestErr(err) });
      }
    } finally {
      setBusy(null);
    }
  }, [current, busy, router, reloadKeepingDrafts]);

  // The actual apply POST. Re-asserts every guard at action time — NOT just on the disabled button —
  // because the in-app confirm step is async: an unsaved edit (or a fully-emptied accepted set) could
  // have appeared between the click and the confirm, and applying over it would silently lose work.
  const performApply = useCallback(async () => {
    if (!current || busy || applyInFlight.current) return;
    if (dirtyPendingProposalIds(current.proposals, drafts).length > 0) return;
    if (acceptedCount(current.proposals) === 0) return;
    applyInFlight.current = true;
    const req = applyRunRequest(current.run.id);
    setBusy("applying");
    setMsg(null);
    setApplyBlock(null);
    try {
      const result = await api<ApplyResult>(req.path, req.init);
      // The master is written and the run is flipped to `applied` server-side before this returns —
      // the import HAS happened. Reload the bundle for per-item attribution, but a transient reload
      // failure must NOT read as an apply failure: flip the status locally so the applied summary
      // still shows (it uses `result` for counts/conflicts).
      setApplied(result);
      try {
        setCurrent(await api<RunBundle>(getRunRequest(current.run.id).path));
      } catch {
        setCurrent((c) => (c ? { ...c, run: { ...c.run, status: "applied" } } : c));
      }
      // Flag the apply so the summary's callback ref focuses it when it mounts (a11y). The div mounts
      // a render later (status flips on the setCurrent above), so we can't focus imperatively here.
      justAppliedRef.current = true;
      // The master was mutated — tell the host (Master editor) to reload its draft so it reflects the
      // imported items when the modal closes (the summary stays open until the owner closes/continues).
      onApplied?.();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/sign-in");
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setApplyBlock({
          kind: "stale",
          message:
            "Your master changed since this import started, so these proposals may no longer fit. Discard this import and start again to pick up the latest.",
        });
        await reloadKeepingDrafts(current.run.id, "The master changed — review the options below.");
      } else if (err instanceof ApiError && err.status === 422) {
        setApplyBlock({ kind: "identity", message: parseDetail(err.message) });
      } else {
        // Any other failure goes through the same in-view block, never the off-screen top banner.
        setApplyBlock({ kind: "error", message: ingestErr(err) });
      }
    } finally {
      setBusy(null);
      applyInFlight.current = false;
    }
  }, [current, busy, drafts, router, reloadKeepingDrafts, onApplied]);

  // What the Apply bar calls. Same guards as the disabled button; if anything is still pending it opens
  // the in-app confirm (the old window.confirm), otherwise it applies straight away.
  const requestApply = useCallback(() => {
    if (!current || busy) return;
    if (dirtyPendingProposalIds(current.proposals, drafts).length > 0) return;
    if (acceptedCount(current.proposals) === 0) return;
    if (pendingCount(current.proposals) > 0) {
      setPendingConfirm({ kind: "apply" });
      return;
    }
    void performApply();
  }, [current, busy, drafts, performApply]);

  const performDiscard = useCallback(
    async (runId: string) => {
      setBusy("deciding");
      setMsg(null);
      setApplyBlock(null);
      const req = discardRunRequest(runId);
      try {
        await api<IngestRun>(req.path, req.init);
        loadedRunRef.current = null;
        setCurrent(null);
        setApplied(null);
        setDrafts({});
        await refreshRuns();
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        setMsg({ kind: "bad", text: ingestErr(err) });
      } finally {
        setBusy(null);
      }
    },
    [router, refreshRuns],
  );

  // Every discard entry point routes through here. When there's accepted/edited work to lose it opens
  // the in-app confirm (the old window.confirm); otherwise it discards straight away. The list-row path
  // (no proposals loaded) confirms unconditionally by opening the modal directly.
  const requestDiscard = useCallback(
    (runId: string, proposals: Proposal[]) => {
      const hasWork =
        acceptedCount(proposals) > 0 || dirtyPendingProposalIds(proposals, drafts).length > 0;
      if (hasWork) {
        setPendingConfirm({ kind: "discard", runId, proposals });
        return;
      }
      void performDiscard(runId);
    },
    [drafts, performDiscard],
  );

  const inspect = useCallback(
    async (runId: string) => {
      setMsg(null);
      setApplyBlock(null);
      try {
        const bundle = await api<RunBundle>(getRunRequest(runId).path);
        loadedRunRef.current = runId;
        setApplied(null);
        setCurrent(bundle);
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        setMsg({ kind: "bad", text: ingestErr(err) });
      }
    },
    [router],
  );

  // After a successful apply the master exists — build the AI-free verbatim draft and open it so the
  // FULL imported profile renders in the workspace preview (a bare /workspace only lands in `idle`).
  const openImported = useCallback(async () => {
    if (busy) return;
    setBusy("deciding");
    const req = fromMasterRequest();
    try {
      const created = await api<Schemas["CreatedCV"]>(req.path, req.init);
      router.push(`/workspace?cv=${encodeURIComponent(created.id)}`);
    } catch {
      // The master is already built; we're already on /master in this modal, so a router.push("/master")
      // would strand the user on the applied summary. Close the modal to reveal the editor + its
      // stale-reload banner instead.
      dialogRef.current?.close();
    } finally {
      setBusy(null);
    }
  }, [busy, router]);

  const startOver = useCallback(() => {
    loadedRunRef.current = null;
    setCurrent(null);
    setApplied(null);
    setDrafts({});
    setMsg(null);
    setApplyBlock(null);
    void refreshRuns();
  }, [refreshRuns]);

  const status = current?.run.status ?? null;
  const inReview = status === "review";
  const isRunning = status === "extracting" || status === "reconciling";
  const proposals = current ? orderedProposals(current) : [];
  const pend = pendingCount(proposals);
  const acc = acceptedCount(proposals);
  const dirtyPending = current ? dirtyPendingProposalIds(proposals, drafts) : [];
  // "Add all new items" is scoped to net-new: its count + disabled + dirty-guard ignore
  // enrich/correction (those are accepted per item), so a dirty update can't gray out the bulk add.
  const netNewPend = netNewPendingCount(proposals);
  const dirtyNetNew = current ? dirtyNetNewPendingProposalIds(proposals, drafts) : [];
  const showApplyBar = inReview && proposals.length > 0;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="import-title"
      onClose={onClose}
      // Escape fires a cancelable `cancel` before `close` — block it while a provider call is in
      // flight or a confirm is open, so a stream/apply can't be stranded in an unmounted dialog.
      onCancel={(e) => {
        if (busy !== null || pendingConfirm) e.preventDefault();
      }}
      style={dialogStyle}
    >
      <header style={headerRow}>
        <span style={iconSquare} aria-hidden>
          <UploadIcon />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id="import-title" style={{ fontSize: 14, fontWeight: 600 }}>
            Add to your master profile
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 1 }}>
            Drop a CV, cover letter or brag-doc — we check it against what you already have.
          </div>
        </div>
        <IconButton
          label="Close"
          size={44}
          disabled={busy !== null}
          onClick={() => dialogRef.current?.close()}
          style={{ border: "none" }}
        >
          <CloseIcon />
        </IconButton>
      </header>

      {phase.status === "loading" ? (
        <ModalNote>Checking your session…</ModalNote>
      ) : phase.status === "error" ? (
        <ModalNote tone="bad">{phase.message}</ModalNote>
      ) : (
        <>
          <div style={modalBody}>
            {msg ? <Banner kind={msg.kind} text={msg.text} /> : null}

            {busy === "submitting" ? (
              <IngestProgress
                checklist={checklist}
                statusLine={statusLine}
                onCancel={cancelStream}
              />
            ) : isRunning && current ? (
              <article style={card}>
                <Progress label="An import is still being read. Keep this tab open, or come back to it from the list below." />
                <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => void recover()} style={ghostBtn(false)}>
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={() => requestDiscard(current.run.id, current.proposals)}
                    style={ghostBtn(false)}
                  >
                    Discard import
                  </button>
                </div>
              </article>
            ) : current && status === "applied" ? (
              <div ref={focusSummaryOnMount} tabIndex={-1}>
                <AppliedSummary
                  bundle={current}
                  applied={applied}
                  busy={busy !== null}
                  onOpen={() => void openImported()}
                  onStartOver={startOver}
                />
              </div>
            ) : current && (status === "failed" || status === "discarded") ? (
              <article style={card}>
                <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>
                  {status === "failed" ? "This import didn't finish" : "This import was discarded"}
                </h2>
                <p
                  style={{
                    margin: "0 0 12px",
                    fontSize: 12.5,
                    color: "var(--text-2)",
                    lineHeight: 1.5,
                  }}
                >
                  {status === "failed"
                    ? current.run.failureReason ||
                      "Something went wrong while reading the document."
                    : "You discarded this import. You can start a new one."}
                </p>
                <button type="button" onClick={startOver} style={primaryBtn(false)}>
                  Import another document
                </button>
              </article>
            ) : current && inReview && extractedNothing(current) ? (
              <article style={card}>
                <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>Nothing to import</h2>
                <p
                  style={{
                    margin: "0 0 12px",
                    fontSize: 12.5,
                    color: "var(--text-2)",
                    lineHeight: 1.5,
                  }}
                >
                  Either we couldn&rsquo;t read this document, or everything in it is already in
                  your master. Try a more complete document, or the plain-text version of your CV.
                </p>
                <button
                  type="button"
                  onClick={() => requestDiscard(current.run.id, current.proposals)}
                  style={primaryBtn(false)}
                >
                  Try again
                </button>
              </article>
            ) : current && inReview ? (
              <>
                <div aria-live="polite" role="status" style={srOnly}>
                  {busy === "deciding" ? "Saving…" : busy === "applying" ? "Importing…" : ""}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  {/* scrollMarginTop clears the sticky modal header when focus()/scroll lands here. */}
                  <h2
                    ref={headingRef}
                    tabIndex={-1}
                    style={{ margin: 0, fontSize: 16, scrollMarginTop: 64 }}
                  >
                    Review {proposals.length} item{proposals.length === 1 ? "" : "s"} we found
                  </h2>
                  {netNewPend > 0 ? (
                    <button
                      type="button"
                      onClick={() => void acceptAll()}
                      disabled={dirtyNetNew.length > 0 || busy !== null}
                      style={ghostBtn(dirtyNetNew.length > 0 || busy !== null)}
                      title="Mark every new item to import"
                    >
                      Add all {netNewPend} new item{netNewPend === 1 ? "" : "s"}
                    </button>
                  ) : null}
                </div>
                {netNewPend === 0 && hasPendingUpdateProposals(proposals) ? (
                  <div style={{ ...mono, fontSize: 10.5, color: "var(--text-2)" }}>
                    Nothing brand-new here — these update entries already in your master. Review
                    each below.
                  </div>
                ) : dirtyNetNew.length > 0 ? (
                  <div style={{ ...mono, fontSize: 10.5, color: "var(--text-2)" }}>
                    Save your edits first to add the new items at once.
                  </div>
                ) : null}
                {judgeUnavailable(proposals) ? (
                  <div style={{ ...mono, fontSize: 10.5, color: "var(--text-2)" }}>
                    Suggestions are unavailable right now — review as usual.
                  </div>
                ) : null}
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {proposals.map((p) => (
                    <ProposalCard
                      key={p.proposalId}
                      p={p}
                      draft={drafts[p.proposalId] ?? seedDraft(p)}
                      busy={busy !== null}
                      readOnly={false}
                      onDraft={(d) => setDrafts((prev) => ({ ...prev, [p.proposalId]: d }))}
                      onDecide={(action) => void decide(p, action)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <PasteView
                text={text}
                onText={setText}
                onSubmit={() => void submit()}
                file={file}
                onFile={setFile}
                onUpload={() => void submitFile()}
                fileInputRef={fileInputRef}
                disabled={busy !== null || openRun(runs) !== null}
                runs={runs}
                onInspect={(id) => void inspect(id)}
                onDiscard={(r) =>
                  setPendingConfirm({ kind: "discard", runId: r.id, proposals: [] })
                }
                onClose={() => dialogRef.current?.close()}
              />
            )}

            {applyBlock ? (
              <ApplyBlock
                block={applyBlock}
                containerRef={focusBlockOnMount}
                onDiscard={() => current && requestDiscard(current.run.id, current.proposals)}
                onDismiss={() => setApplyBlock(null)}
              />
            ) : null}
          </div>

          {showApplyBar ? (
            <ApplyBar
              ready={acc}
              pending={pend}
              busy={busy === "applying"}
              disabled={acc === 0 || busy !== null || dirtyPending.length > 0}
              dirty={dirtyPending.length > 0}
              onApply={() => requestApply()}
              onDiscard={() => current && requestDiscard(current.run.id, current.proposals)}
            />
          ) : null}
        </>
      )}

      {/* An in-modal overlay (NOT a nested <dialog>) so closing it can't take the import modal down
          with it — it renders inside the modal's <dialog>, sharing its top-layer stacking context. */}
      {pendingConfirm?.kind === "apply" ? (
        <ConfirmDialog
          title="Import the accepted items?"
          body={`${pend} unreviewed item${pend === 1 ? "" : "s"} won't be imported — applying closes this import. Import the ${acc} accepted item${acc === 1 ? "" : "s"} now?`}
          confirmLabel={`Import ${acc}`}
          onConfirm={() => {
            setPendingConfirm(null);
            void performApply();
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      ) : pendingConfirm?.kind === "discard" ? (
        <ConfirmDialog
          title="Discard this import?"
          body="Any accepted or edited choices in this import will be lost — this can't be undone."
          confirmLabel="Discard import"
          onConfirm={() => {
            const runId = pendingConfirm.runId;
            setPendingConfirm(null);
            void performDiscard(runId);
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      ) : null}
    </dialog>
  );
}

// --- Proposal card (structured per-kind editing) ----------------------------------------------

function ProposalCard({
  p,
  draft,
  busy,
  readOnly,
  onDraft,
  onDecide,
}: {
  p: Proposal;
  draft: ProposalDraft;
  busy: boolean;
  readOnly: boolean;
  onDraft: (d: ProposalDraft) => void;
  onDecide: (action: ProposalAction) => void;
}) {
  const dirty = !readOnly && p.status === "pending" && isProposalDirty(p, draft);
  return (
    <article style={card}>
      <div
        style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        {/* A non-net-new relationship label replaces the unit-kind tag (it carries the meaning, no
            redundant double badge); net-new keeps the plain kind tag + the "new" status badge. */}
        {relationshipLabel(p.relationship) ? (
          <span style={tag("var(--text-2)")}>{relationshipLabel(p.relationship)}</span>
        ) : (
          <span style={tag("var(--text-3)")}>{unitKindLabel(p.unitKind)}</span>
        )}
        <StatusBadge p={p} readOnly={readOnly} dirty={dirty} />
        <EvidenceBadge verified={p.evidence.verified} />
        {/* Advisory Judge verdict (E2) — text only, never gates; suppressed for include + when the
            Judge was unavailable (that shows as one page-level line instead). */}
        {proposalVerdictLabel(p) ? (
          <span style={tag("var(--text-3)")}>{proposalVerdictLabel(p)}</span>
        ) : null}
      </div>

      {/* The "why" beneath the badges — always visible, never a native-title-only tooltip the owner
          can't see on touch. The verdict line is the Judge's own phrase (or generic copy when it gave
          none); the evidence line explains the "⚠ check this" flag. Shown only when present. */}
      {proposalVerdictReason(p) ? (
        <div
          role="note"
          style={{
            ...mono,
            fontSize: 10.5,
            color: "var(--text-2)",
            lineHeight: 1.5,
            marginBottom: 6,
          }}
        >
          ↳ {proposalVerdictReason(p)}
        </div>
      ) : null}
      {!p.evidence.verified ? (
        <div
          role="note"
          style={{
            ...mono,
            fontSize: 10.5,
            // Essential note text → --text-2 for AA (the warn tone is carried by the "⚠ check this"
            // EvidenceBadge chip border, not this copy — rubric §6).
            color: "var(--text-2)",
            lineHeight: 1.5,
            marginBottom: 8,
          }}
        >
          ↳ We couldn't find this exact text in your CV — double-check it's accurate.
        </div>
      ) : null}

      {/* Summary + verbatim evidence are the owner's trust surface — always shown, even while
          editing, so they can check a proposal against what the document actually said. */}
      <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>{p.summary}</div>
      {p.evidence.snippet ? (
        <blockquote style={evidenceQuote}>“{p.evidence.snippet}”</blockquote>
      ) : null}
      {!readOnly && p.status === "pending" ? (
        <div style={{ marginTop: 10 }}>
          {p.relationship === "correction" ? (
            <div className="ingest-cols">
              <div>
                <div style={{ ...mono, fontSize: 10, color: "var(--text-2)", marginBottom: 4 }}>
                  Current
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-2)",
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    padding: "6px 8px",
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                  }}
                >
                  {p.currentValue || "—"}
                </div>
              </div>
              <div>
                <div style={{ ...mono, fontSize: 10, color: "var(--text-2)", marginBottom: 4 }}>
                  Proposed
                </div>
                <Editor draft={draft} onDraft={onDraft} />
              </div>
            </div>
          ) : (
            <>
              {p.relationship === "enrich" && p.targetLabel ? (
                <div style={{ ...mono, fontSize: 10.5, color: "var(--text-2)", marginBottom: 6 }}>
                  Attaches to {p.targetLabel} — you can edit the wording, not the role.
                </div>
              ) : null}
              <Editor draft={draft} onDraft={onDraft} />
            </>
          )}
        </div>
      ) : null}

      {!readOnly ? (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          {p.status === "pending" ? (
            <>
              <button
                type="button"
                onClick={() => onDecide("decline")}
                disabled={busy}
                style={ghostBtn(busy)}
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => onDecide("edit")}
                disabled={busy || !dirty}
                style={ghostBtn(busy || !dirty)}
              >
                Save edit
              </button>
              <button
                type="button"
                onClick={() => onDecide("accept")}
                disabled={busy}
                style={primaryBtn(busy)}
              >
                Accept
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onDecide("edit")}
              disabled={busy}
              style={ghostBtn(busy)}
            >
              Undo
            </button>
          )}
        </div>
      ) : null}
    </article>
  );
}

function Editor({ draft, onDraft }: { draft: ProposalDraft; onDraft: (d: ProposalDraft) => void }) {
  switch (draft.kind) {
    case "basics-field":
      return (
        <Area
          label="Value"
          value={draft.value}
          onChange={(value) => onDraft({ ...draft, value })}
          rows={2}
        />
      );
    case "work":
      return (
        <Stack>
          <Field
            label="Company"
            value={draft.company}
            onChange={(company) => onDraft({ ...draft, company })}
          />
          <Field
            label="Role"
            value={draft.position}
            onChange={(position) => onDraft({ ...draft, position })}
          />
          <Row>
            <Field
              label="From"
              value={draft.startDate}
              onChange={(startDate) => onDraft({ ...draft, startDate })}
            />
            <Field
              label="To (blank = present)"
              value={draft.endDate}
              onChange={(endDate) => onDraft({ ...draft, endDate })}
            />
          </Row>
          <Area
            label="Highlights (one per line)"
            value={draft.highlights}
            onChange={(highlights) => onDraft({ ...draft, highlights })}
            rows={4}
          />
          <Field
            label="Tags (comma-separated)"
            value={draft.tags}
            onChange={(tags) => onDraft({ ...draft, tags })}
          />
        </Stack>
      );
    case "education":
      return (
        <Stack>
          <Field
            label="Institution"
            value={draft.institution}
            onChange={(institution) => onDraft({ ...draft, institution })}
          />
          <Field label="Area" value={draft.area} onChange={(area) => onDraft({ ...draft, area })} />
          <Field
            label="Study type"
            value={draft.studyType}
            onChange={(studyType) => onDraft({ ...draft, studyType })}
          />
          <Row>
            <Field
              label="From"
              value={draft.startDate}
              onChange={(startDate) => onDraft({ ...draft, startDate })}
            />
            <Field
              label="To (blank = present)"
              value={draft.endDate}
              onChange={(endDate) => onDraft({ ...draft, endDate })}
            />
          </Row>
        </Stack>
      );
    case "skill":
      return (
        <Stack>
          <Field
            label="Skill"
            value={draft.name}
            onChange={(name) => onDraft({ ...draft, name })}
          />
          <Field
            label="Level (optional)"
            value={draft.level}
            onChange={(level) => onDraft({ ...draft, level })}
          />
          <Field
            label="Keywords (comma-separated)"
            value={draft.keywords}
            onChange={(keywords) => onDraft({ ...draft, keywords })}
          />
        </Stack>
      );
    case "certificate":
      return (
        <Stack>
          <Field label="Name" value={draft.name} onChange={(name) => onDraft({ ...draft, name })} />
          <Field
            label="Issuer"
            value={draft.issuer}
            onChange={(issuer) => onDraft({ ...draft, issuer })}
          />
          <Field label="Date" value={draft.date} onChange={(date) => onDraft({ ...draft, date })} />
        </Stack>
      );
    case "profile":
      return (
        <Stack>
          <Field
            label="Network"
            value={draft.network}
            onChange={(network) => onDraft({ ...draft, network })}
          />
          <Field label="URL" value={draft.url} onChange={(url) => onDraft({ ...draft, url })} />
        </Stack>
      );
    case "language":
      return (
        <Stack>
          <Field
            label="Language"
            value={draft.language}
            onChange={(language) => onDraft({ ...draft, language })}
          />
          <Field
            label="Fluency (optional)"
            value={draft.fluency}
            onChange={(fluency) => onDraft({ ...draft, fluency })}
          />
        </Stack>
      );
    case "highlight":
      return (
        <Area
          label="Bullet"
          value={draft.text}
          onChange={(text) => onDraft({ ...draft, text })}
          rows={2}
        />
      );
  }
}

// --- Sub-views --------------------------------------------------------------------------------

function PasteView({
  text,
  onText,
  onSubmit,
  file,
  onFile,
  onUpload,
  fileInputRef,
  disabled,
  runs,
  onInspect,
  onDiscard,
  onClose,
}: {
  text: string;
  onText: (v: string) => void;
  onSubmit: () => void;
  file: File | null;
  onFile: (f: File | null) => void;
  onUpload: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  runs: IngestRun[];
  onInspect: (id: string) => void;
  onDiscard: (r: IngestRun) => void;
  onClose: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Land focus in the paste box when the input view opens (the drop-zone is one Tab away).
  useEffect(() => {
    textRef.current?.focus();
  }, []);
  // One action for both arms (the design's single "Parse & check"): a chosen/dropped file uploads
  // (PDF only; submitFile validates), otherwise the pasted text is parsed. File takes precedence so a
  // stray paste can't shadow a picked file.
  const canSubmit = !disabled && (file !== null || text.trim() !== "");
  const submitAll = () => {
    if (file) onUpload();
    else onSubmit();
  };
  return (
    <>
      {/* The drop-zone is a <label> wrapping a hidden file input → click opens the picker; drag/drop
          sets the file. border/background live in `.cos-dropzone` so its :hover fires; the drag state
          overrides them inline (the stronger signal beats hover). */}
      <label
        className="cos-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 9,
          textAlign: "center",
          padding: "30px 20px", // the mockup's dropzone inset (30px), not the near-miss 28px

          borderRadius: 12,
          cursor: disabled ? "default" : "pointer",
          ...(dragging
            ? {
                borderColor: "var(--accent)",
                background: "color-mix(in srgb, var(--accent) 8%, transparent)",
              }
            : null),
        }}
      >
        <span style={dropIcon} aria-hidden>
          <UploadIcon />
        </span>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
          {file ? file.name : "Drop a PDF or click to browse"}
        </div>
        <div style={{ ...mono, fontSize: 10.5, color: "var(--text-3)" }}>
          {file ? "Ready to import · choose another to replace" : "PDF · max 10 MB / 30 pages"}
        </div>
        {/* Visually hidden but FOCUSABLE (srOnly, not display:none) so keyboard users can Tab to it
            and Space/Enter opens the picker; `.cos-dropzone:focus-within` shows the ring (WCAG 2.1.1). */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          aria-label="CV or LinkedIn PDF"
          disabled={disabled}
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          style={srOnly}
        />
      </label>

      <div style={orDivider}>
        <span style={orLine} />
        OR PASTE TEXT
        <span style={orLine} />
      </div>

      <textarea
        ref={textRef}
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder="Paste bullet points, a description of what you did, or a whole CV…"
        rows={6}
        aria-label="CV or LinkedIn text"
        style={{ ...areaStyle, minHeight: 130 }}
      />

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 9 }}>
        <button type="button" onClick={onClose} style={ghostBtn(false)}>
          Cancel
        </button>
        <button
          type="button"
          onClick={submitAll}
          disabled={!canSubmit}
          style={{
            ...primaryBtn(!canSubmit),
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          <ArrowIcon /> Parse &amp; check
        </button>
      </div>

      {runs.length > 0 ? (
        <RecentRuns runs={runs} onInspect={onInspect} onDiscard={onDiscard} />
      ) : null}
    </>
  );
}

function RecentRuns({
  runs,
  onInspect,
  onDiscard,
}: {
  runs: IngestRun[];
  onInspect: (id: string) => void;
  onDiscard: (r: IngestRun) => void;
}) {
  return (
    <article style={card}>
      <h2 style={{ margin: "0 0 10px", fontSize: 14 }}>Recent imports</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {runs.map((r) => {
          const open =
            r.status === "extracting" || r.status === "reconciling" || r.status === "review";
          return (
            <div
              key={r.id}
              style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <button
                type="button"
                onClick={() => onInspect(r.id)}
                style={{ ...rowBtn, flex: "1 1 auto", textAlign: "left" }}
              >
                <span style={{ ...mono, fontSize: 11, color: "var(--text-2)" }}>
                  {runStatusLabel(r.status)}
                </span>
                <span style={{ ...mono, fontSize: 10.5, color: "var(--text-3)" }}>
                  {relativeTime(r.createdAt)}
                </span>
              </button>
              {open ? (
                <button type="button" onClick={() => onDiscard(r)} style={ghostBtn(false)}>
                  Discard
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}

function AppliedSummary({
  bundle,
  applied,
  busy,
  onOpen,
  onStartOver,
}: {
  bundle: RunBundle;
  applied: ApplyResult | null;
  busy: boolean;
  onOpen: () => void;
  onStartOver: () => void;
}) {
  // Per-item attribution: a saved proposal landed; a skipped one was a conflict (apply is partial).
  // With the fresh ApplyResult, its conflicts are authoritative; on a deep-link reload (no result)
  // fall back to the persisted appliedMasterId — so a failed post-apply reload can't mislabel saves.
  const accepted = bundle.proposals.filter((p) => p.status === "accepted");
  const reasons = new Map((applied?.conflicts ?? []).map((c) => [c.proposalId, c.reason]));
  const conflictIds = new Set((applied?.conflicts ?? []).map((c) => c.proposalId));
  const isSaved = (p: Proposal) => (applied ? !conflictIds.has(p.proposalId) : !!p.appliedMasterId);
  const savedCount = applied?.appliedCount ?? accepted.filter((p) => p.appliedMasterId).length;
  // Recommended-but-empty basics → a yellow, non-blocking nudge. Immediate-only: it reads the fresh
  // ApplyResult.master (null on a deep-link reload), so the durable answer is the Edit-your-CV labels.
  const tip = applied?.master ? joinRecommended(recommendedMissing(applied.master.basics)) : null;
  return (
    <article style={card}>
      <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>
        Imported {savedCount} item{savedCount === 1 ? "" : "s"} into your master
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>
        Your master profile is updated. Open it to see the full profile and tailor a CV.
      </p>
      {tip ? (
        <p
          role="note"
          style={{
            margin: "0 0 12px",
            paddingLeft: 10,
            borderLeft: "3px solid var(--warn)",
            fontSize: 12.5,
            color: "var(--text-2)",
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: "var(--text)" }}>Tip:</strong> for a more complete profile, add{" "}
          {tip} in{" "}
          <a href="/master" style={{ color: "var(--accent)" }}>
            Edit your CV
          </a>
          .
        </p>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
        {accepted.map((p) => {
          const saved = isSaved(p);
          return (
            <div
              key={p.proposalId}
              style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}
            >
              {/* The ✓/⚠ glyph carries the state (not colour alone); "saved" keeps --ok (AA-pass),
                  "skipped" drops to --text-2 (--warn fails AA in light) — rubric §6. */}
              <span style={{ ...mono, fontSize: 11, color: saved ? "var(--ok)" : "var(--text-2)" }}>
                {saved ? "✓ saved" : "⚠ skipped"}
              </span>
              <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{p.summary}</span>
              {!saved && reasons.get(p.proposalId) ? (
                <span style={{ ...mono, fontSize: 10.5, color: "var(--text-3)" }}>
                  — {reasons.get(p.proposalId)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={onOpen} disabled={busy} style={primaryBtn(busy)}>
          Review your imported profile →
        </button>
        <button type="button" onClick={onStartOver} disabled={busy} style={ghostBtn(busy)}>
          Import another
        </button>
      </div>
    </article>
  );
}

function ApplyBlock({
  block,
  containerRef,
  onDiscard,
  onDismiss,
}: {
  block: { kind: "stale" | "identity" | "error"; message: string };
  containerRef: (el: HTMLElement | null) => void;
  onDiscard: () => void;
  onDismiss: () => void;
}) {
  // role="alert" + tabIndex so the parent's callback ref can scroll AND focus it (a plain <article>
  // isn't focusable — .focus() would no-op), and a screen reader announces the failure on arrival.
  // `identity` is a genuine block (name/email are mandatory) → red (--bad); stale/error are softer
  // (--warn). Semantic color stays on heading+border only — body copy is --text-2 (contrast + tone).
  const accent = block.kind === "identity" ? "var(--bad)" : "var(--warn)";
  return (
    <article
      ref={containerRef}
      tabIndex={-1}
      role="alert"
      style={{ ...card, borderColor: `color-mix(in srgb, ${accent} 45%, transparent)` }}
    >
      {/* Heading is --text for AA (--warn fails in light); the alert tone lives on the border + the
          role="alert" announcement — rubric §6. */}
      <h2 style={{ margin: "0 0 6px", fontSize: 14, color: "var(--text)" }}>
        {block.kind === "identity"
          ? "Add your name and email to import"
          : block.kind === "error"
            ? "Couldn't import — please try again"
            : "Couldn't import — the master changed"}
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>
        {block.message}
      </p>
      {block.kind === "identity" ? (
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>
          Open{" "}
          <a href="/master" style={{ color: "var(--accent)" }}>
            Edit your CV
          </a>{" "}
          to add them, then import again — or paste a document that includes them.
        </p>
      ) : null}
      {/* identity/stale can't be applied as-is, so the only way forward is Discard + start again (after
          fixing the master, for identity). A transient `error` IS retryable — the run is still open and
          the Apply bar is still there — so it just needs dismissing, not discarding. */}
      {block.kind === "error" ? (
        <button type="button" onClick={onDismiss} style={primaryBtn(false)}>
          Dismiss
        </button>
      ) : (
        <button type="button" onClick={onDiscard} style={primaryBtn(false)}>
          Discard &amp; start over
        </button>
      )}
    </article>
  );
}

// In-app replacement for window.confirm: a native <dialog> opened with showModal(), so the BROWSER
// owns modality — it makes the background inert, traps focus, and restores focus to the trigger when
// the dialog closes. A div overlay with a hand-rolled Tab trap can't guarantee any of that for
// assistive tech. Every dismissal (Cancel, Confirm, Escape) goes through dialog.close(returnValue) and
// the close event maps it to onCancel/onConfirm, so the browser's focus restoration always runs.
// The dim backdrop is the `dialog::backdrop` rule in globals.css.
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // An in-modal OVERLAY (not a nested <dialog>): a second showModal() dialog stacked on the import
  // modal took the parent down with it on close. A fixed overlay rendered inside the modal's <dialog>
  // shares its top-layer stacking context (so it covers the modal). Because it is NOT a <dialog> it
  // self-manages modality: focus Cancel, TRAP Tab within the two buttons, Escape → cancel, and restore
  // focus on close. The fixed backdrop blocks pointer access to the obscured modal behind; the Tab trap
  // blocks keyboard access — so the controls behind stay unreachable while the confirm is open.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // don't let Escape also reach the import modal's <dialog>
        onCancel();
        return;
      }
      if (e.key === "Tab") {
        const first = cancelRef.current;
        const last = confirmRef.current;
        if (!first || !last) return;
        e.preventDefault();
        const a = document.activeElement;
        if (e.shiftKey) (a === first ? last : first).focus();
        else (a === last ? first : last).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (prev?.isConnected) prev.focus();
    };
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ingest-confirm-title"
      aria-describedby="ingest-confirm-body"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10,
        display: "grid",
        placeItems: "center",
        padding: 20,
        background: "rgba(0, 0, 0, 0.45)",
      }}
    >
      <div
        style={{
          ...card,
          maxWidth: 420,
          width: "calc(100% - 2rem)",
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.35)",
        }}
      >
        <h2 id="ingest-confirm-title" style={{ margin: "0 0 6px", fontSize: 15 }}>
          {title}
        </h2>
        <p
          id="ingest-confirm-body"
          style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}
        >
          {body}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button ref={cancelRef} type="button" onClick={onCancel} style={ghostBtn(false)}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" onClick={onConfirm} style={primaryBtn(false)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ApplyBar({
  ready,
  pending,
  busy,
  disabled,
  dirty,
  onApply,
  onDiscard,
}: {
  ready: number;
  pending: number;
  busy: boolean;
  disabled: boolean;
  dirty: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  // A footer pinned to the bottom of the scrolling modal (sticky, not the page-level fixed bar) so
  // Apply stays reachable while the proposal list scrolls above it.
  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        background: "var(--panel)",
        borderTop: "1px solid var(--line)",
        padding: "13px 18px",
        paddingBottom: "max(env(safe-area-inset-bottom), 13px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>
        <strong style={{ color: "var(--text)" }}>{ready}</strong> ready to import
        {pending > 0 ? (
          <span style={{ color: "var(--text-3)" }}> · {pending} still to review</span>
        ) : null}
        {dirty ? (
          <div style={{ ...mono, fontSize: 10.5, color: "var(--text-2)", marginTop: 2 }}>
            Save or discard your edits first.
          </div>
        ) : ready === 0 ? (
          <div
            style={{
              ...mono,
              fontSize: 11,
              color: "var(--ink-warn)",
              fontWeight: 600,
              marginTop: 2,
            }}
          >
            Accept at least one item below to enable Apply.
          </div>
        ) : null}
      </div>
      {/* Discard is always reachable from the sticky bar so a run can never wedge the workspace —
            e.g. when everything is declined, Apply is disabled but the run is still open. */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={onDiscard} disabled={busy} style={ghostBtn(busy)}>
          Discard import
        </button>
        <button type="button" onClick={onApply} disabled={disabled} style={primaryBtn(disabled)}>
          {busy ? "Importing…" : "Apply to your master"}
        </button>
      </div>
    </div>
  );
}

// --- Small presentational helpers -------------------------------------------------------------

function StatusBadge({ p, readOnly, dirty }: { p: Proposal; readOnly: boolean; dirty: boolean }) {
  if (readOnly) {
    if (p.appliedMasterId) return <span style={tag("var(--ok)")}>saved to master</span>;
    if (p.status === "accepted") return <span style={tag("var(--warn)")}>skipped</span>;
    if (p.status === "declined") return <span style={tag("var(--text-3)")}>declined</span>;
    return <span style={tag("var(--text-3)")}>not reviewed</span>;
  }
  if (p.status === "accepted")
    return <span style={tag("var(--ok)")}>accepted · not yet saved</span>;
  if (p.status === "declined") return <span style={tag("var(--text-3)")}>declined</span>;
  if (dirty) return <span style={tag("var(--text-3)")}>unsaved edit</span>;
  return <span style={tag("var(--warn)")}>new</span>;
}

function EvidenceBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span style={tag("var(--text-3)")} title="This text was found in your document">
      ✓ verified
    </span>
  ) : (
    <span
      style={tag("var(--warn)")}
      title="We couldn't find this exact text in your CV — see the note below"
    >
      ⚠ check this
    </span>
  );
}

function Progress({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ ...mono, fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}
    >
      {label}
    </div>
  );
}

// The live streaming-import view: the shared AgentChecklist (status sentence + per-agent list) wrapped
// in this screen's card, with ingest's labels + copy. The Stop escape hatch matters here because the
// 15s keepalives mean a stall would otherwise have no exit; it appears only once the stream is live
// (≥1 agent event) — by then the X-Run-Id has been read, so a Stop → abort discards the exact run
// race-free.
function IngestProgress({
  checklist,
  statusLine,
  onCancel,
}: {
  checklist: Checklist;
  statusLine: string;
  onCancel: () => void;
}) {
  return (
    <article style={card}>
      <AgentChecklist
        checklist={checklist}
        statusLine={statusLine}
        label={agentLabel}
        busyLabel="Reading your document…"
        footnote="This usually takes 10–30 seconds. Keep this tab open."
        onCancel={onCancel}
        cancelLabel="Stop & check my imports"
        cancelStyle={ghostBtn(false)}
      />
    </article>
  );
}

const Stack = ({ children }: { children: ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
);
const Row = ({ children }: { children: ReactNode }) => (
  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>
);

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ flex: "1 1 160px", display: "block" }}>
      <span style={{ display: "block", fontSize: 11, color: "var(--text-2)", marginBottom: 3 }}>
        {label}
      </span>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </label>
  );
}

function Area({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 11, color: "var(--text-2)", marginBottom: 3 }}>
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        style={areaStyle}
      />
    </label>
  );
}

// A centered note in the modal body for the loading / error phases (the modal frame is
// always present; only the body swaps). `tone="bad"` is an alert with AA --text; the rest is muted.
function ModalNote({ children, tone }: { children: ReactNode; tone?: "bad" }) {
  return (
    <div
      role={tone === "bad" ? "alert" : undefined}
      style={{
        ...mono,
        padding: "44px 24px",
        textAlign: "center",
        fontSize: 12.5,
        lineHeight: 1.6,
        color: tone === "bad" ? "var(--text)" : "var(--text-3)",
      }}
    >
      {children}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 16V4M8 8l4-4 4 4" />
      <path d="M5 20h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

// --- view helpers -----------------------------------------------------------------------------

function ingestErr(err: unknown): string {
  if (err instanceof ApiError) return ingestErrorMessage(err.status, err.message);
  return "Something went wrong.";
}

function runStatusLabel(s: IngestRun["status"]): string {
  switch (s) {
    case "extracting":
    case "reconciling":
      return "Reading…";
    case "review":
      return "Ready to review";
    case "applied":
      return "Imported";
    case "failed":
      return "Didn't finish";
    case "discarded":
      return "Discarded";
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// --- Styles (ingest-local; 16px inputs avoid iOS focus-zoom, 44px tap targets) -----------------

const card = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: "16px 16px 14px",
} as const;

const evidenceQuote = {
  margin: "6px 0 0",
  padding: "6px 10px",
  borderLeft: "2px solid var(--line-strong)",
  background: "var(--panel-2)",
  borderRadius: "0 8px 8px 0",
  fontSize: 12,
  color: "var(--text-3)",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
} as const;

const inputStyle = {
  width: "100%",
  padding: "10px 11px",
  minHeight: 44,
  borderRadius: 9,
  border: "1px solid var(--line-strong)",
  background: "var(--panel-2)",
  color: "var(--text)",
  fontSize: 16,
  fontFamily: "var(--ui)",
  boxSizing: "border-box",
} as const;

const areaStyle = {
  ...inputStyle,
  lineHeight: 1.5,
  resize: "vertical",
} as const;

const srOnly = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

const rowBtn = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  minHeight: 44,
  padding: "8px 11px",
  borderRadius: 9,
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  cursor: "pointer",
} as const;

// --- modal chrome (the <dialog> shell + the design's import-modal header/body) -----------------

const dialogStyle = {
  padding: 0,
  width: "calc(100% - 2rem)",
  maxWidth: 640,
  maxHeight: "86vh",
  overflow: "auto",
  margin: "7vh auto",
  background: "var(--panel)",
  border: "1px solid var(--line-strong)",
  borderRadius: 16,
  boxShadow: "0 40px 100px -30px rgba(0, 0, 0, 0.7)",
  color: "var(--text)",
  fontFamily: "var(--ui)",
  animation: "fadeUp 0.25s ease",
} as const;

// Sticky so the title + Close stay reachable while the modal body scrolls.
const headerRow = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "15px 18px",
  background: "var(--panel)",
  borderBottom: "1px solid var(--line)",
} as const;

const iconSquare = {
  flex: "none",
  width: 26,
  height: 26,
  borderRadius: 7,
  background: "color-mix(in srgb, var(--accent) 16%, transparent)",
  color: "var(--accent)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

const modalBody = {
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
} as const;

const dropIcon = {
  width: 42,
  height: 42,
  borderRadius: 11,
  background: "var(--panel)",
  border: "1px solid var(--line)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--accent)",
} as const;

const orDivider = {
  ...mono,
  display: "flex",
  alignItems: "center",
  gap: 12,
  fontSize: 10,
  letterSpacing: "0.08em",
  // --text-2: "OR PASTE TEXT" announces a real alternative path, not eyebrow metadata (rubric §6).
  color: "var(--text-2)",
} as const;

const orLine = { flex: 1, height: 1, background: "var(--line)" } as const;

// Status chip — shared with the other screens (src/ui). The buttons/inputs below stay ingest-local:
// 44px tap targets + 16px inputs (iOS focus-zoom) are intentional mobile tuning, not drift.
const tag = tagStyle;

function primaryBtn(disabled: boolean) {
  return {
    padding: "11px 16px",
    minHeight: 44,
    borderRadius: 9,
    border: "none",
    background: "var(--accent)",
    color: "var(--on-accent)",
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: "nowrap",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  } as const;
}

function ghostBtn(disabled: boolean) {
  return {
    ...mono,
    padding: "10px 14px",
    minHeight: 44,
    borderRadius: 9,
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--text-2)",
    fontSize: 11.5,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
  } as const;
}
