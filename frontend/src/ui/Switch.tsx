// Toggle switch — a compact 40×23 track + 19px knob (from the design) centred in a ≥44px transparent
// hit target (AGENTS §7) so the visual stays small while the tap/focus area clears the touch floor.
// The knob is a fixed light token (--switch-knob in globals.css) so it reads as a physical switch in
// both themes. `color` tints the ON track (defaults to accent; agent surfaces pass their identity colour).
// Non-text contrast (WCAG 1.4.11): the OFF track is `--switch-track-off` (≥3:1 vs --panel + the knob —
// --line-strong was 1.74) and the knob carries an opaque `--switch-knob-ring` outline so it stays
// discernible on every checked-track colour in use (the white body alone fails all dark checked
// tracks). The full track × knob(+ring) × host matrix is asserted by src/ui/contrast.test.ts.
export function Switch({
  checked,
  onChange,
  label,
  color = "var(--accent)",
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible label (the switch has no visible text of its own). */
  label: string;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        flex: "none",
        // ≥44px tap/focus target (AGENTS §7) around the compact visual track below.
        width: 44,
        height: 44,
        padding: 0,
        border: "none",
        background: "transparent",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* The visible 40×23 track + knob (aria-hidden — the button carries the role/state/label). */}
      <span
        aria-hidden
        style={{
          width: 40,
          height: 23,
          borderRadius: 12,
          padding: 2,
          boxSizing: "border-box",
          background: checked ? color : "var(--switch-track-off)",
          transition: "background 0.15s",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: checked ? "flex-end" : "flex-start",
        }}
      >
        <span
          style={{
            width: 19,
            height: 19,
            borderRadius: "50%",
            background: "var(--switch-knob)",
            // Opaque ring (never an alpha shadow) — keeps the knob ≥3:1 on light checked tracks.
            border: "1.5px solid var(--switch-knob-ring)",
          }}
        />
      </span>
    </button>
  );
}
