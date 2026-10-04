import { describe, expect, it, vi } from "vitest";
import { buildEpub } from "./fixtures";
import { loadBook, resolveTocHrefs, spineIndexForPath, spineItemPath, DrmError } from "../core/book";
import { SelectiveEpubArchive } from "../core/selectiveArchive";

const CH1 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>1</title></head><body><h1>第一章</h1><p>正文内容。</p></body></html>`;
const CH2 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>2</title></head><body><h1>第二章</h1><p>更多内容。</p></body></html>`;

describe("resolveTocHrefs: nav/NCX href", () => {
  const node = (href: string) => ({ label: href || "空", href, children: [] });
  const resolve = (href: string, basePath = "OEBPS/nav.xhtml", spine = ["OEBPS/nav.xhtml"]) =>
    resolveTocHrefs([node(href)], basePath, [], "nav", (target) =>
      spine.includes(target.split("#", 1)[0])
    )[0];

  it("仅在 nav 文档属于 spine 时解析 # 与 #id", () => {
    expect(resolve("#").href).toBe("OEBPS/nav.xhtml");
    expect(resolve("#part-1").href).toBe("OEBPS/nav.xhtml#part-1");
    expect(resolve("#part-1", "OEBPS/nav.xhtml", ["OEBPS/ch1.xhtml"]).disabled).toBe(true);
  });

  it("外部、空 href 和没有上下文的 fragment 仍保持禁用", () => {
    expect(resolve("https://example.com").disabled).toBe(true);
    expect(resolve("").disabled).toBe(true);
    expect(resolve("#id", "OEBPS/nav.xhtml", []).disabled).toBe(true);
  });
});

describe("loadBook: EPUB 2", () => {
  it("解析 metadata / manifest / spine / NCX 目录", async () => {
    const bytes = await buildEpub({
      version: 2,
      title: "旧书",
      identifier: "urn:uuid:11111111-2222-3333-4444-555555555555",
      chapters: [
        { id: "c1", href: "ch1.xhtml", content: CH1 },
        { id: "c2", href: "ch2.xhtml", content: CH2 },
      ],
      toc: [
        { label: "第一章 开始", href: "ch1.xhtml" },
        { label: "第二章", href: "ch2.xhtml", children: [{ label: "小节", href: "ch2.xhtml#sec" }] },
      ],
    });
    const book = await loadBook(bytes);
    expect(book.version).toBe(2);
    expect(book.metadata.title).toBe("旧书");
    expect(book.metadata.identifier).toBe("urn:uuid:11111111-2222-3333-4444-555555555555");
    expect(book.spine.map((s) => s.idref)).toEqual(["c1", "c2"]);
    expect(book.spine.every((s) => s.linear)).toBe(true);
    expect(book.resources.has("OEBPS/ch1.xhtml")).toBe(true);
    expect(book.toc.length).toBe(2);
    expect(book.toc[0].label).toBe("第一章 开始");
    expect(book.toc[0].href).toBe("OEBPS/ch1.xhtml");
    expect(book.toc[1].children[0].href).toBe("OEBPS/ch2.xhtml#sec");
    expect(spineItemPath(book, 0)).toBe("OEBPS/ch1.xhtml");
    expect(spineIndexForPath(book, "OEBPS/ch2.xhtml")).toBe(1);
  });

  it("linear=no 的旁置章节", async () => {
    const bytes = await buildEpub({
      version: 2,
      chapters: [
        { id: "c1", href: "ch1.xhtml", content: CH1 },
        { id: "fn", href: "fn.xhtml", content: CH2, linear: false },
      ],
    });
    const book = await loadBook(bytes);
    expect(book.spine[1].linear).toBe(false);
  });
});

describe("loadBook: EPUB 3", () => {
  it("nav 目录优先于 NCX", async () => {
    const bytes = await buildEpub({
      version: 3,
      title: "新书",
      chapters: [
        { id: "c1", href: "ch1.xhtml", content: CH1 },
        { id: "c2", href: "ch2.xhtml", content: CH2 },
      ],
      toc: [{ label: "甲", href: "ch1.xhtml" }, { label: "乙", href: "ch2.xhtml" }],
      includeNcx: true, // 同时带 NCX
    });
    const book = await loadBook(bytes);
    expect(book.version).toBe(3);
    expect(book.metadata.modified).toBe("2024-01-01T00:00:00Z");
    expect(book.toc.map((t) => t.label)).toEqual(["甲", "乙"]);
  });

  it("EPUB 2 书：NCX 优先于 nav（若有）", async () => {
    const bytes = await buildEpub({
      version: 2,
      chapters: [{ id: "c1", href: "ch1.xhtml", content: CH1 }],
      toc: [{ label: "NCX目录", href: "ch1.xhtml" }],
      includeNav: true,
    });
    const book = await loadBook(bytes);
    expect(book.toc[0].label).toBe("NCX目录");
  });

  it("没有 nav/NCX 时用 spine 兜底目录", async () => {
    const bytes = await buildEpub({
      version: 3,
      chapters: [{ id: "c1", href: "ch1.xhtml", content: CH1 }],
      includeNcx: false,
      includeNav: false,
    });
    const book = await loadBook(bytes);
    expect(book.toc.length).toBe(1);
    expect(book.toc[0].label).toBe("ch1");
  });

  it("固定版式信息", async () => {
    const bytes = await buildEpub({
      version: 3,
      chapters: [{ id: "c1", href: "p1.xhtml", content: CH1 }],
      fixedLayout: true,
      viewport: "600x800",
    });
    const book = await loadBook(bytes);
    expect(book.fixedLayout).toBe(true);
    expect(book.viewport).toBe("600x800");
  });
});

