/** Adapters from original TXT / image ZIP sources to the shared reading model. */
import type { ArchiveClient } from "./selectiveArchive";
import { createZipArchiveClient } from "./selectiveArchive";
import { loadBook, loadBookFromArchive } from "./book";
import { detectArchiveReferences } from "./archiveReferences";
import { guessMediaType } from "./mime";
import type { Book, BookOptions } from "./types";
export type SourceFormat = "epub" | "txt" | "comic-zip" | "fb2" | "mobi" | "azw3";
// Persisted source-scalar boundaries: keep in step with the native adapter.
export const TEXT_PART_CHARS = 32768;
export function sourceFormat(name: string): SourceFormat {
    return /\.txt$/i.test(name) ? "txt" : /\.(?:cbz|zip)$/i.test(name) ? "comic-zip" : /\.fb2$/i.test(name) ? "fb2" : /\.mobi$/i.test(name) ? "mobi" : /\.azw3$/i.test(name) ? "azw3" : "epub";
}
export function supportedBookName(name: string): boolean { return /\.(?:epub|txt|cbz|zip|fb2|mobi|azw3)$/i.test(name); }
export const TEXT_ENCODINGS = ["auto", "utf-8", "utf-16le", "utf-16be", "gb18030", "gbk", "big5", "shift_jis", "euc-jp", "iso-2022-jp", "euc-kr", ...Array.from({ length: 9 }, (_, i) => `windows-${1250 + i}`), "windows-874", "ibm866", "koi8-r", "koi8-u", "macintosh", ...[2, 3, 4, 5, 6, 7, 8, 10, 13, 14, 15, 16].map(n => `iso-8859-${n}`)] as const;
export function textEncodingFromPath(path: string | null | undefined): string | undefined {
    const encoding = /^__reader__\/txt\/([^/]+)\/s\d+\.xhtml$/.exec(path ?? "")?.[1];
    if (!encoding)
        return;
    try {
        return new TextDecoder(encoding).encoding;
    }
    catch {
        return;
    }
}
export function naturalCompare(a: string, b: string): number {
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        const left = a.codePointAt(i)!, right = b.codePointAt(j)!;
        if (left >= 48 && left <= 57 && right >= 48 && right <= 57) {
            while (a.charCodeAt(i) === 48) i++;
            while (b.charCodeAt(j) === 48) j++;
            const startA = i, startB = j;
            while (a.charCodeAt(i) >= 48 && a.charCodeAt(i) <= 57) i++;
            while (b.charCodeAt(j) >= 48 && b.charCodeAt(j) <= 57) j++;
            const length = i - startA;
            if (length !== j - startB) return length - (j - startB);
            for (let digit = 0; digit < length; digit++) {
                const difference = a.charCodeAt(startA + digit) - b.charCodeAt(startB + digit);
                if (difference) return difference;
            }
        } else {
            if (left !== right) return left - right;
            i += left > 0xffff ? 2 : 1;
            j += right > 0xffff ? 2 : 1;
        }
    }
    if (i < a.length) return 1;
    if (j < b.length) return -1;
    return a === b ? 0 : a < b ? -1 : 1;
}
export function comicImageName(path: string): boolean {
    return !path.split("/").some(s => s.startsWith(".") || s === "__MACOSX") && /\.(?:jpe?g|png|webp|avif|gif)$/i.test(path);
}
const encode = new TextEncoder();
function escape(s: string): string { return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "\ufffd").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
interface TextPart {
    path: string;
    start: number;
    chars: number;
    headings?: Array<{
        label: string;
        offset: number;
    }>;
}
interface TextDocument {
    format: "txt";
    encoding: string;
    title: string;
    parts: TextPart[];
    replacements?: boolean;
}
function baseBook(title: string): Book {
    return { version: 3, opfPath: "reader-document", metadata: { title, creator: "", language: "", identifier: "" }, manifest: new Map(), spine: [], guide: [], toc: [], resources: new Map(), fixedLayout: false, issues: [], drmProtected: false };
}
function installArchiveResources(book: Book, archive: ArchiveClient): void {
    let closed = false;
    book.archive = { close() { if (closed)
            return; closed = true; archive.close(); } };
    const pending = new Map<string, Promise<void>>();
    book.ensureResources = async (paths, signal) => {
        for (const path of new Set(paths)) {
            signal?.throwIfAborted();
            if (closed) throw new Error("阅读资源已关闭");
            const res = book.resources.get(path);
            if (!res || res.loaded !== false) continue;
            const read = async () => {
                const files = await archive.extract([path], signal);
                signal?.throwIfAborted();
                if (closed) return;
                const bytes = files.get(path);
                if (!bytes) throw new Error("阅读资源缺失");
                res.data = bytes;
                res.loaded = true;
            };
            // A cancellable caller owns its read. Cancelling it must not reject
            // a separate consumer waiting for this entry.
            if (signal) {
                await read();
                continue;
            }
            let task = pending.get(path);
            if (!task) {
                task = read().finally(() => pending.delete(path));
                pending.set(path, task);
            }
            await task;
        }
        if (closed) throw new Error("阅读资源已关闭");
    };
    book.readResource = async (path) => { await book.ensureResources!([path]); return book.resources.get(path)?.data; };
}
export async function loadTextArchive(archive: ArchiveClient): Promise<Book> {
    try {
        const raw = (await archive.extract(["__reader__/document.json"])).get("__reader__/document.json");
        const doc = JSON.parse(new TextDecoder().decode(raw)) as TextDocument;
        if (doc.format !== "txt" || !Array.isArray(doc.parts) || !doc.parts.length)
            throw new Error("文本阅读资源无效");
        const book = baseBook(doc.title);
        book.sourceFormat = "txt";
        book.textEncoding = doc.encoding;
        for (const [i, p] of doc.parts.entries()) {
            if (!archive.directory.has(p.path) || textEncodingFromPath(p.path) !== new TextDecoder(doc.encoding).encoding)
                throw new Error("文本片段身份无效");
            const id = `text-${i}`;
            book.manifest.set(id, { id, href: p.path, mediaType: "application/xhtml+xml", properties: [] });
            book.spine.push({ idref: id, linear: true });
            book.resources.set(p.path, { path: p.path, data: new Uint8Array(), mediaType: "application/xhtml+xml", loaded: false });
            for (const h of p.headings ?? [])
                book.toc.push({ label: h.label, href: `${p.path}#t${h.offset}`, children: [] });
        }
        if (!book.toc.length)
            book.toc = [{ label: doc.title, href: doc.parts[0].path, children: [] }];
        if (doc.replacements)
            book.issues.push({ kind: "book_error", source: "txt", message: "文本含有无法按当前编码读取的字节，可在阅读设置中切换TXT编码。" });
        installArchiveResources(book, archive);
        return book;
    }
    catch (error) {
        archive.close();
        throw error;
    }
}
export async function loadComicArchive(archive: ArchiveClient, title: string): Promise<Book> {
    // A ZIP carrying an EPUB package remains an EPUB even if its suffix was .zip.
    if (archive.directory.has("META-INF/container.xml"))
        return loadBookFromArchive(archive);
    try {
        const paths = [...archive.directory.keys()].filter(comicImageName).sort(naturalCompare);
        if (!paths.length)
            throw new Error("压缩包内没有支持的漫画图片");
        const book = baseBook(title);
        book.sourceFormat = "comic-zip";
        book.fixedLayout = true;
        book.coverHref = paths[0];
        book.comicPages = paths.map(path => ({ path, doublePage: false }));
        const references = detectArchiveReferences(archive.directory);
        book.archiveReferences = references;
        for (const path of paths)
            book.resources.set(path, { path, data: new Uint8Array(), mediaType: guessMediaType(path), loaded: false });
        const meta = [...archive.directory.keys()].find(p => /(?:^|\/)ComicInfo\.xml$/i.test(p));
        if (meta && archive.directory.get(meta)!.expandedBytes <= 1024 * 1024) {
            try {
                const xml = new TextDecoder().decode((await archive.extract([meta])).get(meta));
                const { parseXmlText } = await import("./parseXml");
                const doc = await parseXmlText(xml);
                const value = (tag: string) => doc.getElementsByTagName(tag)[0]?.textContent?.trim();
                book.metadata.title = value("Title") || title;
                book.metadata.creator = value("Writer") || value("Penciller") || "";
                if (value("Manga") === "YesAndRightToLeft")
                    book.pageProgression = "rtl";
                for (const page of Array.from(doc.getElementsByTagName("Page"))) {
                    const n = Number(page.getAttribute("Image"));
                    if (!Number.isInteger(n) || n < 0 || n >= paths.length)
                        continue;
                    book.comicPages[n].doublePage = /^(?:true|1)$/i.test(page.getAttribute("DoublePage") ?? "");
                    if (page.getAttribute("Type") === "FrontCover")
                        book.coverHref = paths[n];
                }
            }
            catch { /* Optional metadata never makes otherwise readable image pages unusable. */ }
        }
        const path = "__reader__/comic.xhtml";
        book.manifest.set("comic", { id: "comic", href: path, mediaType: "application/xhtml+xml", properties: [] });
        book.spine = [{ idref: "comic", linear: true }];
        book.resources.set(path, { path, data: encode.encode(`<html xmlns="http://www.w3.org/1999/xhtml"><head/><body>${paths.map(p => `<img src="${escape(p)}"/>`).join("")}</body></html>`), mediaType: "application/xhtml+xml", loaded: true });
        book.toc = paths.map((p, i) => ({ label: `${i + 1} · ${p.split('/').pop()}`, href: `${path}#page-${i}`, children: [] }));
        installArchiveResources(book, archive);
        return book;
    }
    catch (error) {
        archive.close();
        throw error;
    }
}
// Keep these title rules in sync with the native TXT generator.
const textNumber = "[0-9０-９〇零一二三四五六七八九十百千万萬两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]";
const chineseChapter = new RegExp(`^第\\s*${textNumber}+\\s*[章节節回卷部話话]`);
const extraChapter = new RegExp(`^番外(?:篇)?(?:[\\s:：.．、—-]|${textNumber})`);

