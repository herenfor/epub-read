import type { CSSProperties } from "react";
import { correctionMatrix, previewColor, type AssistKind } from "../../render/colorAssist/colorAssistCore";
import "./colorAssistPanel.css";

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
  label: string;
  detail: string;
}

export interface ColorAssistSwatch {
  label: string;
  rgba: readonly [number, number, number, number];
}

export const COLOR_ASSIST_OPTIONS: readonly ColorAssistOption[] = [
  { kind: "off", label: "关闭", detail: "不改变画面" },
  { kind: "protan", label: "红色弱／红色盲辅助", detail: "Protan" },
  { kind: "deutan", label: "绿色弱／绿色盲辅助", detail: "Deutan" },
  { kind: "tritan", label: "蓝色弱／蓝色盲辅助", detail: "Tritan" },
];

/** Small preview palette only; it never becomes a full-page CPU filter. */
export const COLOR_ASSIST_PREVIEW_SWATCHES: readonly ColorAssistSwatch[] = [
  { label: "红", rgba: [0.84, 0.20, 0.18, 1] },
  { label: "黄", rgba: [0.93, 0.76, 0.16, 1] },
  { label: "绿", rgba: [0.22, 0.70, 0.32, 1] },
  { label: "青", rgba: [0.16, 0.68, 0.76, 1] },
  { label: "蓝", rgba: [0.20, 0.36, 0.88, 1] },
  { label: "洋红", rgba: [0.78, 0.22, 0.68, 1] },
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
  const activeKind = value.kind;
  const strength = normalizeColorAssistStrength(value.strength);
  const strengthPercent = Math.round(strength * 100);
  const matrix = correctionMatrix(activeKind, strength);
  const activeLabel = COLOR_ASSIST_OPTIONS.find((option) => option.kind === activeKind)?.label ?? "关闭";

  const chooseKind = (kind: AssistKind) => {
    const next = selectColorAssistKind(value, kind);
    if (next.kind !== value.kind || next.strength !== value.strength) onChange(next);
  };

  return (
    <section className="rd-section color-assist-panel" aria-label="色弱辅助">
      <div className="aa-group-title">色弱辅助</div>
      <p className="rd-note">把易混的色差移到更好分辨的颜色方向；只改变显示，不宣称修复视力。</p>
      <div className="color-assist-options" role="group" aria-label="辅助类型">
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
              <span className="color-assist-option-label">{option.label}</span>
              <span className="color-assist-option-detail">{option.detail}</span>
            </button>
          );
        })}
      </div>
      <label className="rd-range-row">
        <span className="aa-section-label">强度</span>
        <input
          type="range"
          className="rd-range"
          min="0"
          max="100"
          step="1"
          value={strengthPercent}
          disabled={activeKind === "off"}
          aria-label="色弱辅助强度"
          style={{ "--fill": `${activeKind === "off" ? 0 : strengthPercent}%` } as CSSProperties}
          onChange={(event) => onChange({ kind: activeKind, strength: normalizeColorAssistStrength(Number(event.target.value) / 100) })}
        />
        <output className="rd-range-value">{activeKind === "off" ? "—" : `${strengthPercent}%`}</output>
      </label>
      <div className="color-assist-preview" aria-label={`同屏预览：上排原色，下排${activeLabel}辅助后`}>
        <span className="color-assist-preview-label">原色</span>
        <div className="color-assist-swatch-row">
          {COLOR_ASSIST_PREVIEW_SWATCHES.map((swatch) => (
            <span
              key={`original-${swatch.label}`}
              className="color-assist-swatch"
              style={{ backgroundColor: rgbaToCss(swatch.rgba) }}
              title={`${swatch.label} 原色`}
            />
          ))}
        </div>
        <span className="color-assist-preview-label">辅助后</span>
        <div className="color-assist-swatch-row">
          {COLOR_ASSIST_PREVIEW_SWATCHES.map((swatch) => {
            const assisted = previewColor(matrix, swatch.rgba);
            return (
              <span
                key={`assisted-${swatch.label}`}
                className="color-assist-swatch"
                style={{ backgroundColor: rgbaToCss(assisted) }}
                title={`${swatch.label} ${activeLabel}辅助后`}
              />
            );
          })}
        </div>
      </div>
      <p className="rd-note">同时开启灰度时，色差会被抹去，辅助效果随之减弱。</p>
    </section>
  );
}
