"use client";

// Home (`/`) is a pure redirect. The Workspace screen absorbed the CV dashboard (B1), so everyone
// is sent to /workspace — every allowlisted account is an owner. The (app) shell's SessionProvider
// owns the auth gate (it resolves /auth/me and bounces to /sign-in on 401 before this renders).
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/workspace");
  }, [router]);

  // The mount effect redirects to /workspace; this is the brief in-between.
  return (
    <div style={center}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>
        Opening your workspace…
      </span>
    </div>
  );
}

const center = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: "2rem",
} as const;
