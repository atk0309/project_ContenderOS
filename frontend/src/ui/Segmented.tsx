// Segmented control (e.g. the reviewer strictness Lenient / Balanced / Strict), from the design.
// One option active at a time; the group is keyboard- and SR-navigable. Each segment is a ≥44px-tall
// tap target (AGENTS §7); labels stay on one line so a narrow column clips rather than reflows.
export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      style={{
        display: "flex",
        gap: 4,
        border: "1px solid var(--line)",
        borderRadius: 9,
        padding: 3,
        margin: 0,
        minInlineSize: 0,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              minHeight: 44,
              padding: "6px 8px",
              borderRadius: 7,
              border: "none",
              cursor: disabled ? "default" : "pointer",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              fontWeight: 600,
              whiteSpace: "nowrap",
              color: active ? "var(--on-accent)" : "var(--text-2)",
              background: active ? "var(--accent)" : "transparent",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}
