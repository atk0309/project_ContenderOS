// The square glyph badge for a review agent (Pr/Ta/Ed/Fc/Sp/Gk/Ag), coloured by the canonical
// identity (src/ui/colors.ts). Glyph ink is the theme-aware --agent-ink token (dark ink on the light
// dark-theme badges; light ink on the darker light-theme badges) so it stays AA-legible in both.
import { agentIdentity } from "./colors";

export function AgentBadge({ agent, size = 22 }: { agent: string; size?: number }) {
  const id = agentIdentity(agent);
  return (
    <span
      title={id.name}
      style={{
        flex: "none",
        width: size,
        height: size,
        borderRadius: Math.max(5, Math.round(size * 0.27)),
        background: id.color,
        color: id.ink,
        fontFamily: "var(--mono)",
        fontSize: Math.max(9, Math.round(size * 0.43)),
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {id.glyph}
    </span>
  );
}
