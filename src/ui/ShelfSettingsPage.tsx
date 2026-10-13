import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Theme } from "../render/settings";
import { READER_PALETTES } from "../config/readerPalette";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import { AboutInfo } from "./AboutInfo";
import { CacheStoragePanel } from "./CacheStoragePanel";
import { useExitPresence } from "./menuMotion";
import { useUiMotion, type UiMotion } from "./motionPreference";
import { useUiText } from "./localization/UiLanguageProvider";
import { useUiLanguageChoice } from "./localization/useUiLanguageChoice";
import type { UiLanguagePreference } from "./localization/core";
import type { ReaderTapPreferences } from "./readerTapRegions";
import type { ReaderTapRegionSettings } from "./readerTapRouting";
import { ReadingSettingsContent, useReadingSettingsTitles, type ReadingSettingsProps } from "./ReadingSettings";
import { SearchIndexCard } from "./SearchPanel";
import type { ShelfBodySearchProps } from "./ShelfView";
import "./shelfSettings.css";

export type ShelfSettingsSection = "appearance" | "reading" | "data" | "storage" | "about";

export interface ShelfSettingsPageProps {
  open: boolean;
  /** "dialog": desktop window with a section list; "page": touch full-screen page, sections one level down. */
  presentation: "dialog" | "page";
  /** Section to show when opening (e.g. storage from the search box's "manage index"). */
  initialSection?: ShelfSettingsSection;
  busy: boolean;
  bookCount: number;
  theme: Theme;
  onThemeChange(theme: Theme): void;
  batteryIndicatorEnabled?: boolean;
  onBatteryIndicatorChange?(enabled: boolean): void;
  hideReaderSystemStatusBar?: boolean;
  onHideReaderSystemStatusBarChange?(hidden: boolean): void;
  keepScreenOnWhileReading?: boolean;
  onKeepScreenOnWhileReadingChange?(enabled: boolean): void;
  tapRegions?: ReaderTapRegionSettings;
  onTapRegionsChange?(next: ReaderTapPreferences): void;
  tapRegionsScrollMode?: boolean;
  importArchiveDisabled?: boolean;
  importActive?: boolean;
  saveFileActive?: boolean;
  lanTransferActive?: boolean;
  onOpenLanTransfer?(): void;
  onImportArchive(): void;
  onExportArchive(): void;
  onExportAllBooks?(): void;
  onImportLegacyArchive?(): void;
  bodySearch?: ShelfBodySearchProps;
  onOpenDiagnostics?(): void;
  /** The shelf's single back slot: the page answers Android back for its own levels. */
  registerSubmenuBackHandler?(handler: (() => boolean) | null): void;
  onClose(): void;
}

const THEMES: Array<{ value: Theme; label: "shelfMenu.theme.light" | "shelfMenu.theme.sepia" | "shelfMenu.theme.gray" | "shelfMenu.theme.dark" }> = [
  { value: "light", label: "shelfMenu.theme.light" },
  { value: "sepia", label: "shelfMenu.theme.sepia" },
  { value: "gray", label: "shelfMenu.theme.gray" },
  { value: "dark", label: "shelfMenu.theme.dark" },
];

function Icon({ children }: { children: ReactNode }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

const SECTION_ICONS: Record<ShelfSettingsSection, ReactNode> = {
  appearance: <Icon><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" /></Icon>,
  reading: <Icon><path d="M3 5.5c3-1.3 6-1.3 9 .8v13c-3-2.1-6-2.1-9-.8z" /><path d="M21 5.5c-3-1.3-6-1.3-9 .8v13c3-2.1 6-2.1 9-.8z" /></Icon>,
  data: <Icon><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9" /><path d="M10 13h4" /></Icon>,
  storage: <Icon><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M5.5 13 8 5h8l2.5 8" /><path d="M7 16.5h.01M10.5 16.5h.01" /></Icon>,
  about: <Icon><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></Icon>,
};

const ROW_ICONS = {
  export: <Icon><path d="M12 15V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" /></Icon>,
  import: <Icon><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" /></Icon>,
  lan: <Icon><rect x="3" y="4" width="8" height="12" rx="1.5" /><rect x="13" y="8" width="8" height="12" rx="1.5" /><path d="M9 19h2M14.5 10.5h5" /></Icon>,
  cache: <Icon><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></Icon>,
  log: <Icon><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" /><path d="M14 3.5V8h4M10 12.5h5M10 16h5" /></Icon>,
};

function SettingsRow(props: { icon: ReactNode; title: string; detail?: string; disabled?: boolean; onClick(): void }) {
  return <button type="button" className="shelf-settings-row" disabled={props.disabled}
    onClick={(event) => { event.currentTarget.blur(); props.onClick(); }}>
    <span className="shelf-settings-row-icon">{props.icon}</span>
    <span className="shelf-settings-row-text">
      <strong>{props.title}</strong>
      {props.detail && <small>{props.detail}</small>}
    </span>
    <svg className="shelf-settings-row-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
  </button>;
}

function Segmented<T extends string>(props: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange(value: T): void }) {
  return <div className="shelf-settings-control">
    <span>{props.label}</span>
    <div className="shelf-segmented" role="group" aria-label={props.label}>
      {props.options.map((option) => <button key={option.value} type="button" aria-pressed={props.value === option.value}
        className={props.value === option.value ? "active" : ""} onClick={() => props.onChange(option.value)}>{option.label}</button>)}
    </div>
  </div>;
}

