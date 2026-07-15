import { useState } from "react";

export function PasswordField({
  autoComplete,
  disabled,
  hint,
  id,
  label,
  minLength,
  name,
  onChange,
  showLabel,
  hideLabel,
  value
}: {
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  hint?: string;
  id: string;
  label: string;
  minLength?: number;
  name: string;
  onChange: (value: string) => void;
  showLabel: string;
  hideLabel: string;
  value: string;
}) {
  const [visible, setVisible] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      {hint ? <span id={hintId} className="auth-field-hint">{hint}</span> : null}
      <span className="auth-password-control">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          aria-describedby={hintId}
          disabled={disabled}
          minLength={minLength}
          maxLength={256}
          required
          spellCheck={false}
          enterKeyHint="done"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="auth-password-toggle"
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
        >
          <span aria-hidden="true">{visible ? "◌" : "●"}</span>
        </button>
      </span>
    </div>
  );
}
