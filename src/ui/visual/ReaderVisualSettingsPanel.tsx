import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  resetVisualFilterPreferences,
  type ReaderVisualPreferences,
} from "../../render/visual/readerVisualPreferences";
import { RotateCcwIcon } from "../readerIcons";
import "./readerVisualSettingsPanel.css";

export function isVisualCompareKey(key: string): boolean {
  return key === " " || key === "Enter";
}

export interface ReaderVisualSettingsPanelProps {
  /** Controlled, already-normalized device-local preferences. */
  value: ReaderVisualPreferences;
  onChange(next: ReaderVisualPreferences): void;
  /** Temporary compare mode; the parent applies it to the paint handle without saving. */
  compareOriginal?: boolean;
  onCompareOriginalChange?(next: boolean): void;
  /** FX-2-owned panel content; FX-1 deliberately does not implement color-assist logic. */
  colorAssistSlot?: ReactNode;
}

interface VisualSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onValueChange(value: number): void;
}

function VisualSlider(props: VisualSliderProps) {
  const percent = Math.round(props.value * 100);
  return (
    <label className="reader-visual-slider">
      <span className="reader-visual-slider__label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={percent}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onValueChange(Number(event.currentTarget.value) / 100)}
      />
      <output>{percent}{props.suffix}</output>
    </label>
  );
}

export function ReaderVisualSettingsPanel(props: ReaderVisualSettingsPanelProps) {
  const [internalCompareOriginal, setInternalCompareOriginal] = useState(false);
  const compareOriginal = props.compareOriginal ?? internalCompareOriginal;
  const setCompareOriginal = (next: boolean): void => {
    props.onCompareOriginalChange?.(next);
    if (props.compareOriginal === undefined) setInternalCompareOriginal(next);
  };
  const setCompareOriginalRef = useRef(setCompareOriginal);
  setCompareOriginalRef.current = setCompareOriginal;
  useEffect(() => {
    return () => {
      setCompareOriginalRef.current(false);
    };
  }, []);
  const isCompareKey = (event: KeyboardEvent<HTMLButtonElement>): boolean =>
    isVisualCompareKey(event.key);
  const commit = (patch: Partial<ReaderVisualPreferences>): void => {
    props.onChange({ ...props.value, ...patch });
  };
  const beginCompare = (event: PointerEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>): void => {
    if ("repeat" in event && event.repeat) return;
    if (!("pointerType" in event) && !isCompareKey(event)) return;
    event.preventDefault();
    setCompareOriginal(true);
  };
  const endCompare = (): void => setCompareOriginal(false);

  return (
    <section className="reader-visual-panel" role="region" aria-label="画面滤镜">
      <div className="reader-visual-panel__header">
        <div>
          <h3>画面滤镜</h3>
          <p>只作用于阅读画面，不重排章节；设置保存在本机。</p>
        </div>
        <label className="reader-visual-switch">
          <input
            type="checkbox"
            checked={props.value.enabled}
            onChange={(event) => commit({ enabled: event.currentTarget.checked })}
          />
          <span>总开关</span>
        </label>
      </div>

      <div className={`reader-visual-controls${props.value.enabled ? "" : " is-disabled"}`} aria-disabled={!props.value.enabled}>
        <label className="reader-visual-toggle">
          <input
            type="checkbox"
            checked={props.value.invert}
            onChange={(event) => commit({ invert: event.currentTarget.checked })}
          />
          <span>反色/反相</span>
        </label>
        <VisualSlider
          label="黑白化（灰度）"
          value={props.value.grayscale}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onValueChange={(grayscale) => commit({ grayscale })}
        />
        <VisualSlider
          label="饱和度"
          value={props.value.saturation}
          min={0}
          max={200}
          step={1}
          suffix="%"
          onValueChange={(saturation) => commit({ saturation })}
        />
        <VisualSlider
          label="锐化"
          value={props.value.sharpen}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onValueChange={(sharpen) => commit({ sharpen })}
        />
        <VisualSlider
          label="暗化黑色覆盖层"
          value={props.value.dim}
          min={0}
          max={80}
          step={1}
          suffix="%"
          onValueChange={(dim) => commit({ dim })}
        />
      </div>

      <div className="reader-visual-actions">
        <button
          type="button"
          className="reader-visual-action"
          onClick={() => props.onChange(resetVisualFilterPreferences(props.value))}
        >
          <RotateCcwIcon size={13} />
          恢复默认
        </button>
        <button
          type="button"
          className={`reader-visual-action reader-visual-action--compare${compareOriginal ? " is-active" : ""}`}
          aria-pressed={compareOriginal}
          title="按住临时查看原画面，松开恢复滤镜"
          onPointerDown={beginCompare}
          onPointerUp={endCompare}
          onPointerCancel={endCompare}
          onPointerLeave={endCompare}
          onKeyDown={beginCompare}
          onKeyUp={endCompare}
          onBlur={endCompare}
        >
          临时查看原画面
        </button>
      </div>

      <div className="reader-visual-color-assist-slot" data-visual-slot="color-assist">
        {props.colorAssistSlot}
      </div>
    </section>
  );
}