/**
 * Application settings opened from the shelf's gear: a desktop dialog with
 * a section list, or a full-screen touch page whose home shows appearance
 * inline and the other sections one level down. Everything here is an
 * app-level preference or maintenance; view tools (search, filter, sort)
 * stay on the shelf itself.
 */
export function ShelfSettingsPage(props: ShelfSettingsPageProps) {
  const { t } = useUiText();
  const language = useUiLanguageChoice();
  const [uiMotion, setUiMotion] = useUiMotion();
  const capabilities = getRuntimeCapabilities();
  const { present, closing } = useExitPresence(props.open);
  const dialog = props.presentation === "dialog";
  const [section, setSection] = useState<ShelfSettingsSection | null>(props.initialSection ?? (dialog ? "appearance" : null));
  const [cacheOpen, setCacheOpen] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const readingTitles = useReadingSettingsTitles(props);

  useEffect(() => {
    if (props.open) setSection(props.initialSection ?? (dialog ? "appearance" : null));
    else setCacheOpen(false);
  }, [props.open, props.initialSection, dialog]);

  // Android back and Esc walk the same levels: cache panel → section (touch) → close.
  const stepBack = useCallback((): boolean => {
    if (cacheOpen) { setCacheOpen(false); return true; }
    if (!dialog && section !== null) { setSection(null); return true; }
    return false;
  }, [cacheOpen, dialog, section]);
  const stepBackRef = useRef(stepBack);
  stepBackRef.current = stepBack;
  const register = props.registerSubmenuBackHandler;
  useEffect(() => {
    if (!props.open || !register) return;
    register(() => stepBackRef.current());
    return () => register(null);
  }, [props.open, register]);
  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || cacheOpen) return;
      if (!stepBackRef.current()) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose, cacheOpen]);

  if (!present) return null;

  const busy = props.busy;
  const archiveBusy = busy || props.saveFileActive || props.lanTransferActive;
  const readingProps: ReadingSettingsProps = {
    tapRegions: props.tapRegions,
    onTapRegionsChange: props.onTapRegionsChange,
    tapRegionsScrollMode: props.tapRegionsScrollMode,
    keepScreenOnWhileReading: props.keepScreenOnWhileReading,
    onKeepScreenOnWhileReadingChange: props.onKeepScreenOnWhileReadingChange,
    hideReaderSystemStatusBar: props.hideReaderSystemStatusBar,
    onHideReaderSystemStatusBarChange: props.onHideReaderSystemStatusBarChange,
    batteryIndicatorEnabled: props.batteryIndicatorEnabled,
    onBatteryIndicatorChange: props.onBatteryIndicatorChange,
  };

  const dataRows = [
    capabilities.supportsLanTransfer && props.onOpenLanTransfer ? <SettingsRow key="lan" icon={ROW_ICONS.lan} title={t("shelfMenu.lan")} detail={t("shelfMenu.lan.detail")}
      disabled={!props.lanTransferActive && (busy || props.importActive || props.saveFileActive)} onClick={() => props.onOpenLanTransfer!()} /> : null,
    <SettingsRow key="export" icon={ROW_ICONS.export} title={t("shelfMenu.export")} detail={t("shelfMenu.export.detail")}
      disabled={archiveBusy || props.bookCount === 0} onClick={props.onExportArchive} />,
    props.onExportAllBooks ? <SettingsRow key="exportBooks" icon={ROW_ICONS.export} title={t("bookExport.all")} detail={t("bookExport.all.detail")}
      disabled={archiveBusy || props.bookCount === 0} onClick={props.onExportAllBooks} /> : null,
    <SettingsRow key="import" icon={ROW_ICONS.import} title={t("shelfMenu.importArchive")} detail={t("shelfMenu.importArchive.detail")}
      disabled={archiveBusy || props.importArchiveDisabled} onClick={props.onImportArchive} />,
    props.onImportLegacyArchive ? <SettingsRow key="legacy" icon={ROW_ICONS.import} title={t("shelfMenu.importLegacy")} detail={t("shelfMenu.importLegacy.detail")}
      disabled={archiveBusy || props.importArchiveDisabled} onClick={props.onImportLegacyArchive} /> : null,
  ].filter(Boolean);

  const body = props.bodySearch;
  const indexing = body?.indexStatus === "indexing" || body?.indexStatus === "cancelling";
  const runIndex = (action?: () => void) => {
    if (!action || indexBusy) return;
    setIndexBusy(true);
    action();
    setTimeout(() => setIndexBusy(false), 600);
  };

  const sections: Array<{ id: ShelfSettingsSection; title: string; detail: string; content: ReactNode }> = [];
  const appearance = <div className="shelf-settings-card">
    <div className="shelf-settings-control is-stacked">
      <span>{t("shelfMenu.theme")}</span>
      <div className="shelf-theme-swatches" role="radiogroup" aria-label={t("shelfMenu.theme")}>
        {THEMES.map((theme) => <button key={theme.value} type="button" role="radio" aria-checked={props.theme === theme.value}
          className={`shelf-theme-swatch${props.theme === theme.value ? " active" : ""}`}
          style={{
            "--swatch-bg": READER_PALETTES[theme.value].background,
            "--swatch-fg": READER_PALETTES[theme.value].uiForeground,
            "--swatch-border": READER_PALETTES[theme.value].previewBorder,
          } as CSSProperties}
          disabled={busy} onClick={() => props.onThemeChange(theme.value)}>
          <span className="shelf-theme-swatch-sample" aria-hidden="true">Aa</span>
          <span>{t(theme.label)}</span>
        </button>)}
      </div>
    </div>
    <Segmented label={t("shelfMenu.motion")} value={uiMotion} onChange={(value: UiMotion) => setUiMotion(value)}
      options={[{ value: "full", label: t("shelfMenu.motion.full") }, { value: "reduced", label: t("shelfMenu.motion.reduced") }]} />
    <Segmented label={language.label} value={language.preference} onChange={(value) => language.choose(value as UiLanguagePreference)}
      options={language.options} />
    {language.error && <p className="shelf-settings-error" role="alert">{language.error}</p>}
  </div>;
  sections.push({ id: "appearance", title: t("shelfSettings.section.appearance"), detail: "", content: appearance });
  if (readingTitles.length > 0) {
    sections.push({ id: "reading", title: t("shelfSettings.section.reading"), detail: readingTitles.join(t("notice.listSep")),
      content: <ReadingSettingsContent {...readingProps} /> });
  }
  sections.push({ id: "data", title: t("shelfSettings.section.data"),
    detail: [t("shelfMenu.export"), t("shelfMenu.importArchive"), ...(capabilities.supportsLanTransfer && props.onOpenLanTransfer ? [t("shelfMenu.lan")] : [])].join(t("notice.listSep")),
    content: <div className="shelf-settings-card is-list">{dataRows}</div> });
  if (capabilities.supportsCacheStorage || body) {
    sections.push({ id: "storage", title: t("shelfSettings.section.storage"),
      detail: [...(capabilities.supportsCacheStorage ? [t("shelfMenu.cache")] : []), ...(body ? [t("shelfSettings.index")] : [])].join(t("notice.listSep")),
      content: <>
        {capabilities.supportsCacheStorage && <div className="shelf-settings-card is-list">
          <SettingsRow icon={ROW_ICONS.cache} title={t("shelfMenu.cache")} detail={t("shelfMenu.cache.detail")} disabled={busy} onClick={() => setCacheOpen(true)} />
        </div>}
        {body && <div className="shelf-settings-card">
          <div className="shelf-settings-card-title">{t("shelfSettings.index")}</div>
          <p className="shelf-settings-note">{t("shelfSettings.index.detail")}</p>
          {body.indexStatus && <SearchIndexCard props={{ ...body, onClose: () => undefined}} />}
          {(body.onRebuildIndex || body.onClearIndex) && <div className="shelf-settings-actions">
            {body.onRebuildIndex && <button type="button" disabled={body.status === "searching" || indexing || indexBusy}
              onClick={() => runIndex(body.onRebuildIndex)}>{t("search.rebuild")}</button>}
            {body.onClearIndex && <button type="button" disabled={body.status === "searching" || indexing || indexBusy}
              onClick={() => runIndex(body.onClearIndex)}>{t("search.clearIndex")}</button>}
          </div>}
        </div>}
      </> });
  }
  sections.push({ id: "about", title: t("shelfSettings.section.about"),
    detail: [t("about.notes"), t("about.checkUpdates"), ...(props.onOpenDiagnostics ? [t("shelfSettings.diagnostics")] : [])].join(t("notice.listSep")),
    content: <>
      <div className="shelf-settings-card"><AboutInfo /></div>
      {props.onOpenDiagnostics && <div className="shelf-settings-card is-list">
        <SettingsRow icon={ROW_ICONS.log} title={t("shelfSettings.diagnostics")} detail={t("shelfSettings.diagnostics.detail")} onClick={props.onOpenDiagnostics} />
      </div>}
    </> });

  const current = sections.find((item) => item.id === section) ?? null;
  const closeButton = <button type="button" className="shelf-settings-icon-btn" onClick={props.onClose} aria-label={t("shelfSettings.close")}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
  </button>;
  const backButton = (onClick: () => void, label: string) => <button type="button" className="shelf-settings-icon-btn is-back" onClick={onClick} aria-label={label}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
  </button>;

  let content: ReactNode;
  if (dialog) {
    content = <div className="shelf-settings-window" role="dialog" aria-modal="true" aria-label={t("shelfSettings.title")}>
      <nav className="shelf-settings-nav" aria-label={t("shelfSettings.nav")}>
        <div className="shelf-settings-nav-title">{t("shelfSettings.title")}</div>
        {sections.map((item) => <button key={item.id} type="button" aria-current={item.id === current?.id ? "page" : undefined}
          className={item.id === current?.id ? "active" : ""} onClick={() => setSection(item.id)}>
          <span className="shelf-settings-nav-icon">{SECTION_ICONS[item.id]}</span>{item.title}
        </button>)}
      </nav>
      <section className="shelf-settings-main">
        <header className="shelf-settings-head">
          <h2>{current?.title}</h2>
          {closeButton}
        </header>
        <div className="shelf-settings-scroll">{current?.content}</div>
      </section>
    </div>;
  } else if (current) {
    content = <section className="shelf-settings-sheet" role="dialog" aria-modal="true" aria-label={current.title}>
      <header className="shelf-settings-head">
        {backButton(() => setSection(null), t("shelfSettings.back"))}
        <h2>{current.title}</h2>
      </header>
      <div className="shelf-settings-scroll">{current.content}</div>
    </section>;
  } else {
    const appearanceSection = sections[0];
    content = <section className="shelf-settings-sheet" role="dialog" aria-modal="true" aria-label={t("shelfSettings.title")}>
      <header className="shelf-settings-head">
        {backButton(props.onClose, t("shelfSettings.back"))}
        <h2>{t("shelfSettings.title")}</h2>
      </header>
      <div className="shelf-settings-scroll">
        <div className="shelf-settings-group-label">{appearanceSection.title}</div>
        {appearanceSection.content}
        <div className="shelf-settings-group-label">{t("shelfSettings.more")}</div>
        <div className="shelf-settings-card is-list">
          {sections.slice(1).map((item) => <SettingsRow key={item.id} icon={SECTION_ICONS[item.id]} title={item.title}
            detail={item.detail} onClick={() => setSection(item.id)} />)}
        </div>
      </div>
    </section>;
  }

  return <div className={`shelf-settings-layer is-${props.presentation}${closing ? " is-closing" : ""}`}>
    {dialog && <div className="shelf-settings-backdrop" aria-hidden="true" onClick={props.onClose} />}
    {content}
    <CacheStoragePanel open={cacheOpen} onClose={() => setCacheOpen(false)} />
  </div>;
}
