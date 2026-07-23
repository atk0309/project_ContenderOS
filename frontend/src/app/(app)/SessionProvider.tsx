"use client";

// Single session source + auth gate for the authed app shell. Fetches the cookie-authenticated
// /auth/me ONCE per (app) mount and shares it via context, so pages stop each re-fetching it and
// re-implementing the 401 -> /sign-in redirect. Children (the shell + the page) mount only when
// signed-in, so every consumer can assume a resolved, non-null user. /sign-in and /print live OUTSIDE
// the (app) group, so they never mount this provider (the render path stays chrome-free, invariant 3).
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { ApiError, api, type Schemas } from "@/lib/api/client";

type AuthUser = Schemas["AuthUser"];

type SessionValue = {
  // Non-null below the gate — children only render once signed-in.
  user: AuthUser;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within the (app) SessionProvider");
  return ctx;
}

type State = { status: "loading" } | { status: "anon" } | { status: "signed-in"; user: AuthUser };

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let active = true;
    api<AuthUser>("/auth/me")
      .then((user) => {
        if (active) setState({ status: "signed-in", user });
      })
      .catch((err: unknown) => {
        if (!active) return;
        // 401 (no/expired session) is the expected anon case; treat any other failure (backend
        // unreachable, CORS) the same way — bounce to sign-in rather than hang on the spinner.
        if (!(err instanceof ApiError) || err.status !== 401) {
          console.warn("auth check failed", err);
        }
        setState({ status: "anon" });
        router.replace("/sign-in");
      });
    return () => {
      active = false;
    };
  }, [router]);

  if (state.status !== "signed-in") {
    // Loading or mid-redirect: a quiet full-screen placeholder, never the app shell.
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>
          {state.status === "loading" ? "Checking your session…" : "Redirecting to sign-in…"}
        </span>
      </div>
    );
  }

  const { user } = state;
  async function signOut() {
    await api<Schemas["OkResponse"]>("/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/sign-in");
  }

  return <SessionContext.Provider value={{ user, signOut }}>{children}</SessionContext.Provider>;
}
