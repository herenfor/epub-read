import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
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
  const fill = ((percent - props.min) / (props.max - props.min)) * 100;
  return (
    <label className="rd-range-row">
      <span className="aa-section-label">{props.label}</span>
      <input
        type="range"
        className="rd-range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={percent}
        style={{ "--fill": `${Math.min(100, Math.max(0, fill))}%` } as CSSProperties}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onValueChange(Number(event.currentTarget.value) / 100)}
      />
      <output className="rd-range-value">{percent}{props.suffix}</output>
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
    <>
      <section className="rd-section reader-visual-panel" role="region" aria-label="画面滤镜">
        <div className="aa-group-title">画面滤镜</div>
        <div className="aa-control-row">
          <div className="aa-detail-label-wrap">
            <span className="aa-section-label">启用滤镜</span>
            <span className="aa-detail-sub">总开关，同时控制色弱辅助；不重排章节</span>
          </div>
          <label className="aa-switch-label">
            <input
              type="checkbox"
              checked={props.value.enabled}
              aria-label="启用画面滤镜"
              onChange={(event) => commit({ enabled: event.currentTarget.checked })}
            />
            <span className="aa-switch-track" />
          </label>
        </div>

        <div className={`rd-controls${props.value.enabled ? "" : " rd-disabled"}`} aria-disabled={!props.value.enabled}>
          <div className="aa-control-row">
            <span className="aa-section-label">反色</span>
            <label className="aa-switch-label">
              <input
                type="checkbox"
                checked={props.value.invert}
                aria-label="反色/反相"
                onChange={(event) => commit({ invert: event.currentTarget.checked })}
              />
              <span className="aa-switch-track" />
            </label>
          </div>
          <VisualSlider
            label="灰度"
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
            label="暗化"
            value={props.value.dim}
            min={0}
            max={80}
            step={1}
            suffix="%"
            onValueChange={(dim) => commit({ dim })}
          />
        </div>

        <div className="rd-actions">
          <button
            type="button"
            className="aa-mini-action-btn"
            onClick={() => props.onChange(resetVisualFilterPreferences(props.value))}
          >
            <RotateCcwIcon size={12} />
            恢复默认
          </button>
          <button
            type="button"
            className={`aa-mini-action-btn reader-visual-compare${compareOriginal ? " is-active" : ""}`}
            aria-pressed={compareOriginal}
            title="按住临时查看原画面，松开恢复滤镜"
            onPointerDown={beginCompare}
            onPointerUp={endCompare}
            onPointerCancel={endCompare}
            onPointerLeave={endCompare}
            onKeyDown={beginCompare}
            onKeyUp={endCompare}
            onBlur={endCompare}
            onContextMenu={(event) => event.preventDefault()}
          >
            按住查看原画面
          </button>
        </div>
      </section>
      <div className={`reader-visual-color-assist-slot${props.value.enabled ? "" : " is-disabled"}`} data-visual-slot="color-assist">
        {props.colorAssistSlot}
      </div>
    </>
  );
}