describe("loadBook: 字体混淆与 DRM", () => {
  const FONT_BYTES = new Uint8Array(1200).map((_, i) => (i * 7 + 3) % 256);
  const ORIGINAL = new Uint8Array(FONT_BYTES);

  it("混淆字体被正确还原", async () => {
    const bytes = await buildEpub({
      version: 2,
      chapters: [{ id: "c1", href: "ch1.xhtml", content: CH1 }],
      fonts: [{ path: "fonts/body.ttf", data: FONT_BYTES }],
      obfuscateFonts: ["fonts/body.ttf"],
    });
    const book = await loadBook(bytes);
    const res = book.resources.get("OEBPS/fonts/body.ttf");
    expect(res).toBeDefined();
    expect(res!.mediaType).toBe("application/vnd.ms-opentype");
    expect(Array.from(res!.data)).toEqual(Array.from(ORIGINAL));
  });

  it("ADEPT DRM 抛出 DrmError", async () => {
    const bytes = await buildEpub({
      version: 3,
      chapters: [{ id: "c1", href: "ch1.xhtml", content: CH1 }],
      drm: ["OEBPS/ch1.xhtml"],
    });
    await expect(loadBook(bytes)).rejects.toBeInstanceOf(DrmError);
  });
});

describe("loadBook: 容错", () => {
  it("非 EPUB 文件报错", async () => {
    await expect(loadBook(new Uint8Array([1, 2, 3]))).rejects.toThrow(/ZIP|EPUB/);
  });

  it("manifest 声明的资源缺失时记录 issue 而不是崩溃", async () => {
    const bytes = await buildEpub({
      version: 3,
      chapters: [{ id: "c1", href: "ch1.xhtml", content: CH1 }],
    });
    // 手动破坏：把 ch1 从 zip 里删掉（这里直接重新打包一个缺文件的版本）
    const { unzipSync, zipSync } = await import("fflate");
    const files = unzipSync(bytes);
    delete files["OEBPS/ch1.xhtml"];
    const broken = zipSync({ mimetype: files.mimetype, ...files }, { level: 6 });
    const book = await loadBook(broken);
    expect(book.resources.has("OEBPS/ch1.xhtml")).toBe(false);
    expect(book.issues.some((i) => i.message.includes("ch1.xhtml"))).toBe(true);
  });

  it("container.xml 指向不存在的 OPF 时报错", async () => {
    const { unzipSync, zipSync, strToU8 } = await import("fflate");
    const bytes = await buildEpub({
      version: 3,
      chapters: [{ id: "c1", href: "ch1.xhtml", content: CH1 }],
    });
    const files = unzipSync(bytes);
    files["META-INF/container.xml"] = strToU8(
      `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="OEBPS/missing.opf" media-type="application/oebps-package+xml"/></rootfiles>
      </container>`
    );
    const broken = zipSync({ mimetype: files.mimetype, ...files }, { level: 6 });
    await expect(loadBook(broken)).rejects.toThrow(/missing\.opf/);
  });

  it("OPF 目录相对路径的层级解析（../ 引用）", async () => {
    const bytes = await buildEpub({
      version: 3,
      chapters: [{ id: "c1", href: "Text/ch1.xhtml", content: CH1 }],
    });
    const book = await loadBook(bytes);
    // OPF 在 OEBPS/ 下，Text/ch1.xhtml 在 OEBPS/Text/ 下
    expect(spineItemPath(book, 0)).toBe("OEBPS/Text/ch1.xhtml");
    expect(book.resources.has("OEBPS/Text/ch1.xhtml")).toBe(true);
    expect(spineIndexForPath(book, "OEBPS/Text/ch1.xhtml")).toBe(0);
    expect(spineIndexForPath(book, "Text/ch1.xhtml")).toBe(0);
  });
});

describe("loadBook selective: 按需解压并发收敛", () => {
  it("同一路径并发 ensureResources 复用同一个解压 Promise", async () => {
    const bytes = await buildEpub({
      version: 3,
      chapters: [{ id: "c1", href: "ch1.xhtml", content: CH1 }],
      fonts: [{ path: "font.otf", data: new Uint8Array(1024) }],
    });
    const book = await loadBook(bytes, { selective: true });
    const fontPath = "OEBPS/font.otf";
    expect(book.resources.get(fontPath)?.loaded).toBe(false);

    const extract = vi.spyOn(SelectiveEpubArchive.prototype, "extract");
    try {
      const first = book.ensureResources!([fontPath]);
      const second = book.ensureResources!([fontPath]);
      await Promise.all([first, second]);

      expect(extract).toHaveBeenCalledTimes(1);
      expect(book.resources.get(fontPath)?.loaded).not.toBe(false);
      expect(await book.readResource!(fontPath)).toBeInstanceOf(Uint8Array);
    } finally {
      extract.mockRestore();
      book.archive?.close();
    }
  });
});
