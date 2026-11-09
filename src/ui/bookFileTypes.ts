import { MOBI_FORMAT_ENABLED } from "../config/mobiFormat";

/**
 * The book file types the UI offers in pickers, the web file input and export
 * names. One table, so enabling a format later is one row, not five lists.
 *
 * Which files are accepted for import stays decided by core
 * `supportedBookName`. The importable rows must list exactly those formats.
 * Add a row only when that format's native backend is complete: no half-wired
 * entry. The MOBI row stays in the table so books already on the shelf keep
 * their extension and MIME; the ER-0150 switch only drops it from import.
 */
export interface BookFileType {
  readonly extension: string;
  /** MIME type for Android save dialogs and the web file input. */
  readonly mime: string;
  /**
   * Readable only through the native library. The web preview has no
   * converter, so it never offers these and must not read them as ZIP/EPUB.
   */
  readonly nativeOnly?: boolean;
  /** MOBI (MOBI6): importable only when the ER-0150 build switch is on. */
  readonly behindMobiSwitch?: boolean;
}

export const BOOK_FILE_TYPES: readonly BookFileType[] = [
  { extension: "epub", mime: "application/epub+zip" },
  { extension: "fb2", mime: "application/x-fictionbook+xml", nativeOnly: true },
  { extension: "txt", mime: "text/plain" },
  { extension: "cbz", mime: "application/zip" },
  { extension: "zip", mime: "application/zip" },
  { extension: "mobi", mime: "application/x-mobipocket-ebook", nativeOnly: true, behindMobiSwitch: true },
  { extension: "azw3", mime: "application/vnd.amazon.ebook", nativeOnly: true },
];

/** The rows this build offers for import (pickers, web input). */
export function importableBookFileTypes(
  types: readonly BookFileType[] = BOOK_FILE_TYPES,
  mobi: boolean = MOBI_FORMAT_ENABLED,
): readonly BookFileType[] {
  return mobi ? types : types.filter((type) => !type.behindMobiSwitch);
}

export const IMPORT_BOOK_FILE_TYPES: readonly BookFileType[] = importableBookFileTypes();

/** Extensions for the native system file picker filter. */
export function bookPickerExtensions(types: readonly BookFileType[] = IMPORT_BOOK_FILE_TYPES): string[] {
  return types.map((type) => type.extension);
}

/** `accept` for the browser file input: native-only formats are left out. */
export function webBookAccept(types: readonly BookFileType[] = IMPORT_BOOK_FILE_TYPES): string {
  const web = types.filter((type) => !type.nativeOnly);
  return [...web.map((type) => `.${type.extension}`), ...new Set(web.map((type) => type.mime))].join(",");
}

/** The lowercase known book extension of a file name, if any. */
export function bookFileExtension(name: string, types: readonly BookFileType[] = BOOK_FILE_TYPES): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return types.some((type) => type.extension === extension) ? extension : undefined;
}

/** True for a known book that the web preview cannot read. */
export function nativeOnlyBookName(name: string, types: readonly BookFileType[] = BOOK_FILE_TYPES): boolean {
  const extension = bookFileExtension(name, types);
  return types.some((type) => type.extension === extension && type.nativeOnly === true);
}

/** MIME type matching a file name's book extension; EPUB when unknown. */
export function bookFileMime(name: string, types: readonly BookFileType[] = BOOK_FILE_TYPES): string {
  const extension = bookFileExtension(name, types);
  return types.find((type) => type.extension === extension)?.mime ?? "application/epub+zip";
}
