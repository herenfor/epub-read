/**
 * The single registry of UI message catalogs. Adding a panel = one Chinese
 * catalog in catalogs/, one English JSON in en/, and one line in each list
 * below. Nothing else needs to change.
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

export const CATALOGS = [common, folder, language, reader, startup, titlebar, footer, sidebar, notes, imageViewer, search, aa] as const;

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
};
