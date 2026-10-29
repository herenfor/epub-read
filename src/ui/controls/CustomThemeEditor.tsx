import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  CUSTOM_THEME_PRESETS,
  CUSTOM_THEME_SWATCHES,
  contrastRatio,
  normalizeHexColor,
  type CustomTheme,
  type CustomThemeColors,
} from "../../config/customThemes";
import type { PlainMessageKey } from "../localization/core";
import { useUiText } from "../localization/UiLanguageProvider";
import type { CustomThemeControls } from "../useCustomThemes";
import "./customThemeEditor.css";

const ROLES: ReadonlyArray<{ key: keyof CustomThemeColors; labelKey: PlainMessageKey }> = [
  { key: "background", labelKey: "aa.customTheme.background" },
  { key: "foreground", labelKey: "aa.customTheme.foreground" },
  { key: "accent", labelKey: "aa.customTheme.accent" },
];

/** One color role: current value with its hex field, the swatches, and the system picker. */
function ColorRow(props: { label: string; value: string; swatches: readonly string[]; onChange(value: string): void }) {
  const { t } = useUiText();
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  return <div className="cte-color-row">
    <div className="cte-color-head">
      <span className="cte-color-label">{props.label}</span>
      <span className="cte-color-chip" style={{ background: props.value }} aria-hidden="true" />
      <input className="cte-hex" value={draft.toUpperCase()} spellCheck={false} maxLength={7}
        aria-label={t("aa.customTheme.hex", { label: props.label })}
        onChange={(event) => {
          setDraft(event.target.value);
          const hex = normalizeHexColor(event.target.value);
          if (hex && event.target.value.replace("#", "").length === 6) props.onChange(hex);
        }}
        onBlur={() => setDraft(props.value)} />
    </div>
    <div className="cte-swatches">
      {props.swatches.map((hex) => (
        <button key={hex} type="button" className={`cte-swatch${hex === props.value ? " active" : ""}`}
          style={{ "--cte-swatch": hex } as CSSProperties} aria-label={hex} aria-pressed={hex === props.value}
          onClick={() => props.onChange(hex)} />
      ))}
      <label className="cte-swatch is-picker" title={t("aa.customTheme.picker")}>
        <input type="color" value={props.value} aria-label={`${props.label} · ${t("aa.customTheme.picker")}`}
          onChange={(event) => { const hex = normalizeHexColor(event.target.value); if (hex) props.onChange(hex); }} />
      </label>
    </div>
  </div>;
}

/**
 * Editor of one custom theme. Every change applies at once (the theme being
 * edited is the one on screen), so the book behind is the preview.
 */
export function CustomThemeEditor(props: {
  theme: CustomTheme;
  /** Position in the list, for the default name. */
  index: number;
  controls: CustomThemeControls;
  onDone(): void;
  /** The sub-page head (Aa); Settings edits in place without one. */
  head?: ReactNode;
}) {
  const { t } = useUiText();
  const { theme, controls } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const colors: CustomThemeColors = { background: theme.background, foreground: theme.foreground, accent: theme.accent };
  const setColor = (key: keyof CustomThemeColors, value: string) => {
    if (colors[key] !== value) controls.setColors(theme.id, { ...colors, [key]: value });
  };
  const ratio = contrastRatio(theme.foreground, theme.background);
  const ratioNote = ratio >= 7 ? t("aa.customTheme.contrast.high") : ratio >= 4.5 ? t("aa.customTheme.contrast.ok") : t("aa.customTheme.contrast.low");

  return <div className="cte">
    {props.head}
    <label className="cte-field">
      <span className="cte-field-label">{t("aa.customTheme.name")}</span>
      <input className="cte-name" value={theme.name} placeholder={t("aa.customTheme.defaultName", { n: props.index + 1 })}
        onChange={(event) => controls.rename(theme.id, event.target.value)}
        onBlur={(event) => { if (event.target.value !== event.target.value.trim()) controls.rename(theme.id, event.target.value.trim()); }} />
    </label>

    <div className="cte-field">
      <span className="cte-field-label">{t("aa.customTheme.presets")}</span>
      <div className="cte-presets">
        {CUSTOM_THEME_PRESETS.map((preset) => {
          const active = preset.background === theme.background && preset.foreground === theme.foreground && preset.accent === theme.accent;
          return <button key={preset.id} type="button" className={`cte-preset${active ? " active" : ""}`} aria-pressed={active}
            style={{ "--cte-paper": preset.background, "--cte-ink": preset.foreground } as CSSProperties}
            onClick={() => controls.setColors(theme.id, { background: preset.background, foreground: preset.foreground, accent: preset.accent })}>
            <span className="cte-preset-dot" aria-hidden="true" />
            {t(preset.nameKey as PlainMessageKey)}
          </button>;
        })}
      </div>
    </div>

    <div className="cte-card">
      {ROLES.map((role) => (
        <ColorRow key={role.key} label={t(role.labelKey)} value={colors[role.key]} swatches={CUSTOM_THEME_SWATCHES[role.key]} onChange={(value) => setColor(role.key, value)} />
      ))}
    </div>

    <div className={`cte-contrast${ratio < 4.5 ? " is-low" : ""}`} role="status">
      <strong>{t("aa.customTheme.contrast", { ratio: ratio.toFixed(1) })}</strong>
      <span>{ratioNote}</span>
    </div>

    <div className="cte-actions">
      <button type="button" className="ui-text-btn cte-delete" onClick={() => {
        if (confirmDelete) controls.remove(theme.id);
        else setConfirmDelete(true);
      }}>{confirmDelete ? t("aa.customTheme.delete.confirm") : t("aa.customTheme.delete")}</button>
      <button type="button" className="ui-btn is-primary" onClick={props.onDone}>{t("aa.customTheme.done")}</button>
    </div>
  </div>;
}
