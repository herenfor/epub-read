import { afterEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import { ArchiveReferences } from "../core/archiveReferences";
import * as cssRewrite from "./cssRewrite";
import { ResourceServer } from "./resources";
import { sanitizeChapter } from "./sanitize";
import { DEFAULT_SETTINGS } from "./settings";
import { OwnedStylesheetUrls, StylesheetCache } from "./stylesheetCache";

const cssPath = "Styles/main.css";
const html = '<html><head><link rel="stylesheet" href="../Styles/main.css"/></head><body><p class="box">text</p></body></html>';

function fixture(): Book {
  const payloads = new Map([
    ["Text/a.xhtml", new TextEncoder().encode(html)],
    ["Text/b.xhtml", new TextEncoder().encode(html)],
    [cssPath, new TextEncoder().encode('@import "child.css"; .box{width:90%;background:url("../Images/bg.png")}')],
    ["Styles/child.css", new TextEncoder().encode('@font-face{font-family:demo;src:url("../Fonts/a.ttf")} .box{font-family:demo}')],
    ["Images/bg.png", new Uint8Array(64)], ["Fonts/a.ttf", new Uint8Array(64)],
    ["pressure", new Uint8Array(4096)],
  ]);
  const book = {
    version: 3, opfPath: "content.opf", metadata: { title: "test", identifier: "test", language: "en" },
    manifest: new Map(), spine: [], toc: [], guide: [], fixedLayout: false, issues: [], drmProtected: false,
    resources: new Map([...payloads.keys()].map(path => [path, {
      path, loaded: false, data: new Uint8Array(0), mediaType: path.endsWith("css") ? "text/css" : "application/octet-stream",
    }])),
  } as Book;
  book.ensureResources = async paths => {
    for (const path of paths) {
      const resource = book.resources.get(path);
      if (resource && payloads.has(path)) { resource.data = payloads.get(path)!; resource.loaded = true; }
    }
  };
  return book;
}

afterEach(() => vi.restoreAllMocks());

describe("shared external stylesheet cache", () => {
  it("rewrites once for two real chapter sanitizations; chapter cleanup cannot revoke shared CSS", async () => {
    const server = new ResourceServer(fixture());
    const rewrite = vi.spyOn(cssRewrite, "rewriteCssUrls");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const first = new OwnedStylesheetUrls();
    const second = new OwnedStylesheetUrls();
    try {
      for (const [chapter, owner] of [["a", first], ["b", second]] as const) {
        const holder = await server.acquireChapter(`Text/${chapter}.xhtml`);
        const result = await sanitizeChapter(html, {
          basePath: `Text/${chapter}.xhtml`, strictXml: false, settings: DEFAULT_SETTINGS,
          urlFor: p => server.urlFor(p), getText: p => server.textFor(p),
          stylesheetFor: p => { const lease = server.acquireStylesheet(p); return lease && owner.share(lease); },
        });
        expect(result.unresolvedResources).toEqual([]);
        const lease = server.acquireStylesheet(cssPath)!;
        expect(result.html).toContain(lease.url);
        if (chapter === "a") first.add("blob:chapter-owned-fallback");
        lease.release();
        server.releaseHolder(holder);
      }
      expect(rewrite).toHaveBeenCalledTimes(1);
      const shared = server.acquireStylesheet(cssPath)!;
      first.revokeAll();
      expect(revoke).toHaveBeenCalledWith("blob:chapter-owned-fallback");
      expect(revoke).not.toHaveBeenCalledWith(shared.url);
      second.revokeAll();
      shared.release();
      expect((await fetch(shared.url)).ok).toBe(true);
      server.revokeAll();
      expect(revoke).toHaveBeenCalledWith(shared.url);
      expect(server.stylesheetCacheStats).toEqual({ bytes: 0, entries: 0 });
    } finally { first.revokeAll(); second.revokeAll(); server.revokeAll(); }
  });

  it("rebuilds with fresh image/font URLs after real media-budget eviction", async () => {
    const book = fixture();
    const server = new ResourceServer(book, { mediaCacheMaxBytes: 1024 });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    try {
      const holder = await server.acquireChapter("Text/a.xhtml");
      const old = server.acquireStylesheet(cssPath)!;
      const image = server.urlFor("Images/bg.png")!;
      const font = server.urlFor("Fonts/a.ttf")!;
      const oldCss = await (await fetch(old.url)).text();
      expect(oldCss).toContain(image);
      expect(oldCss).toContain(font);
      old.release();
      await server.ensureResources(["pressure"]);
      server.releaseHolder(holder);
      expect(revoke).toHaveBeenCalledWith(image);
      expect(revoke).toHaveBeenCalledWith(font);
      expect(revoke).toHaveBeenCalledWith(old.url);
      const restored = await server.acquireChapter("Text/b.xhtml");
      const fresh = server.acquireStylesheet(cssPath)!;
      const text = await (await fetch(fresh.url)).text();
      expect(fresh.url).not.toBe(old.url);
      expect(text).not.toContain(image);
      expect(text).not.toContain(font);
      expect(text).toContain(server.urlFor("Images/bg.png"));
      expect(text).toContain(server.urlFor("Fonts/a.ttf"));
      fresh.release();
      server.releaseHolder(restored);
    } finally { server.revokeAll(); }
  });

  it("invalidates on imported text, getText results, reference resolver and maxEm changes", async () => {
    const texts = new Map([[cssPath, '@import "child.css";'], ["Styles/child.css", ".box{width:50%;color:red}"]]);
    const cache = new StylesheetCache(p => texts.get(p), () => undefined);
    const read = () => cache.acquire(cssPath)!;
    try {
      const a = read(); a.release();
      texts.set("Styles/child.css", ".box{width:50%;color:blue}");
      const b = read(); b.release();
      expect(b.url).not.toBe(a.url);
      expect(await (await fetch(b.url)).text()).toContain("blue");
      const c = cache.acquire(cssPath, { getText: p => texts.get(p)?.replace("blue", "green") })!;
      c.release();
      expect(await (await fetch(c.url)).text()).toContain("green");
      const references = new ArchiveReferences(new Map([...texts.keys()].map(p => [p, true])));
      const d = cache.acquire(cssPath, { archiveReferences: references })!; d.release();
      expect(d.url).not.toBe(c.url);
      const e = cache.acquire(cssPath, { archiveReferences: references, maxEm: 60 })!; e.release();
      expect(await (await fetch(e.url)).text()).toContain("30rem");
      expect(e.url).not.toBe(d.url);
      const otherBook = new StylesheetCache(p => texts.get(p), () => undefined);
      const f = otherBook.acquire(cssPath)!;
      expect(f.url).not.toBe(e.url);
      f.release(); otherBook.clear();
    } finally { cache.clear(); }
  });

  it("tracks an unavailable import/resource and retries when it becomes available", () => {
    const texts = new Map([[cssPath, '@import "child.css"; .box{background:url("missing.png")}']]);
    const cache = new StylesheetCache(p => texts.get(p), () => undefined);
    try {
      const first = cache.acquire(cssPath)!;
      expect(first.unresolvedResources).toEqual(["Styles/child.css", "Styles/missing.png"]);
      first.release();
      texts.set("Styles/child.css", ".box{color:red}");
      const second = cache.acquire(cssPath)!;
      expect(second.url).not.toBe(first.url);
      expect(second.unresolvedResources).toEqual(["Styles/missing.png"]);
      second.release();
    } finally { cache.clear(); }
  });

  it("bounds entries without revoking live consumers; invalidation and close release exactly once", () => {
    const cache = new StylesheetCache(() => ".box{width:50%}", () => undefined, { maxBytes: 1024, maxEntries: 1 });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const a = cache.acquire("a.css")!;
    expect(cache.acquire("b.css")).toBeUndefined();
    expect(cache.stats.entries).toBe(1);
    expect(cache.stats.bytes).toBeLessThanOrEqual(1024);
    cache.invalidateResource("a.css");
    expect(revoke).not.toHaveBeenCalledWith(a.url);
    a.release(); a.release();
    expect(revoke.mock.calls.filter(([url]) => url === a.url)).toHaveLength(1);
    const b = cache.acquire("b.css")!;
    cache.clear(); cache.clear(); b.release();
    expect(revoke.mock.calls.filter(([url]) => url === b.url)).toHaveLength(1);
    expect(cache.acquire("a.css")).toBeUndefined();
    expect(cache.stats).toEqual({ bytes: 0, entries: 0 });
  });

  it("leaves chapter style blocks and inline styles uncached", async () => {
    const stylesheetFor = vi.fn();
    const result = await sanitizeChapter('<html><head><style>.box{width:50%}</style></head><body><p style="width:40%">text</p></body></html>', {
      basePath: "Text/a.xhtml", strictXml: false, urlFor: () => undefined,
      settings: DEFAULT_SETTINGS, stylesheetFor,
    });
    expect(stylesheetFor).not.toHaveBeenCalled();
    expect(result.html).toContain("min(50%, 20rem)");
    expect(result.html).toContain("min(40%, 16rem)");
  });

  it("keeps the original owned-URL fallback when the shared budget cannot admit an entry", async () => {
    const cache = new StylesheetCache(() => ".box{width:50%}", () => undefined, { maxBytes: 0, maxEntries: 0 });
    const owner = new OwnedStylesheetUrls();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    let fallback = "";
    try {
      const result = await sanitizeChapter(html, {
        basePath: "Text/a.xhtml", strictXml: false, settings: DEFAULT_SETTINGS,
        urlFor: () => undefined, getText: () => ".box{width:50%}", stylesheetFor: p => cache.acquire(p),
        makeUrl: (text, type) => (fallback = owner.add(URL.createObjectURL(new Blob([text], { type })))),
      });
      expect(result.html).toContain(fallback);
      expect(await (await fetch(fallback)).text()).toContain("min(50%, 20rem)");
      expect(cache.stats).toEqual({ bytes: 0, entries: 0 });
      owner.revokeAll(); owner.revokeAll();
      expect(revoke.mock.calls.filter(([url]) => url === fallback)).toHaveLength(1);
    } finally { owner.revokeAll(); cache.clear(); }
  });
});
