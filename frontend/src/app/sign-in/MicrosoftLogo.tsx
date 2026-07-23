// The Microsoft logo — a FIXED brand asset (the four brand-colour squares). Isolated in its own file
// so the fidelity guard (scripts/check-invariants.mjs) can allow these specific brand hex literals
// here ONLY, while the rest of the app stays strictly token-only.
export function MicrosoftLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 23 23" aria-hidden="true" focusable="false">
      <rect width="10" height="10" x="1" y="1" fill="#f25022" />
      <rect width="10" height="10" x="12" y="1" fill="#7fba00" />
      <rect width="10" height="10" x="1" y="12" fill="#00a4ef" />
      <rect width="10" height="10" x="12" y="12" fill="#ffb900" />
    </svg>
  );
}
