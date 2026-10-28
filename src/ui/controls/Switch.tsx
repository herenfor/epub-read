import "./switch.css";

export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  /** Accessible name when no visible label wraps the switch. */
  label?: string;
  title?: string;
  /**
   * Inside a row that is already a <label> (the whole row toggles): render a
   * span, since labels cannot nest. Standalone it is its own label.
   */
  inRow?: boolean;
  className?: string;
}

/** The one on/off switch of the app: 40×24, accent when on. */
export function Switch({ checked, onChange, disabled, label, title, inRow, className }: SwitchProps) {
  const input = <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label}
    onChange={(event) => onChange(event.target.checked)} />;
  const classes = `ui-switch${className ? ` ${className}` : ""}`;
  const track = <span className="ui-switch-track" aria-hidden="true" />;
  return inRow
    ? <span className={classes} title={title}>{input}{track}</span>
    : <label className={classes} title={title}>{input}{track}</label>;
}
