import { useMemo, type ReactNode } from "react";
import { useExitPresence } from "./menuMotion";
import { useUiText } from "./localization/UiLanguageProvider";
import { TAP_REGION_LABEL_KEYS } from "./localization/catalogs/tapRegions";
import { ReaderTapRegionsPanel, type ReaderTapRegionsLabels } from "./ReaderTapRegionsPanel";
import type { ReaderTapPreferences } from "./readerTapRegions";
import type { ReaderTapRegionSettings } from "./readerTapRouting";
import "./readerTapRegions.css";
import "./shelfSettings.css";
import { Switch } from "./controls/Switch";
import { SettingsSwitchRow } from "./settingsRows";

/** Reading preferences shared by Settings › Reading on the shelf and the in-reader layer. */
export interface ReadingSettingsProps {
  tapRegions?: ReaderTapRegionSettings;
  onTapRegionsChange?(next: ReaderTapPreferences): void;
  tapRegionsScrollMode?: boolean;
  /** Each switch below appears only when its value is defined (runtime support). */
  keepScreenOnWhileReading?: boolean;
  onKeepScreenOnWhileReadingChange?(enabled: boolean): void;
  hideReaderSystemStatusBar?: boolean;
  onHideReaderSystemStatusBarChange?(hidden: boolean): void;
  batteryIndicatorEnabled?: boolean;
  onBatteryIndicatorChange?(enabled: boolean): void;
  /** Desktop only: the reader's top bar hides until the pointer reaches it. */
  titlebarAutoHide?: boolean;
  onTitlebarAutoHideChange?(enabled: boolean): void;
  /** High-performance preloading (formerly in Aa › More). */
  preloadNextChapter?: boolean;
  /** The open book cannot preload (fixed layout); only the in-reader layer knows. */
  preloadNextChapterDisabled?: boolean;
  onPreloadNextChapterChange?(enabled: boolean): void;
  /** Seamless chapter turn; only with preloading on. */
  seamlessChapterTurn?: boolean;
  onSeamlessChapterTurnChange?(enabled: boolean): void;
}

export function SettingsSwitch(props: { label: string; checked: boolean; onChange(checked: boolean): void }) {
  return <label className="shelf-settings-switch">
    <span className="shelf-settings-switch-label">{props.label}</span>
    <Switch inRow checked={props.checked} onChange={props.onChange} />
  </label>;
}

/** Titles of the reading items present on this runtime, in display order (for a section's summary line). */
export function useReadingSettingsTitles(props: ReadingSettingsProps): string[] {
  const { t } = useUiText();
  const titles: string[] = [];
  if (props.tapRegions && props.onTapRegionsChange) titles.push(t("tapRegions.title"));
  if (props.preloadNextChapter !== undefined && props.onPreloadNextChapterChange) titles.push(t("aa.preload"));
  if (props.keepScreenOnWhileReading !== undefined && props.onKeepScreenOnWhileReadingChange) titles.push(t("shelfMenu.keepScreenOn"));
  if (props.hideReaderSystemStatusBar !== undefined && props.onHideReaderSystemStatusBarChange) titles.push(t("shelfMenu.statusBar"));
  if (props.batteryIndicatorEnabled !== undefined && props.onBatteryIndicatorChange) titles.push(t("shelfMenu.battery"));
  if (props.titlebarAutoHide !== undefined && props.onTitlebarAutoHideChange) titles.push(t("shelfMenu.titlebarAutoHide"));
  return titles;
}

