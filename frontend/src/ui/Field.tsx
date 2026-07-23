// Form-field primitives (label + input/textarea) shared by the master editor and other forms. Exported
// as style objects so call-sites that already render their own <input>/<textarea> can drop their local
// copies; the <Field>/<TextArea> wrappers cover the common labelled-control case.
import type { CSSProperties, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--text-2)",
  marginBottom: 4,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  background: "var(--panel-2)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "var(--ui)",
  boxSizing: "border-box",
};

export const textareaStyle: CSSProperties = {
  ...inputStyle,
  lineHeight: 1.5,
  resize: "vertical",
};

export function Field({
  label,
  style,
  ...rest
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label>
      <span style={fieldLabel}>{label}</span>
      <input style={{ ...inputStyle, ...style }} {...rest} />
    </label>
  );
}

export function TextArea({
  label,
  style,
  ...rest
}: { label: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label>
      <span style={fieldLabel}>{label}</span>
      <textarea style={{ ...textareaStyle, ...style }} {...rest} />
    </label>
  );
}
