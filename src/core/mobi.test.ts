import { expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { disposeBook, spineItemPath } from "./book";
import { createZipArchiveClient } from "./selectiveArchive";
import { loadSourceArchive, loadSourceBook, sourceFormat, supportedBookName } from "./documentFormats";
import { parsePortableStateV3 } from "./portableState/parser";
import { portableSchemaVersion } from "./portableState/portable-state-types";

const hash = "a".repeat(64);
const stamp = { deviceId: "00000000-0000-4000-8000-000000000001", counter: 1 };

function readingEpub() {
  const root = "OEBPS/";
  const entries = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<container><rootfiles><rootfile full-path="${root}content.opf"/></rootfiles></container>`,
    [`${root}content.opf`]: `<package version="2.0"><metadata><title>Kindle</title></metadata><manifest><item id="part" href="part00000.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="part"/></spine></package>`,
    [`${root}part00000.xhtml`]: `<html><body><p>Kindle text</p></body></html>`,
  };
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])));
}

it("keeps the Kindle source identity while reading the native temporary EPUB", async () => {
  const archive = await createZipArchiveClient(readingEpub());
  const book = await loadSourceArchive(archive, "original.AZW3", { bootstrap: "native" });
  try {
    expect(book.sourceFormat).toBe("azw3");
    expect(spineItemPath(book, 0)).toBe("OEBPS/part00000.xhtml");
    expect(new TextDecoder().decode(await book.readResource!("OEBPS/part00000.xhtml"))).toContain("Kindle text");
    expect(sourceFormat("original.MOBI")).toBe("mobi");
    expect(sourceFormat("original.azw3")).toBe("azw3");
    // ER-0150: only .mobi follows the build switch; AZW3 always imports.
    expect(supportedBookName("original.MOBI", true)).toBe(true);
    expect(supportedBookName("original.mobi", false)).toBe(false);
    expect(supportedBookName("original.AZW3", true)).toBe(true);
    expect(supportedBookName("original.AZW3", false)).toBe(true);
    expect(supportedBookName("original.epub", false)).toBe(true);
  } finally {
    disposeBook(book);
  }
  expect(book.resources.size).toBe(0);
  await expect(loadSourceBook(new Uint8Array([1]), "original.mobi")).rejects.toThrow("Kindle");
});

it("requires capability seven for MOBI/AZW3 and rejects older and unknown states", () => {
  const books = { [hash]: {
    metadata: { stamp, value: { title: "Kindle", creator: "", fileName: "original.mobi", addedAtMs: 1 } },
    progress: { versions: [] }, bookmarks: {}, notes: {},
  } };
  const state = { schemaVersion: 7, books, organization: { schemaVersion: 1, books: {}, folders: {} } };
  expect(portableSchemaVersion(books)).toBe(7);
  expect(parsePortableStateV3(state).schemaVersion).toBe(7);
  for (const schemaVersion of [3, 4, 5, 6]) {
    expect(() => parsePortableStateV3({ ...state, schemaVersion })).toThrow();
  }
  expect(parsePortableStateV3({ ...state, schemaVersion: 8 }).schemaVersion).toBe(8);
  books[hash].metadata.value.fileName = "original.azw3";
  expect(portableSchemaVersion(books)).toBe(7);
  expect(parsePortableStateV3({ ...state, schemaVersion: 7 }).schemaVersion).toBe(7);
});
