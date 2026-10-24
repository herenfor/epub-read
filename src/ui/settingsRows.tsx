import type { ReactNode } from "react";
import { useUiText } from "./localization/UiLanguageProvider";

/* Shared rows of the shelf settings page: icon tile, title, one muted line, trailing mark. */

export function Icon({ children }: { children: ReactNode }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

/** The red dot; `label` names what it flags (a new version by default). */
export function UpdateDot({ label }: { label?: string }) {
  const { t } = useUiText();
  return <span className="app-update-dot is-inline" role="img" aria-label={label ?? t("about.update.dot")} />;
}

export const CHEVRON = <svg className="shelf-settings-row-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;

export function SettingsRow(props: {
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  /** A red dot; a string is its accessible label. */
  dot?: boolean | string;
  disabled?: boolean;
  /** Replaces the chevron (an external-link mark, a disclosure arrow). */
  trailing?: ReactNode;
  expanded?: boolean;
  /** A shortcut beside the row (its own button, so it sits outside the row button). */
  action?: ReactNode;
  onClick(): void;
}) {
  const row = <button type="button" className="shelf-settings-row" disabled={props.disabled} aria-expanded={props.expanded}
    onClick={(event) => { event.currentTarget.blur(); props.onClick(); }}>
    <span className="shelf-settings-row-icon">{props.icon}</span>
    <span className="shelf-settings-row-text">
      <strong>{props.title}{props.dot && <UpdateDot label={typeof props.dot === "string" ? props.dot : undefined} />}</strong>
      {props.detail && <small>{props.detail}</small>}
    </span>
    {props.trailing ?? CHEVRON}
  </button>;
  if (!props.action) return row;
  return <div className="shelf-settings-row-wrap">{row}{props.action}</div>;
}

/** A row whose trailing control is a switch; the whole row toggles it. */
export function SettingsSwitchRow(props: { icon: ReactNode; title: string; detail?: string; checked: boolean; onChange(checked: boolean): void }) {
  return <label className="shelf-settings-row is-switch">
    <span className="shelf-settings-row-icon">{props.icon}</span>
    <span className="shelf-settings-row-text">
      <strong>{props.title}</strong>
      {props.detail && <small>{props.detail}</small>}
    </span>
    <input type="checkbox" role="switch" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
    <span className="shelf-settings-switch-track" aria-hidden="true" />
  </label>;
}
