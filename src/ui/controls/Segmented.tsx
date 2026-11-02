import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedProps<T extends string> {
  /** Accessible name of the group (the visible row label, usually). */
  label: string;
  value: T;
  /** The value decides the type; the options and handler follow it. */
  options: ReadonlyArray<SegmentedOption<NoInfer<T>>>;
  onChange(value: NoInfer<T>): void;
  disabled?: boolean;
  /** "fill": stretches across its container; "compact": a toolbar's smaller one. */
  variant?: "fill" | "compact";
  /** Layout class of the place it sits in; the look stays the shared one. */
  className?: string;
}

/**
 * The one segmented control of the app: 2–5 mutually exclusive choices of
 * one setting, all text. A radio group, so the choice reads as selected,
 * not as a pressed button. Styles live in controls.css (.ui-segmented).
 */
export function Segmented<T extends string>({ label, value, options, onChange, disabled, variant, className }: SegmentedProps<T>) {
  const classes = ["ui-segmented", variant ? `is-${variant}` : "", className ?? ""].filter(Boolean).join(" ");
  return <div className={classes} role="radiogroup" aria-label={label}>
    {options.map((option) => {
      const checked = option.value === value;
      return <button key={option.value} type="button" role="radio" aria-checked={checked}
        className={checked ? "active" : undefined} title={option.title}
        disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>
        {option.label}
      </button>;
    })}
  </div>;
}
