"use client";

// Shares "is AI tailoring usable?" across the authed shell so the workspace + dashboard can lead with
// Tailor when it will actually work (and nudge to Admin when it won't), instead of letting the owner
// discover a 503 mid-tailor. Every allowlisted account is an owner, so the owner-gated GET
// /admin/providers is always safe to fetch. Tri-state: `unknown` (in flight / transient failure)
// renders the CONFIGURED presentation, so a correctly-set-up owner never sees a primary->secondary
// flash on cold load; only a definitive `not-ready` inverts the CTAs. Kept fresh: refresh() after
// admin key/tier changes + on tab refocus.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { reviewReady, tailorReady } from "@/lib/ai-readiness";
import { api, type Schemas } from "@/lib/api/client";

export type Readiness = "unknown" | "ready" | "not-ready";

type ReadinessValue = {
  tailor: Readiness;
  // The review fan-out needs BOTH providers at strong tier (unlike `tailor`, anthropic-only), so it's
  // a separate signal derived from the same /admin/providers response — see `reviewReady`.
  review: Readiness;
  refresh: () => void;
};

const ReadinessContext = createContext<ReadinessValue | null>(null);

export function useAiReadiness(): ReadinessValue {
  const ctx = useContext(ReadinessContext);
  if (!ctx) throw new Error("useAiReadiness must be used within the (app) ReadinessProvider");
  return ctx;
}

export function ReadinessProvider({ children }: { children: ReactNode }) {
  const [tailor, setTailor] = useState<Readiness>("unknown");
  const [review, setReview] = useState<Readiness>("unknown");

  const refresh = useCallback(() => {
    api<Schemas["AdminStatus"]>("/admin/providers")
      .then((status) => {
        setTailor(tailorReady(status) ? "ready" : "not-ready");
        setReview(reviewReady(status) ? "ready" : "not-ready");
      })
      // A transient failure stays `unknown` (the configured presentation), never a false `not-ready`.
      .catch(() => {
        setTailor("unknown");
        setReview("unknown");
      });
  }, []);

  useEffect(() => {
    refresh();
    // Keys may change in /admin and the owner may return via Back/tab-switch; revalidate so the CTAs
    // don't stay stale (mirrors the dashboard's pageshow/visibility refresh pattern).
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return (
    <ReadinessContext.Provider value={{ tailor, review, refresh }}>
      {children}
    </ReadinessContext.Provider>
  );
}
