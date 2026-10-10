/**
 * The single registry of UI message catalogs.
 *
 * Adding a panel:
 * 1. catalogs/<name>.ts — `defineMessages("<name>", { "<name>.key": "中文" })`;
 *    use `{ zh, note, max }` when a translator needs context or a length budget,
 *    and "<base>.one"/"<base>.other" pairs for count-dependent text.
 * 2. en/<name>.json — `{}`; translations arrive via `npm run i18n:import`.
 * 3. Register both below (import + CATALOGS + zhCN + en + EN_FILES).
 * 4. In components: `const { t, tn } = useUiText()`; outside React render
 *    (notices, helpers): `uiText()` / `uiPlural()`. Never compare locales in
 *    components, never build sentences from fragments without a key.
 * Book content, titles, folder names and technical error details are data,
 * not messages.
 */
import { common } from "./catalogs/common";
import { folder } from "./catalogs/folder";
import { language } from "./catalogs/language";
import { reader } from "./catalogs/reader";
import { startup } from "./catalogs/startup";
import { titlebar } from "./catalogs/titlebar";
import { footer } from "./catalogs/footer";
import { sidebar } from "./catalogs/sidebar";
import { notes } from "./catalogs/notes";
import { imageViewer } from "./catalogs/imageViewer";
import { search } from "./catalogs/search";
import { aa } from "./catalogs/aa";
import { fonts } from "./catalogs/fonts";
import { display } from "./catalogs/display";
import { about } from "./catalogs/about";
import { cache } from "./catalogs/cache";
import { saveFile } from "./catalogs/saveFile";
import { importProgress } from "./catalogs/importProgress";
import { lan } from "./catalogs/lan";
import { lanPanel } from "./catalogs/lanPanel";
import { folderImport } from "./catalogs/folderImport";
import { shelf } from "./catalogs/shelf";
import { shelfFolder } from "./catalogs/shelfFolder";
import { shelfMenu } from "./catalogs/shelfMenu";
import { shelfMain } from "./catalogs/shelfMain";
import { notice } from "./catalogs/notice";
import { appUi } from "./catalogs/appUi";
import { readerMisc } from "./catalogs/readerMisc";
import commonEn from "./en/common.json";
import folderEn from "./en/folder.json";
import languageEn from "./en/language.json";
import readerEn from "./en/reader.json";
import startupEn from "./en/startup.json";
import titlebarEn from "./en/titlebar.json";
import footerEn from "./en/footer.json";
import sidebarEn from "./en/sidebar.json";
import notesEn from "./en/notes.json";
import imageViewerEn from "./en/imageViewer.json";
import searchEn from "./en/search.json";
import aaEn from "./en/aa.json";
import fontsEn from "./en/fonts.json";
import displayEn from "./en/display.json";
import aboutEn from "./en/about.json";
import cacheEn from "./en/cache.json";
import saveFileEn from "./en/saveFile.json";
import importProgressEn from "./en/importProgress.json";
import lanEn from "./en/lan.json";
import lanPanelEn from "./en/lanPanel.json";
import folderImportEn from "./en/folderImport.json";
import shelfEn from "./en/shelf.json";
import shelfFolderEn from "./en/shelfFolder.json";
import shelfMenuEn from "./en/shelfMenu.json";
import shelfMainEn from "./en/shelfMain.json";
import noticeEn from "./en/notice.json";
import appUiEn from "./en/appUi.json";
import readerMiscEn from "./en/readerMisc.json";

export const CATALOGS = [common, folder, language, reader, startup, titlebar, footer, sidebar, notes, imageViewer, search, aa, fonts, display, about, cache, saveFile, importProgress, lan, lanPanel, folderImport, shelf, shelfFolder, shelfMenu, shelfMain, notice, appUi, readerMisc] as const;

export const zhCN = {
  ...common.zh,
  ...folder.zh,
  ...language.zh,
  ...reader.zh,
  ...startup.zh,
  ...titlebar.zh,
  ...footer.zh,
  ...sidebar.zh,
  ...notes.zh,
  ...imageViewer.zh,
  ...search.zh,
  ...aa.zh,
  ...fonts.zh,
  ...display.zh,
  ...about.zh,
  ...cache.zh,
  ...saveFile.zh,
  ...importProgress.zh,
  ...lan.zh,
  ...lanPanel.zh,
  ...folderImport.zh,
  ...shelf.zh,
  ...shelfFolder.zh,
  ...shelfMenu.zh,
  ...shelfMain.zh,
  ...notice.zh,
  ...appUi.zh,
  ...readerMisc.zh,
};

export type MessageKey = keyof typeof zhCN;

/** Translator-owned data; missing or empty entries fall back to Chinese at runtime. */
export const en: Partial<Record<MessageKey, string>> = {
  ...commonEn,
  ...folderEn,
  ...languageEn,
  ...readerEn,
  ...startupEn,
  ...titlebarEn,
  ...footerEn,
  ...sidebarEn,
  ...notesEn,
  ...imageViewerEn,
  ...searchEn,
  ...aaEn,
  ...fontsEn,
  ...displayEn,
  ...aboutEn,
  ...cacheEn,
  ...saveFileEn,
  ...importProgressEn,
  ...lanEn,
  ...lanPanelEn,
  ...folderImportEn,
  ...shelfEn,
  ...shelfFolderEn,
  ...shelfMenuEn,
  ...shelfMainEn,
  ...noticeEn,
  ...appUiEn,
  ...readerMiscEn,
};

/** Namespace → English file contents, for the integrity test and translation tooling. */
export const EN_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  common: commonEn,
  folder: folderEn,
  language: languageEn,
  reader: readerEn,
  startup: startupEn,
  titlebar: titlebarEn,
  footer: footerEn,
  sidebar: sidebarEn,
  notes: notesEn,
  imageViewer: imageViewerEn,
  search: searchEn,
  aa: aaEn,
  fonts: fontsEn,
  display: displayEn,
  about: aboutEn,
  cache: cacheEn,
  saveFile: saveFileEn,
  importProgress: importProgressEn,
  lan: lanEn,
  lanPanel: lanPanelEn,
  folderImport: folderImportEn,
  shelf: shelfEn,
  shelfFolder: shelfFolderEn,
  shelfMenu: shelfMenuEn,
  shelfMain: shelfMainEn,
  notice: noticeEn,
  appUi: appUiEn,
  readerMisc: readerMiscEn,
};
