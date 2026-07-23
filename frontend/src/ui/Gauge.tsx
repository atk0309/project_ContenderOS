// The circular ATS-score gauge from the design (Gatekeeper verdict). Pure + deterministic: the arc is
// score/100 of the circumference. Colour is a token chosen by the caller (verdict colour).
import type { CSSProperties } from "react";

const R = 52;
const CIRCUMFERENCE = 2 * Math.PI * R; // ≈ 326.7

export function Gauge({
  score,
  color,
  size = 124,
  stroke = 9,
  caption = "ATS / 100",
}: {
  score: number;
  /** Arc colour — a token (e.g. var(--ok)). */
  color: string;
  size?: number;
  stroke?: number;
  caption?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const offset = CIRCUMFERENCE * (1 - clamped / 100);
  return (
    <div
      role="img"
      aria-label={`ATS match ${clamped} out of 100`}
      style={{ position: "relative", width: size, height: size, flex: "none" }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 124 124"
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="62" cy="62" r={R} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx="62"
          cy="62"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div style={center}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: size * 0.24,
            fontWeight: 600,
            color: "var(--text)",
            lineHeight: 1,
          }}
        >
          {clamped}
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 9.5,
            letterSpacing: "0.08em",
            color: "var(--text-3)",
          }}
        >
          {caption}
        </span>
      </div>
    </div>
  );
}

const center: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
};
