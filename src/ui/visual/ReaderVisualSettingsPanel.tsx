import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  resetVisualFilterPreferences,
  type ReaderVisualPreferences,
} from "../../render/visual/readerVisualPreferences";
import { RotateCcwIcon } from "../readerIcons";
import "./readerVisualSettingsPanel.css";
import { TouchSlider } from "../TouchSlider";
import { Switch } from "../controls/Switch";
import { useUiText } from "../localization/UiLanguageProvider";

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
    <div className="rd-range-row">
      <span className="aa-section-label">{props.label}</span>
      <TouchSlider
        className="rd-range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={percent}
        label={props.label}
        valueText={`${percent}${props.suffix}`}
        onChange={(value) => props.onValueChange(value / 100)}
      />
      <output className="rd-range-value">{percent}{props.suffix}</output>
    </div>
  );
}

export function ReaderVisualSettingsPanel(props: ReaderVisualSettingsPanelProps) {
  const { t } = useUiText();
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
      <section className="rd-section reader-visual-panel" role="region" aria-label={t("display.visual.section")}>
        <div className="aa-group-title">{t("display.visual.title")}</div>
        <div className="aa-control-row">
          <div className="aa-detail-label-wrap">
            <span className="aa-section-label">{t("display.visual.enable")}</span>
            <span className="aa-detail-sub">{t("display.visual.enable.note")}</span>
          </div>
          <Switch checked={props.value.enabled} label={t("display.visual.enable.label")}
            onChange={(checked) => commit({ enabled: checked })} />
        </div>

        <div className={`rd-controls${props.value.enabled ? "" : " rd-disabled"}`} aria-disabled={!props.value.enabled}>
          <div className="aa-control-row">
            <span className="aa-section-label">{t("display.visual.invert")}</span>
            <Switch checked={props.value.invert} label={t("display.visual.invert.label")}
              onChange={(checked) => commit({ invert: checked })} />
          </div>
          <VisualSlider
            label={t("display.visual.grayscale")}
            value={props.value.grayscale}
            min={0}
            max={100}
            step={1}
            suffix="%"
            onValueChange={(grayscale) => commit({ grayscale })}
          />
          <VisualSlider
            label={t("display.visual.saturation")}
            value={props.value.saturation}
            min={0}
            max={200}
            step={1}
            suffix="%"
            onValueChange={(saturation) => commit({ saturation })}
          />
          <VisualSlider
            label={t("display.visual.sharpen")}
            value={props.value.sharpen}
            min={0}
            max={100}
            step={1}
            suffix="%"
            onValueChange={(sharpen) => commit({ sharpen })}
          />
          <VisualSlider
            label={t("display.visual.dim")}
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
            className="ui-btn"
            onClick={() => props.onChange(resetVisualFilterPreferences(props.value))}
          >
            <RotateCcwIcon size={12} />
            {t("display.visual.reset")}
          </button>
          <button
            type="button"
            className={`ui-btn reader-visual-compare${compareOriginal ? " is-active" : ""}`}
            aria-pressed={compareOriginal}
            title={t("display.visual.compare.tip")}
            onPointerDown={beginCompare}
            onPointerUp={endCompare}
            onPointerCancel={endCompare}
            onPointerLeave={endCompare}
            onKeyDown={beginCompare}
            onKeyUp={endCompare}
            onBlur={endCompare}
            onContextMenu={(event) => event.preventDefault()}
          >
            {t("display.visual.compare")}
          </button>
        </div>
      </section>
      <div className={`reader-visual-color-assist-slot${props.value.enabled ? "" : " is-disabled"}`} data-visual-slot="color-assist">
        {props.colorAssistSlot}
      </div>
    </>
  );
}
