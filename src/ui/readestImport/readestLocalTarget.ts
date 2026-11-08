/**
 * The local EPUB a Readest book is converted against: its own OPF and original
 * chapter XHTML, read through the shelf store's existing archive channel.
 * Nothing here goes through the reader session; the caller closes the target.
 */
import { disposeBook, spineItemPath } from "../../core/book";
import { loadSourceArchive } from "../../core/documentFormats";
import { hasParserError, parseXmlText } from "../../core/parseXml";
import type { Book } from "../../core/types";
import type { ShelfStore } from "../shelf";
import type { ReadestImportTarget } from "./readestConvert";

export interface OpenedReadestTarget {
  target: ReadestImportTarget;
  close(): void;
}

const utf8 = new TextDecoder("utf-8");

async function parseChapter(bytes: Uint8Array, mediaType: string): Promise<Document | null> {
  const text = utf8.decode(bytes);
  // CFIs count the original XHTML structure; an HTML parse is only a fallback
  // for books whose chapters are not well-formed XML.
  if (mediaType !== "text/html") {
    const strict = await parseXmlText(text, "application/xml");
    if (!hasParserError(strict) && strict.documentElement) return strict;
  }
  const loose = await parseXmlText(text, "text/html");
  return hasParserError(loose) ? null : loose;
}

function targetFor(book: Book, opfDocument: Document | null): ReadestImportTarget {
  return {
    spineIdrefs: book.spine.map((item) => item.idref),
    chapterPath: (index) => spineItemPath(book, index),
    opfDocument,
    async loadChapter(index) {
      const path = spineItemPath(book, index);
      const item = book.manifest.get(book.spine[index]?.idref ?? "");
      if (!path || !item || !book.readResource) return null;
      const bytes = await book.readResource(path);
      return bytes ? parseChapter(bytes, item.mediaType) : null;
    },
  };
}

/** Open one shelf book for conversion. Throws if the store cannot read it. */
export async function openReadestTarget(
  store: Pick<ShelfStore, "openArchive">,
  entry: { id: string; fileName: string },
): Promise<OpenedReadestTarget> {
  if (!store.openArchive) throw Object.assign(new Error("archive unavailable"), { code: "source-unavailable" });
  const archive = await store.openArchive(entry.id);
  let book: Book;
  try {
    book = await loadSourceArchive(archive, entry.fileName, { parseToc: false, preloadCover: false });
  } catch (error) {
    archive.close();
    throw error;
  }
  try {
    // The OPF is not a manifest resource; read it from the archive directly.
    const opfBytes = (await archive.extract([book.opfPath])).get(book.opfPath);
    const opf = opfBytes ? await parseXmlText(utf8.decode(opfBytes), "application/xml") : null;
    return {
      target: targetFor(book, opf && !hasParserError(opf) ? opf : null),
      close: () => disposeBook(book),
    };
  } catch (error) {
    disposeBook(book);
    throw error;
  }
}
