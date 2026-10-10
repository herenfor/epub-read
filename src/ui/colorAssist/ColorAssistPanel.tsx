import type { CSSProperties } from "react";
import { correctionMatrix, previewColor, type AssistKind } from "../../render/colorAssist/colorAssistCore";
import "./colorAssistPanel.css";
import { useUiText } from "../localization/UiLanguageProvider";
import type { PlainMessageKey } from "../localization/core";

export interface ColorAssistValue {
  kind: AssistKind;
  strength: number;
}

export interface ColorAssistPanelProps {
  value: ColorAssistValue;
  onChange(next: ColorAssistValue): void;
}

interface ColorAssistOption {
  kind: AssistKind;
  label: PlainMessageKey;
  /** Translated subtitle, or a fixed technical name (Protan/Deutan/Tritan). */
  detail: { key: PlainMessageKey } | { text: string };
}

export interface ColorAssistSwatch {
  label: PlainMessageKey;
  rgba: readonly [number, number, number, number];
}

export const COLOR_ASSIST_OPTIONS: readonly ColorAssistOption[] = [
  { kind: "off", label: "display.assist.off", detail: { key: "display.assist.off.detail" } },
  { kind: "protan", label: "display.assist.protan", detail: { text: "Protan" } },
  { kind: "deutan", label: "display.assist.deutan", detail: { text: "Deutan" } },
  { kind: "tritan", label: "display.assist.tritan", detail: { text: "Tritan" } },
];

/** Small preview palette only; it never becomes a full-page CPU filter. */
export const COLOR_ASSIST_PREVIEW_SWATCHES: readonly ColorAssistSwatch[] = [
  { label: "display.assist.swatch.red", rgba: [0.84, 0.20, 0.18, 1] },
  { label: "display.assist.swatch.yellow", rgba: [0.93, 0.76, 0.16, 1] },
  { label: "display.assist.swatch.green", rgba: [0.22, 0.70, 0.32, 1] },
  { label: "display.assist.swatch.cyan", rgba: [0.16, 0.68, 0.76, 1] },
  { label: "display.assist.swatch.blue", rgba: [0.20, 0.36, 0.88, 1] },
  { label: "display.assist.swatch.magenta", rgba: [0.78, 0.22, 0.68, 1] },
];

export function normalizeColorAssistStrength(strength: number): number {
  if (!Number.isFinite(strength)) return 0;
  return Math.min(1, Math.max(0, strength));
}

/** Controlled value transition. The panel keeps no persistent preference of its own. */
export function selectColorAssistKind(value: ColorAssistValue, kind: AssistKind): ColorAssistValue {
  if (kind === value.kind) return value;
  const strength = normalizeColorAssistStrength(value.strength);
  if (kind === "off") return { kind, strength };
  // The default-off preference opens at 0.5; if a caller stored zero, keep a useful initial amount.
  return { kind, strength: value.kind === "off" && strength === 0 ? 0.5 : strength };
}

function rgbaToCss(rgba: readonly [number, number, number, number]): string {
  const [red, green, blue, alpha] = rgba;
  return `rgba(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)}, ${alpha})`;
}

export function ColorAssistPanel({ value, onChange }: ColorAssistPanelProps) {
  const { t } = useUiText();
  const activeKind = value.kind;
  const strength = normalizeColorAssistStrength(value.strength);
  const strengthPercent = Math.round(strength * 100);
  const matrix = correctionMatrix(activeKind, strength);
  const activeLabel = t(COLOR_ASSIST_OPTIONS.find((option) => option.kind === activeKind)?.label ?? "display.assist.off");

  const chooseKind = (kind: AssistKind) => {
    const next = selectColorAssistKind(value, kind);
    if (next.kind !== value.kind || next.strength !== value.strength) onChange(next);
  };

  return (
    <section className="rd-section color-assist-panel" aria-label={t("display.assist.section")}>
      <div className="aa-group-title">{t("display.assist.title")}</div>
      <p className="rd-note">{t("display.assist.note")}</p>
      <div className="color-assist-options" role="group" aria-label={t("display.assist.kind")}>
        {COLOR_ASSIST_OPTIONS.map((option) => {
          const selected = option.kind === activeKind;
          return (
            <button
              key={option.kind}
              type="button"
              className={`color-assist-option${selected ? " is-active" : ""}`}
              aria-pressed={selected}
              onClick={() => chooseKind(option.kind)}
            >
              <span className="color-assist-option-label">{t(option.label)}</span>
              <span className="color-assist-option-detail">{"key" in option.detail ? t(option.detail.key) : option.detail.text}</span>
            </button>
          );
        })}
      </div>
      <label className="rd-range-row">
        <span className="aa-section-label">{t("display.assist.strength")}</span>
        <input
          type="range"
          className="rd-range"
          min="0"
          max="100"
          step="1"
          value={strengthPercent}
          disabled={activeKind === "off"}
          aria-label={t("display.assist.strength.label")}
          style={{ "--fill": `${activeKind === "off" ? 0 : strengthPercent}%` } as CSSProperties}
          onChange={(event) => onChange({ kind: activeKind, strength: normalizeColorAssistStrength(Number(event.target.value) / 100) })}
        />
        <output className="rd-range-value">{activeKind === "off" ? "—" : `${strengthPercent}%`}</output>
      </label>
      <div className="color-assist-preview" aria-label={t("display.assist.preview", { mode: activeLabel })}>
        <span className="color-assist-preview-label">{t("display.assist.original")}</span>
        <div className="color-assist-swatch-row">
          {COLOR_ASSIST_PREVIEW_SWATCHES.map((swatch) => (
            <span
              key={`original-${swatch.label}`}
              className="color-assist-swatch"
              style={{ backgroundColor: rgbaToCss(swatch.rgba) }}
              title={t("display.assist.swatchOriginal", { color: t(swatch.label) })}
            />
          ))}
        </div>
        <span className="color-assist-preview-label">{t("display.assist.after")}</span>
        <div className="color-assist-swatch-row">
          {COLOR_ASSIST_PREVIEW_SWATCHES.map((swatch) => {
            const assisted = previewColor(matrix, swatch.rgba);
            return (
              <span
                key={`assisted-${swatch.label}`}
                className="color-assist-swatch"
                style={{ backgroundColor: rgbaToCss(assisted) }}
                title={t("display.assist.swatchAfter", { color: t(swatch.label), mode: activeLabel })}
              />
            );
          })}
        </div>
      </div>
      <p className="rd-note">{t("display.assist.grayscaleNote")}</p>
    </section>
  );
}
