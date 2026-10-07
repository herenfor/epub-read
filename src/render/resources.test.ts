import { describe, expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import { decodeBytes, ResourceServer } from "./resources";
import { ArchiveClosedError } from "../core/selectiveArchive";
import * as chapterDocument from "./chapterDocument";
import { sanitizeChapter } from "./sanitize";
import { DEFAULT_SETTINGS } from "./settings";

describe("decodeBytes（编码容错）", () => {
  it("UTF-8 正常解码", () => {
    const bytes = new TextEncoder().encode("中文正文");
    expect(decodeBytes(bytes)).toBe("中文正文");
  });

  it("UTF-16LE（带 BOM）", () => {
    const text = "旧书常见编码";
    const buf = new ArrayBuffer(2 + text.length * 2);
    const view = new DataView(buf);
    view.setUint16(0, 0xfeff, true); // LE BOM
    for (let i = 0; i < text.length; i++) {
      view.setUint16(2 + i * 2, text.charCodeAt(i), true);
    }
    expect(decodeBytes(new Uint8Array(buf))).toBe(text);
  });

  it("UTF-16BE（带 BOM）", () => {
    const text = "BE 编码";
    const buf = new ArrayBuffer(2 + text.length * 2);
    const view = new DataView(buf);
    view.setUint16(0, 0xfeff, false); // BE BOM
    for (let i = 0; i < text.length; i++) {
      view.setUint16(2 + i * 2, text.charCodeAt(i), false);
    }
    expect(decodeBytes(new Uint8Array(buf))).toBe(text);
  });

  it("空数据", () => {
    expect(decodeBytes(new Uint8Array(0))).toBe("");
  });
});

function book(): Book {
  return {
    version: 3,
    opfPath: "OEBPS/content.opf",
    metadata: { title: "test", identifier: "test", language: "zh" },
    manifest: new Map(),
    spine: [],
    guide: [],
    toc: [],
    resources: new Map([
      [
        "OEBPS/img.png",
        { path: "OEBPS/img.png", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
      ],
    ]),
    fixedLayout: false,
    issues: [],
    drmProtected: false,
  };
}

function lazyBackgroundBook(style: string): Book {
  const b = book();
  b.version = 2;
  const enc = new TextEncoder();
  const payloads = new Map([
    ["OEBPS/Text/message.xhtml", enc.encode(`<html xmlns="http://www.w3.org/1999/xhtml"><head/><body ${style}><p>制作信息</p></body></html>`)],
    ["OEBPS/Images/cover-bg.png", new Uint8Array([9, 8, 7, 6])],
  ]);
  b.resources = new Map([...payloads].map(([path]) => [path, {
    path, data: new Uint8Array(0), loaded: false,
    mediaType: path.endsWith(".png") ? "image/png" : "application/xhtml+xml",
  }]));
  b.ensureResources = async (paths) => {
    for (const path of paths) {
      const resource = b.resources.get(path);
      const data = payloads.get(path);
      if (resource && data) {
        resource.data = data;
        resource.loaded = true;
      }
    }
  };
  return b;
}

describe("ResourceServer authored background lifecycle", () => {
  it.each([
    `style="background-image:url('../Images/cover-bg.png');background-size:cover"`,
    `style='background-image:url("../Images/cover-bg.png");background-size:cover'`,
    `style="background-image:url(&quot;../Images/cover-bg.png&quot;);background-size:cover"`,
  ])("cold acquisition prepares and rewrites the complete style attribute: %s", async (style) => {
    const b = lazyBackgroundBook(style);
    const server = new ResourceServer(b);
    try {
      const holder = await server.acquireChapter("OEBPS/Text/message.xhtml");
      const url = server.urlFor("OEBPS/Images/cover-bg.png")!;
      expect(url).toMatch(/^blob:/);
      expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(new Uint8Array([9, 8, 7, 6]));
      expect(server.mediaCacheStats.holders).toBe(2);
      const rendered = await sanitizeChapter(server.textFor("OEBPS/Text/message.xhtml")!, {
        basePath: "OEBPS/Text/message.xhtml", strictXml: true,
        urlFor: (path) => server.urlFor(path), settings: DEFAULT_SETTINGS,
      });
      expect(rendered.html).toContain(url);
      expect(rendered.issues).toEqual([]);
      server.releaseHolder(holder);
    } finally {
      server.revokeAll();
    }
  });

  it("protects active background, evicts released bytes/URL, and restores on reentry without reparsing", async () => {
    const b = lazyBackgroundBook(`style="background-image:url('../Images/cover-bg.png')"`);
    const parse = vi.spyOn(chapterDocument, "parseChapterDocument");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const server = new ResourceServer(b, { mediaCacheMaxBytes: 256 });
    try {
      const holder = await server.acquireChapter("OEBPS/Text/message.xhtml");
      const oldUrl = server.urlFor("OEBPS/Images/cover-bg.png")!;
      b.resources.set("pressure", { path: "pressure", data: new Uint8Array(512), mediaType: "image/png" });
      await server.ensureResources(["pressure"]);
      expect(b.resources.get("OEBPS/Images/cover-bg.png")!.loaded).toBe(true);
      expect((await fetch(oldUrl)).ok).toBe(true);
      server.releaseHolder(holder);
      expect(b.resources.get("OEBPS/Images/cover-bg.png")!.loaded).toBe(false);
      expect(revoke).toHaveBeenCalledWith(oldUrl);
      expect(server.urlFor("OEBPS/Images/cover-bg.png")).toBeUndefined();
      const restored = await server.acquireChapter("OEBPS/Text/message.xhtml");
      expect(server.urlFor("OEBPS/Images/cover-bg.png")).toMatch(/^blob:/);
      expect(server.urlFor("OEBPS/Images/cover-bg.png")).not.toBe(oldUrl);
      expect(parse).toHaveBeenCalledTimes(1);
      server.releaseHolder(restored);
    } finally {
      server.revokeAll();
      parse.mockRestore();
      revoke.mockRestore();
    }
  });

  it("failed reads reject and release holders, then a retry discovers the background", async () => {
    const b = lazyBackgroundBook(`style="background-image:url('../Images/cover-bg.png')"`);
    const loader = b.ensureResources!;
    b.ensureResources = async () => {};
    const server = new ResourceServer(b);
    try {
      await expect(server.acquireChapter("OEBPS/Text/message.xhtml")).rejects.toThrow("书内资源读取未完成");
      expect(server.mediaCacheStats.holders).toBe(0);
      b.ensureResources = loader;
      const holder = await server.acquireChapter("OEBPS/Text/message.xhtml");
      expect(server.urlFor("OEBPS/Images/cover-bg.png")).toMatch(/^blob:/);
      server.releaseHolder(holder);
    } finally {
      server.revokeAll();
    }
  });

  it("closing while document parsing awaits cannot revive a chapter lease", async () => {
    let resume!: () => void;
    const blocker = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void;
    const parsing = new Promise<void>((resolve) => { entered = resolve; });
    const original = chapterDocument.parseChapterDocument;
    const parse = vi.spyOn(chapterDocument, "parseChapterDocument").mockImplementationOnce(async (...args) => {
      const parsed = await original(...args);
      entered();
      await blocker;
      return parsed;
    });
    const server = new ResourceServer(lazyBackgroundBook(`style="background-image:url('../Images/cover-bg.png')"`));
    try {
      const pending = server.acquireChapter("OEBPS/Text/message.xhtml");
      await parsing;
      server.revokeAll();
      resume();
      await expect(pending).rejects.toThrow(ArchiveClosedError);
      expect(server.mediaCacheStats.holders).toBe(0);
      expect(server.mediaCacheStats.urls).toBe(0);
    } finally {
      resume();
      server.revokeAll();
      parse.mockRestore();
    }
  });
});

describe("ResourceServer lifecycle", () => {
  it("共享资源 URL 复用，并在会话结束 revokeAll 后幂等清空", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:book/shared");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const server = new ResourceServer(book());
      expect(server.urlFor("OEBPS/img.png")).toBe("blob:book/shared");
      expect(server.urlFor("OEBPS/img.png")).toBe("blob:book/shared");
      expect(create).toHaveBeenCalledTimes(1);
      server.revokeAll();
      server.revokeAll();
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith("blob:book/shared");
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it("caches decoded chapter text with LRU hit/eviction and skips oversized entries", () => {
    const decode = vi.fn((bytes: Uint8Array) => new TextDecoder().decode(bytes));
    const b = book();
    b.resources = new Map([
      ["a", { path: "a", data: new TextEncoder().encode("alpha"), mediaType: "text/html" }],
      ["b", { path: "b", data: new TextEncoder().encode("bravo"), mediaType: "text/html" }],
      ["huge", { path: "huge", data: new TextEncoder().encode("1234567890123"), mediaType: "text/html" }],
    ]);
    const server = new ResourceServer(b, { textCacheMaxBytes: 20, textCacheMaxEntries: 2, decoder: decode });
    expect(server.textFor("a")).toBe("alpha");
    expect(server.textFor("a")).toBe("alpha");
    expect(server.textFor("b")).toBe("bravo");
    expect(server.textFor("huge")).toBe("1234567890123");
    expect(server.textCacheStats.hits).toBe(1);
    expect(server.textCacheStats.entries).toBe(2);
    expect(server.textCacheStats.bytes).toBe(20);
    expect(server.textFor("a")).toBe("alpha");
    expect(server.textCacheStats.misses).toBe(3);
    expect(server.textFor("huge")).toBe("1234567890123");
    expect(server.textCacheStats.misses).toBe(4);
    server.revokeAll();
    expect(server.textCacheStats.entries).toBe(0);
    expect(server.textCacheStats.bytes).toBe(0);
    expect(server.textCacheStats.hits).toBe(2);
    expect(server.textCacheStats.misses).toBe(4);
  });
});

describe("ResourceServer media budget", () => {
  it("evicts the least-recently-used unheld resource and revokes its blob URL", async () => {
    let nextUrl = 0;
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++nextUrl}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const b = book();
      b.resources = new Map([
        ["a", { path: "a", data: new Uint8Array(4), mediaType: "image/png" }],
        ["b", { path: "b", data: new Uint8Array(4), mediaType: "image/png" }],
      ]);
      const server = new ResourceServer(b, { mediaCacheMaxBytes: 8 });
      const urlA = server.urlFor("a");
      const urlB = server.urlFor("b");
      expect(urlA).toBe("blob:test-1");
      expect(urlB).toBe("blob:test-2");
      expect(server.mediaCacheStats.bytes).toBe(8);

      // 加入第 3 个 4 字节资源后超预算；c 是本次保护路径，按 LRU 应淘汰 a。
      b.resources.set("c", { path: "c", data: new Uint8Array(4), mediaType: "image/png" });
      await server.ensureResources(["c"]);

      expect(b.resources.get("a")!.loaded).toBe(false);
      expect(revoke).toHaveBeenCalledWith("blob:test-1");
      expect(server.mediaCacheStats.bytes).toBe(8);
      expect(server.mediaCacheStats.evictions).toBe(1);
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it("counts shared resource holders across chapters before evicting", async () => {
    const enc = new TextEncoder();
    const b = book();
    b.resources = new Map([
      [
        "OEBPS/ch1.xhtml",
        {
          path: "OEBPS/ch1.xhtml",
          data: enc.encode('<link rel="stylesheet" href="style.css"/><img src="shared.png"/>'),
          mediaType: "application/xhtml+xml",
        },
      ],
      [
        "OEBPS/ch2.xhtml",
        {
          path: "OEBPS/ch2.xhtml",
          data: enc.encode('<img src="shared.png"/>'),
          mediaType: "application/xhtml+xml",
        },
      ],
      [
        "OEBPS/style.css",
        { path: "OEBPS/style.css", data: enc.encode('body{background:url("shared.png")}'), mediaType: "text/css" },
      ],
      ["OEBPS/shared.png", { path: "OEBPS/shared.png", data: new Uint8Array(200), mediaType: "image/png" }],
    ]);
    const totalBytes = [...b.resources.values()].reduce((sum, res) => sum + res.data.byteLength, 0);
    const server = new ResourceServer(b, { mediaCacheMaxBytes: totalBytes });

    const first = await server.acquireChapter("OEBPS/ch1.xhtml");
    const second = await server.acquireChapter("OEBPS/ch2.xhtml");
    expect(b.resources.get("OEBPS/shared.png")!.loaded).not.toBe(false);
    // ch1、ch2、style.css、shared.png 都至少有一个持有者。
    expect(server.mediaCacheStats.holders).toBe(4);

    server.releaseHolder(first);
    expect(b.resources.get("OEBPS/shared.png")!.loaded).not.toBe(false);
    expect(server.mediaCacheStats.holders).toBe(2);

    // 释放第一个持有者后制造额外预算压力：shared.png 仍被第二个章节持有，
    // 所以只能先淘汰 ch1/style.css；最后释放第二个持有者时才轮到大图。
    b.resources.set("OEBPS/extra.bin", {
      path: "OEBPS/extra.bin",
      data: new Uint8Array(300),
      mediaType: "application/octet-stream",
    });
    await server.ensureResources(["OEBPS/extra.bin"]);
    expect(b.resources.get("OEBPS/shared.png")!.loaded).not.toBe(false);
    expect(server.mediaCacheStats.overBudget).toBe(true);

    server.releaseHolder(second);
    expect(b.resources.get("OEBPS/shared.png")!.loaded).toBe(false);
    expect(server.mediaCacheStats.overBudget).toBe(false);
  });
});

describe("ResourceServer recursive acquisition / close lifecycle", () => {
  it("recovers two-layer CSS and background image before releasing the holder", async () => {
    const enc = new TextEncoder();
    const payloads = new Map<string, Uint8Array>([
      ["OEBPS/ch.xhtml", enc.encode('<link rel="stylesheet" href="style.css"/>')],
      ["OEBPS/style.css", enc.encode('@import "nested.css";')],
      ["OEBPS/nested.css", enc.encode('body{background:url("background.png")}')],
      ["OEBPS/background.png", new Uint8Array([9, 9, 9, 9])],
    ]);
    const mediaTypeFor = (path: string): string => {
      if (path.endsWith(".png")) return "image/png";
      if (path.endsWith(".css")) return "text/css";
      return "application/xhtml+xml";
    };
    const b = book();
    b.resources = new Map(
      [...payloads].map(([path]) => [
        path,
        { path, data: new Uint8Array(0), mediaType: mediaTypeFor(path), loaded: false },
      ])
    );
    b.resources.set("OEBPS/old.png", {
      path: "OEBPS/old.png",
      data: new Uint8Array(100),
      mediaType: "image/png",
      loaded: true,
    });
    b.ensureResources = async (paths) => {
      for (const path of paths) {
        const res = b.resources.get(path);
        const data = payloads.get(path);
        if (res && data) {
          res.data = data;
          res.loaded = true;
        }
      }
    };

    const server = new ResourceServer(b, { mediaCacheMaxBytes: 120 });
    const holder = await server.acquireChapter("OEBPS/ch.xhtml");

    // 旧无主大资源先被淘汰腾出预算；递归发现的 CSS/背景图由 holder 保护。
    expect(b.resources.get("OEBPS/old.png")!.loaded).toBe(false);
    for (const path of ["OEBPS/ch.xhtml", "OEBPS/style.css", "OEBPS/nested.css", "OEBPS/background.png"]) {
      expect(b.resources.get(path)!.loaded).not.toBe(false);
    }
    expect(server.mediaCacheStats.holders).toBe(4);

    server.releaseHolder(holder);
    server.revokeAll();
  });

  it("rejects in-flight ensureResources after close without reviving bytes or urls", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const b = book();
    b.resources = new Map([
      [
        "late.xhtml",
        { path: "late.xhtml", data: new Uint8Array(0), mediaType: "application/xhtml+xml", loaded: false },
      ],
    ]);
    b.ensureResources = async (paths) => {
      entered();
      await blocker;
      for (const path of paths) {
        const res = b.resources.get(path);
        if (res) {
          res.data = new Uint8Array([1, 2, 3]);
          res.loaded = true;
        }
      }
    };

    const server = new ResourceServer(b, { mediaCacheMaxBytes: 8 });
    const pending = server.ensureResources(["late.xhtml"]);
    await enteredPromise;
    server.revokeAll();
    expect(server.mediaCacheStats.bytes).toBe(0);

    release();
    await expect(pending).rejects.toThrow(ArchiveClosedError);
    await expect(pending).rejects.toThrow("归档已关闭");
    expect(server.mediaCacheStats.bytes).toBe(0);
    expect(server.mediaCacheStats.entries).toBe(0);
    expect(server.mediaCacheStats.urls).toBe(0);
    expect(server.mediaCacheStats.holders).toBe(0);
  });
});