function textHeading(line: string): string | undefined {
    const label = line.trim();
    if (Array.from(label).length > 80) return;
    if (/^(?:序章|序言|前言|楔子|尾声|尾聲|后记|後記|终章|終章|番外|番外篇|附录|附錄|prologue|epilogue)$/i.test(label)
        || chineseChapter.test(label) || extraChapter.test(label)
        || /^chapter\s+(?:[0-9]+|[ivxlcdm]+)(?:$|[\s:：.．、—-])/i.test(label)) return label;
}

/** A split title stays anchored at its original start in the previous part. */
function splitTextHeading(text: string, next: string): string | undefined {
    // UTF-16 precheck avoids walking a large paragraph just to reject it.
    if (text.length > 240) return;
    let joined = text;
    let count = Array.from(text).length;
    for (const ch of next) {
        if (ch === "\n") break;
        if (++count > 120) return;
        joined += ch;
    }
    return count <= 120 ? textHeading(joined) : undefined;
}
/** Browser fallback. Native apps perform this decoding in Rust with a bounded stream. */
export async function loadTextBytes(bytes: Uint8Array, title: string, requested?: string): Promise<Book> {
    let encoding = requested && requested !== "auto" ? requested : undefined;
    if (!encoding) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe)
            encoding = "utf-16le";
        else if (bytes[0] === 0xfe && bytes[1] === 0xff)
            encoding = "utf-16be";
        else {
            try {
                new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                encoding = "utf-8";
            }
            catch {
                encoding = "gb18030";
            }
        }
    }
    const decoder = new TextDecoder(encoding), files = new Map<string, Uint8Array>(), parts: TextPart[] = [];
    let part = "", count = 0, start = 0, cr = false;
    let pending: string | undefined;
    let continuation = false;
    const flush = (content: string, chars: number, next?: string) => {
        const path = `__reader__/txt/${decoder.encoding}/s${start}.xhtml`;
        const headings: NonNullable<TextPart["headings"]> = [];
        let offset = 0;
        let hasText = false;
        const html = content.split(/(?<=\n)/).map(line => {
            const value = line.replace(/\n$/, "");
            const startsLine = offset !== 0 || !continuation;
            const label = !startsLine ? undefined : line.endsWith("\n") || next === undefined
                ? textHeading(value) : splitTextHeading(value, next);
            const blank = !value.trim();
            const body = blank ? "<br/>" : escape(value);
            let attributes = "";
            if (label) {
                headings.push({ label, offset });
                attributes = ` id="t${offset}"` + (hasText ? ' data-txt-chapter-break="true"' : "");
            } else if (startsLine && !blank && !/^[ \t\u3000\u00a0]/.test(value)) {
                attributes = ' data-txt-indent="true"';
            }
            hasText ||= !blank;
            offset += Array.from(line).length;
            return `<p${attributes}>${body}</p>`;
        }).join("");
        files.set(path, encode.encode(`<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><style>p{margin:0;text-align:justify;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:auto}p[data-txt-indent]{text-indent:var(--reader-txt-indent,0em)}p[data-txt-chapter-break]{break-before:column}</style></head><body>${html}</body></html>`));
        parts.push({ path, start, chars, headings });
        start += chars;
        continuation = !content.endsWith("\n");
    };
    for (let offset = 0; offset < bytes.length; offset += 65536) {
        const value = decoder.decode(bytes.subarray(offset, offset + 65536), { stream: offset + 65536 < bytes.length });
        for (let ch of value) {
            if (cr && ch === "\n") {
                cr = false;
                continue;
            }
            cr = ch === "\r";
            if (cr)
                ch = "\n";
            part += ch;
            if (++count === TEXT_PART_CHARS) {
                if (pending !== undefined) flush(pending, TEXT_PART_CHARS, part);
                pending = part;
                part = "";
                count = 0;
            }
        }
    }
    if (pending !== undefined) flush(pending, TEXT_PART_CHARS, count ? part : undefined);
    if (count || !parts.length) flush(part, count);
    files.set("__reader__/document.json", encode.encode(JSON.stringify({ format: "txt", encoding: decoder.encoding, title, parts })));
    let closed = false;
    const archive: ArchiveClient = { directory: new Map([...files].map(([name, data]) => [name, { name, compressedBytes: data.length, expandedBytes: data.length }])), async extract(paths) { if (closed)
            throw new Error("阅读资源已关闭"); return new Map(paths.map(p => [p, files.get(p)!])); }, close() { closed = true; files.clear(); } };
    return loadTextArchive(archive);
}
export async function loadSourceBook(bytes: Uint8Array, fileName: string, options: BookOptions = {}, encoding?: string): Promise<Book> {
    const format = sourceFormat(fileName);
    if (format === "fb2")
        throw new Error("FB2 请通过原生书库导入并打开；浏览器暂不支持读取 FB2 原文件");
    if (format === "mobi" || format === "azw3")
        throw new Error("MOBI/AZW3 请通过原生书库导入并打开；浏览器暂不支持读取 Kindle 原文件");
    if (format === "txt")
        return loadTextBytes(bytes, fileName.replace(/\.txt$/i, ""), encoding);
    if (format === "comic-zip")
        return loadComicArchive(await createZipArchiveClient(bytes), fileName.replace(/\.(?:cbz|zip)$/i, ""));
    return loadBook(bytes, options);
}
export async function loadSourceArchive(archive: ArchiveClient, fileName: string, options: BookOptions = {}): Promise<Book> {
    const format = sourceFormat(fileName);
    if (format === "fb2") {
        const book = await loadBookFromArchive(archive, options);
        book.sourceFormat = "fb2";
        return book;
    }
    if (format === "mobi" || format === "azw3") {
        // The native adapter already produced the deterministic reading EPUB;
        // keep the original Kindle identity for progress/export decisions.
        const book = await loadBookFromArchive(archive, options);
        book.sourceFormat = format;
        return book;
    }
    return format === "txt" ? loadTextArchive(archive) : format === "comic-zip" ? loadComicArchive(archive, fileName.replace(/\.(?:cbz|zip)$/i, "")) : loadBookFromArchive(archive, options);
}
