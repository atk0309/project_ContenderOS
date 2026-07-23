"use client";

// Identity + sign-out. Full-width row in the sidebar (avatar + name + "Operator · sign out" + exit
// icon); a compact avatar button in the mobile header. One kind of account (every allowlisted
// account is an owner), so the avatar is always the accent-coloured Operator.
import type { CSSProperties } from "react";
import { useSession } from "./SessionProvider";

const ACCOUNT_META = { label: "Operator", bg: "var(--accent)" } as const;

function initialsOf(email: string): string {
  const local = email.split("@")[0] || email;
  const [a, b] = local.split(/[.\-_]+/).filter(Boolean);
  const raw = a && b ? `${a.charAt(0)}${b.charAt(0)}` : local.slice(0, 2);
  return raw.toUpperCase();
}

const avatar = (bg: string, size: number): CSSProperties => ({
  flex: "none",
  width: size,
  height: size,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 600,
  fontSize: size <= 30 ? 12 : 13,
  color: "var(--on-accent)",
  background: bg,
});

export function AccountButton({ compact = false }: { compact?: boolean }) {
  const { user, signOut } = useSession();
  const meta = ACCOUNT_META;
  const initials = initialsOf(user.email);

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => void signOut()}
        title={`${user.email} · sign out`}
        aria-label="Sign out"
        style={{ ...avatar(meta.bg, 32), cursor: "pointer", border: "none" }}
      >
        {initials}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      title={`${user.email} · sign out`}
      className="cos-navrow"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        height: 46,
        borderRadius: 10,
        padding: "0 8px",
        width: "100%",
        textAlign: "left",
      }}
    >
      <span style={avatar(meta.bg, 30)}>{initials}</span>
      <span className="cos-rail-label" style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--text)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {user.email}
        </span>
        <span
          style={{
            display: "block",
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--text-3)",
          }}
        >
          {meta.label} · sign out
        </span>
      </span>
    </button>
  );
}
