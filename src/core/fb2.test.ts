import { expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { disposeBook, spineItemPath } from "./book";
import { createZipArchiveClient } from "./selectiveArchive";
import { loadSourceArchive, loadSourceBook, sourceFormat, supportedBookName } from "./documentFormats";
import { parsePortableStateV3 } from "./portableState/parser";
import { portableSchemaVersion } from "./portableState/portable-state-types";

it("reads native FB2 chapters through the existing EPUB resource and location model", async () => {
  const root = "__reader__/fb2/";
  const entries = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<container><rootfiles><rootfile full-path="${root}package.opf"/></rootfiles></container>`,
    [`${root}package.opf`]: '<package version="3.0"><metadata><title>FB2</title></metadata><manifest><item id="c0" href="c0.xhtml" media-type="application/xhtml+xml"/><item id="n" href="notes.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c0"/><itemref idref="n" linear="no"/></spine></package>',
    [`${root}c0.xhtml`]: '<html><body><p id="f61">Repeated 𠮷 repeated</p><a href="notes.xhtml#f6e31" epub:type="noteref">1</a></body></html>',
    [`${root}notes.xhtml`]: '<html><body><div id="f6e31"><p>Note</p></div></body></html>',
    [`${root}nav.xhtml`]: '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="c0.xhtml#f61">Chapter</a></li></ol></nav></body></html>',
  };
  const archive = await createZipArchiveClient(zipSync(Object.fromEntries(Object.entries(entries).map(([k,v]) => [k,strToU8(v)]))));
  const book = await loadSourceArchive(archive, "original.FB2", { bootstrap: "native" });
  try {
    expect(book.sourceFormat).toBe("fb2");
    expect(spineItemPath(book, 0)).toBe(`${root}c0.xhtml`);
    expect(book.spine[1].linear).toBe(false);
    expect(book.toc[0].href).toBe(`${root}c0.xhtml#f61`);
    expect(new TextDecoder().decode(await book.readResource!(`${root}notes.xhtml`))).toContain('id="f6e31"');
    expect(sourceFormat("original.FB2")).toBe("fb2");
    expect(supportedBookName("original.FB2")).toBe(true);
  } finally { disposeBook(book); }
  expect(book.resources.size).toBe(0);
  await expect(archive.extract([`${root}notes.xhtml`])).rejects.toThrow();
});

it("requires state five for FB2 while keeping prior sources readable and rejecting future states", async () => {
  const stamp = { deviceId:"00000000-0000-4000-8000-000000000001", counter:1 };
  const hash = "a".repeat(64);
  const books = { [hash]: {metadata:{stamp,value:{title:"Source",creator:"",fileName:"original.fb2",addedAtMs:1}},progress:{versions:[]},bookmarks:{},notes:{}} };
  const state = {schemaVersion:5,books,organization:{schemaVersion:1,books:{},folders:{}}};
  expect(portableSchemaVersion(books)).toBe(5);
  expect(parsePortableStateV3(state)).toEqual(state);
  for (const schemaVersion of [3,4,7]) expect(() => parsePortableStateV3({...state,schemaVersion})).toThrow();
  books[hash].metadata.value.fileName = "original.txt";
  expect(portableSchemaVersion(books)).toBe(4);
  expect(parsePortableStateV3({...state,schemaVersion:4}).schemaVersion).toBe(4);
  books[hash].metadata.value.fileName = "original.epub";
  expect(portableSchemaVersion(books)).toBe(3);
  expect(parsePortableStateV3({...state,schemaVersion:3}).schemaVersion).toBe(3);
  await expect(loadSourceBook(strToU8("<FictionBook/>"), "original.fb2")).rejects.toThrow("原生");
});