export function ReadingSettingsContent(props: ReadingSettingsProps) {
  const { t } = useUiText();
  const tapLabels = useMemo(() => Object.fromEntries(Object.entries(TAP_REGION_LABEL_KEYS)
    .map(([field, key]) => [field, t(key)])) as unknown as ReaderTapRegionsLabels, [t]);
  const switches: ReactNode[] = [];
  if (props.titlebarAutoHide !== undefined && props.onTitlebarAutoHideChange) {
    switches.push(<SettingsSwitchRow key="titlebar" title={t("shelfMenu.titlebarAutoHide.tip")} checked={props.titlebarAutoHide} onChange={props.onTitlebarAutoHideChange} />);
  }
  if (props.preloadNextChapter !== undefined && props.onPreloadNextChapterChange) {
    const preloadOn = props.preloadNextChapter && !props.preloadNextChapterDisabled;
    switches.push(<SettingsSwitchRow key="preload" title={t("aa.preload")} detail={t("aa.preload.warning")}
      checked={props.preloadNextChapter} disabled={props.preloadNextChapterDisabled} onChange={props.onPreloadNextChapterChange} />);
    if (props.seamlessChapterTurn !== undefined && props.onSeamlessChapterTurnChange) {
      // 连续滑动依附高性能预读：预读关闭（或固定版式不可用）时这个开关也关着、不可点。
      switches.push(<SettingsSwitchRow key="seamless" title={t("aa.seamlessTurn")} detail={t("aa.seamlessTurn.hint")}
        checked={props.seamlessChapterTurn && preloadOn} disabled={!preloadOn} onChange={props.onSeamlessChapterTurnChange} />);
    }
  }
  if (props.keepScreenOnWhileReading !== undefined && props.onKeepScreenOnWhileReadingChange) {
    switches.push(<SettingsSwitchRow key="screen" title={t("shelfMenu.keepScreenOn")} checked={props.keepScreenOnWhileReading} onChange={props.onKeepScreenOnWhileReadingChange} />);
  }
  if (props.hideReaderSystemStatusBar !== undefined && props.onHideReaderSystemStatusBarChange) {
    switches.push(<SettingsSwitchRow key="status" title={t("shelfMenu.statusBar.tip")} checked={props.hideReaderSystemStatusBar} onChange={props.onHideReaderSystemStatusBarChange} />);
  }
  if (props.batteryIndicatorEnabled !== undefined && props.onBatteryIndicatorChange) {
    switches.push(<SettingsSwitchRow key="battery" title={t("shelfMenu.battery.tip")} checked={props.batteryIndicatorEnabled} onChange={props.onBatteryIndicatorChange} />);
  }
  return <>
    {props.tapRegions && props.onTapRegionsChange && <div className="shelf-settings-card">
      <div className="shelf-settings-card-title">{t("tapRegions.title")}</div>
      <ReaderTapRegionsPanel device={props.tapRegions.device} value={props.tapRegions.preferences}
        onChange={props.onTapRegionsChange} availableWidth={window.innerWidth} availableHeight={window.innerHeight}
        scrollMode={props.tapRegionsScrollMode} schematic labels={tapLabels}
        progression={props.tapRegions.progression} />
    </div>}
    {switches.length > 0 && <div className="shelf-settings-card is-list">{switches}</div>}
  </>;
}

export interface ReaderReadingSettingsProps extends ReadingSettingsProps {
  open: boolean;
  /** "dialog" on desktop, "page" (full screen) on touch — same split as the shelf settings. */
  presentation: "dialog" | "page";
  onClose(): void;
}

/**
 * Reading settings opened inside the reader (from the phone "More" sheet).
 * The book stays open underneath; Back/Esc are routed by App's reader
 * foreground, so this layer only renders and closes itself.
 */
export function ReaderReadingSettings(props: ReaderReadingSettingsProps) {
  const { t } = useUiText();
  const { present, closing } = useExitPresence(props.open);
  if (!present) return null;
  const dialog = props.presentation === "dialog";
  const title = t("appUi.reading.title");
  const body = <div className="shelf-settings-scroll"><ReadingSettingsContent {...props} /></div>;
  return <div className={`shelf-settings-layer is-reader is-${props.presentation}${closing ? " is-closing" : ""}`}>
    {dialog && <div className="shelf-settings-backdrop" aria-hidden="true" onClick={props.onClose} />}
    {dialog
      ? <section className="shelf-settings-window is-single" role="dialog" aria-modal="true" aria-label={title}>
        <section className="shelf-settings-main">
          <header className="shelf-settings-head">
            <h2>{title}</h2>
            <button type="button" className="shelf-settings-icon-btn" onClick={props.onClose} aria-label={t("appUi.reading.close")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </header>
          {body}
        </section>
      </section>
      : <section className="shelf-settings-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header className="shelf-settings-head">
          <button type="button" className="shelf-settings-icon-btn is-back" onClick={props.onClose} aria-label={t("appUi.reading.back")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
          </button>
          <h2>{title}</h2>
        </header>
        {body}
      </section>}
  </div>;
}
