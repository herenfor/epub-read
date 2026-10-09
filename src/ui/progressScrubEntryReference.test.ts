import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { disposeBook, loadBook, spineIndexForPath, spineItemHref, spineItemPath } from "../core/book";
import { createContentAxis } from "./readerProgressAxis";
import { buildEpub } from "../test/fixtures";

describe("progress scrub chapter navigation reference", () => {
  it("routes axis targets to the exact spine entry instead of interpreting raw URI punctuation", async () => {
    const paths = ["OEBPS/Text/start.xhtml", "OEBPS/Text/a?b#c%20.xhtml", "OEBPS/Text/a%20.xhtml"];
    const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");
    const files: Record<string, Uint8Array> = {
      "mimetype": strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
      "OEBPS/book.opf": strToU8(`<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title></metadata><manifest>${paths.map((path, index) => `<item id="c${index}" href="${encode(path.slice(6))}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${paths.map((_path, index) => `<itemref idref="c${index}"/>`).join("")}</spine></package>`),
    };
    for (const path of paths) files[path] = strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Text</p></body></html>');
    const book = await loadBook(zipSync(files));
    try {
      const axis = createContentAxis(paths.map((path, spineIndex) => ({ key: `${spineIndex}:${path}`, spineIndex, weight: 100 })));
      for (const ratio of [0, 0.5, 1]) {
        const target = axis.locate(ratio)!;
        const href = spineItemHref(book, target.spineIndex)!;
        expect(spineIndexForPath(book, href)).toBe(target.spineIndex);
        expect(book.archiveReferences!.resolve(book.opfPath, href)).toEqual({ path: paths[target.spineIndex], anchor: "" });
        expect(spineItemPath(book, target.spineIndex)).toBe(paths[target.spineIndex]);
      }
      expect(spineIndexForPath(book, paths[1])).toBe(-1); // The former raw-key handoff really fails.
      expect(spineItemHref(book, 3)).toBeUndefined();
    } finally { disposeBook(book); }
  });

  it("preserves ordinary-book navigation and raw persisted chapter identities", async () => {
    const book = await loadBook(await buildEpub({ version: 3, chapters: [
      { id: "a", href: "Text/a.xhtml", content: "<html><body>First</body></html>" },
      { id: "b", href: "Text/b.xhtml", content: "<html><body>Second</body></html>" },
    ] }));
    try {
      expect(book.archiveReferences).toBeUndefined();
      expect(spineItemHref(book, 1)).toBe("OEBPS/Text/b.xhtml");
      expect(spineItemPath(book, 1)).toBe("OEBPS/Text/b.xhtml");
      expect(spineIndexForPath(book, spineItemHref(book, 1)!)).toBe(1);
    } finally { disposeBook(book); }
  });
});
