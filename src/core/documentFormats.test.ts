import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { loadSourceBook, naturalCompare, TEXT_PART_CHARS, textEncodingFromPath } from "./documentFormats";
import { disposeBook } from "./book";
import { comicSpreads, comicTurnTarget } from "../ui/comicPages";
import { spineItemPath } from "./book";
import { parsePortableStateV3 } from "./portableState/parser";
import { portableSchemaVersion } from "./portableState/portable-state-types";
import { SyncArchiveClient } from "./selectiveArchive";
describe("original document formats", () => {
    it("keeps TXT literal, splits long unbroken text at Unicode scalars, and restores its encoding identity", async () => {
        const text = "第一章 开始\r\n<script>alert(1)</script>\r" + "𠮷".repeat(TEXT_PART_CHARS + 10) + "结尾";
        const bytes = strToU8(text), before = bytes.slice();
        const book = await loadSourceBook(bytes, "书.txt");
        expect(bytes).toEqual(before);
        expect(book.sourceFormat).toBe("txt");
        expect(book.spine).toHaveLength(2);
        const path = spineItemPath(book, 0)!;
        expect(textEncodingFromPath(path)).toBe("utf-8");
        const html = new TextDecoder().decode(await book.readResource!(path));
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("\r");
        expect(book.toc[0].label).toBe("第一章 开始");
        disposeBook(book);
        await expect(book.readResource!(path)).rejects.toThrow();
    });
    it("reads explicit UTF16BE and Windows Chinese text without a BOM", async () => {
        for (const [bytes, encoding, expected] of [[new Uint8Array([0, 65, 0x4e, 0x2d]), "utf-16be", "A中"], [new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), "gb18030", "中文"]] as const) {
            const book = await loadSourceBook(bytes, "test.txt", {}, encoding);
            expect(new TextDecoder().decode(await book.readResource!(spineItemPath(book, 0)!))).toContain(expected);
            disposeBook(book);
        }
    });
    it("opens CBZ as naturally ordered source pages and honors optional ComicInfo", async () => {
        const bytes = zipSync({ "pages/10.png": new Uint8Array([10]), "pages/2.png": new Uint8Array([2]), "pages/1.png": new Uint8Array([1]), "__MACOSX/junk.png": new Uint8Array([0]), "ComicInfo.xml": strToU8('<ComicInfo><Title>Test</Title><Manga>YesAndRightToLeft</Manga><Pages><Page Image="2" DoublePage="true"/></Pages></ComicInfo>') });
        const book = await loadSourceBook(bytes, "test.cbz");
        expect(book.comicPages?.map(p => p.path)).toEqual(["pages/1.png", "pages/2.png", "pages/10.png"]);
        expect(book.pageProgression).toBe("rtl");
        expect(book.comicPages?.[2].doublePage).toBe(true);
        expect(comicSpreads(book.comicPages!, 2)).toEqual([[0], [1], [2]]);
        expect(await book.readResource!("pages/2.png")).toEqual(new Uint8Array([2]));
        disposeBook(book);
        expect(() => new SyncArchiveClient(bytes)).toThrow(); // Generic ZIP support must not weaken EPUB validation.
    });
    it("orders long numeric runs without locale or floating point and keeps spread identity", () => {
        expect(["10", "2", "1", "99999999999999999999", "100000000000000000000"].sort(naturalCompare)).toEqual(["1", "2", "10", "99999999999999999999", "100000000000000000000"]);
        const pages = Array.from({ length: 6 }, () => ({ doublePage: false }));
        expect(comicSpreads(pages, 2)).toEqual([[0], [1, 2], [3, 4], [5]]);
        expect(comicSpreads(pages, 1).flat()).toEqual([0, 1, 2, 3, 4, 5]);
    });
    it("queues rapid comic turns and reverses from a partial visible page", () => {
        expect(comicTurnTarget(0.2, 1, 1, 1)).toBe(2);
        expect(comicTurnTarget(0.2, 2, -1, 1)).toBe(0);
        expect(comicTurnTarget(1.8, 0, 1, -1)).toBe(2);
        expect(comicTurnTarget(2, 2, -1, null)).toBe(1);
    });
    it("marks new source formats without silently upgrading invalid or future save headers", () => {
        const stamp={deviceId:"00000000-0000-4000-8000-000000000001",counter:1};
        const hash="a".repeat(64);
        const books={ [hash]:{metadata:{stamp,value:{title:"Source",creator:"",fileName:"原书.cbz",addedAtMs:1}},progress:{versions:[]},bookmarks:{},notes:{}}};
        const state={schemaVersion:4,books,organization:{schemaVersion:1,books:{},folders:{}}};
        expect(portableSchemaVersion(books)).toBe(4);
        expect(parsePortableStateV3(state).schemaVersion).toBe(4);
        expect(()=>parsePortableStateV3({...state,schemaVersion:3})).toThrow();
        expect(()=>parsePortableStateV3({...state,schemaVersion:5})).toThrow();
        expect(parsePortableStateV3({...state,schemaVersion:3,books:{}}).schemaVersion).toBe(3);
    });

});
