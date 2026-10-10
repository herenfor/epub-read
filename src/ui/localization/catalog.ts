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
import commonEn from "./en/common.json";
import folderEn from "./en/folder.json";
import languageEn from "./en/language.json";
import readerEn from "./en/reader.json";
import startupEn from "./en/startup.json";

export const CATALOGS = [common, folder, language, reader, startup] as const;

export const zhCN = {
  ...common.zh,
  ...folder.zh,
  ...language.zh,
  ...reader.zh,
  ...startup.zh,
};

export type MessageKey = keyof typeof zhCN;

/** Translator-owned data; missing or empty entries fall back to Chinese at runtime. */
export const en: Partial<Record<MessageKey, string>> = {
  ...commonEn,
  ...folderEn,
  ...languageEn,
  ...readerEn,
  ...startupEn,
};

/** Namespace → English file contents, for the integrity test and translation tooling. */
export const EN_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  common: commonEn,
  folder: folderEn,
  language: languageEn,
  reader: readerEn,
  startup: startupEn,
};
