import { useEffect, useMemo } from "react";
import { useUiText, type Translate } from "./localization/UiLanguageProvider";
import { TAP_REGION_LABEL_KEYS } from "./localization/catalogs/tapRegions";
import { ReaderTapRegionsPanel, type ReaderTapRegionsLabels } from "./ReaderTapRegionsPanel";
import type { ReaderTapPreferences, TapRegionDevice } from "./readerTapRegions";
import "./readerTapRegions.css";

export interface TapRegionsSettingsPanelProps {
  open: boolean;
  /** Profile edited here: the device class the app is running as. */
  device: TapRegionDevice;
  value: ReaderTapPreferences;
  onChange(next: ReaderTapPreferences): void;
  onClose(): void;
}

/**
 * Shelf-settings host of the tap-region editor: a dialog on desktop, a
 * full-screen page on touch devices. No book is open here, so the preview
 * is a sample page at the window's proportions.
 */
export function TapRegionsSettingsPanel(props: TapRegionsSettingsPanelProps) {
  const { t } = useUiText();
  const labels = useMemo(() => Object.fromEntries(Object.entries(TAP_REGION_LABEL_KEYS)
    .map(([field, key]) => [field, t(key)])) as unknown as ReaderTapRegionsLabels, [t]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;
  const touch = props.device === "touch";
  const title = t("tapRegions.title");
  return <div className="tap-settings-layer" data-tap-device={props.device} role="presentation">
    {!touch && <div className="tap-settings-backdrop" aria-hidden="true" onClick={props.onClose} />}
    <section className="tap-settings-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="tap-settings-head">
        {touch && <button type="button" className="tap-settings-icon-btn" onClick={props.onClose} aria-label={t("tapRegions.back")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
        </button>}
        <h2 className="tap-settings-title">{title}</h2>
        {!touch && <button type="button" className="tap-settings-icon-btn" onClick={props.onClose} aria-label={t("tapRegions.close")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>}
      </header>
      <div className="tap-settings-body">
        <ReaderTapRegionsPanel
          device={props.device}
          value={props.value}
          onChange={props.onChange}
          availableWidth={window.innerWidth}
          availableHeight={window.innerHeight}
          schematic
          labels={labels}
        />
      </div>
    </section>
  </div>;
}

/** One-line summary for the settings row that opens the panel. */
export function tapRegionsSummary(
  value: ReaderTapPreferences,
  device: TapRegionDevice,
  t: Translate,
): string {
  const profile = device === "touch" ? value.touch : value.pc;
  const size = profile.mode === "custom" && profile.custom
    ? t("tapRegions.entry.custom", { left: profile.custom.left, right: profile.custom.right })
    : t("tapRegions.entry.default");
  return device === "touch" && value.touchLeftTapForward ? `${size} · ${t("tapRegions.entry.leftForward")}` : size;
}
