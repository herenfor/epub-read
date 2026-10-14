import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
const loadNode = (path: string): Promise<any> => import(/* @vite-ignore */ path);

let browser: Browser, server: ViteDevServer, cache: string, url: string;
beforeAll(async () => {
  const fs = await loadNode("node:fs/promises"), os = await loadNode("node:os");
  cache = await fs.mkdtemp(os.tmpdir() + "/vertical-page-gaps-");
  server = await createServer({ configFile: false, root: decodeURIComponent(new URL("../../../", import.meta.url).pathname), cacheDir: cache,
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { host: "127.0.0.1", port: 0, watch: null }, plugins: [{ name: "fixture",
      configureServer(s) { s.middlewares.use((req, res, next) => {
        if ((req as { url?: string }).url !== "/fixture") return next();
        res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><body></body>");
      }); },
    }] });
  await server.listen(); url = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); await server?.close(); if (cache) await (await loadNode("node:fs/promises")).rm(cache, { recursive: true, force: true }); });

async function fixture(kind: "text" | "atomic" | "projection") {
  const page = await browser.newPage({ viewport: { width: 384, height: 798 } });
  try {
    await page.goto(`${url}fixture`);
    return await page.evaluate(async (kind) => {
      // Served by Vite, not imported into the Node test realm: real line boxes.
      const load = new Function("path", "return import(path)") as (path: string) => Promise<any>;
      const { VerticalPageGaps } = await load("/src/render/vertical/pageGaps.ts");
      const { buildVisibleTextIndex } = await load("/src/render/textAnchor.ts");
      const { TextProjectionSession } = await load("/src/render/textProjection/session.ts");
      const { compileTextProjection } = await load("/src/render/textProjection/compile.ts");
      document.documentElement.style.cssText = "overflow:hidden";
      document.body.style.cssText = "margin:0;background:#111;color:#eee;overflow:hidden";
      const viewer = document.createElement("div"); document.body.append(viewer);
      viewer.style.cssText = "position:relative;box-sizing:border-box;width:384px;height:798px;padding:42px 32px 68px;writing-mode:vertical-rl;font-size:16px;line-height:1.8;overflow:auto;scrollbar-width:none";
      const text = "天地玄黃宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏閏餘成歲律呂調陽雲騰致雨露結為霜が😀";
      for (let i = 0; i < 30; i++) {
        const p = document.createElement("p"); p.style.cssText = "margin:0 1em 0 0";
        p.textContent = "　" + text.repeat(8); viewer.append(p);
      }
      if (kind === "atomic") {
        const p = viewer.children[8];
        p.innerHTML = (`<ruby>天地<rt>てんち</rt></ruby><span style="text-combine-upright:all">12</span>${"甲".repeat(40)}`).repeat(25);
        const image = document.createElement("img"); image.style.cssText = "width:300px;height:500px";
        image.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="red"/></svg>');
        viewer.children[16].before(image); await image.decode();
      }
      const originalNodes = Array.from(viewer.childNodes).flatMap(p => Array.from(p.childNodes));
      const originalMarkup = viewer.innerHTML;
      const projection = kind === "projection" ? new TextProjectionSession() : null;
      if (projection) await projection.apply(originalNodes.filter(n => n.nodeType === 3),
        await compileTextProjection({ mode: "original", rules: [
          { id: "expand", enabled: true, from: "天地", to: "天與地" },
          { id: "delete", enabled: true, from: "洪", to: "" },
        ] }));
      const before = buildVisibleTextIndex(document, viewer, projection);
      const originalText = before.text;
      const originalSelection = before.originalTextForOffsets(200, 1500);
      const gaps = new VerticalPageGaps();
      const layouts = [];
      // A font and viewport change must start from the same authored nodes.
      for (const [width, font] of [[384, 16], [460, 20]] as const) {
        gaps.dispose(); viewer.scrollLeft = 0;
        viewer.style.width = `${width}px`; viewer.style.fontSize = `${font}px`;
        const result = gaps.apply(viewer, "vertical-rl", width, 32, 32, projection);
        // The production viewport supplies its existing absolute tail spacer
        // so the final short leaf can reach an exact screen offset.
        const tail = document.createElement("div"); tail.setAttribute("data-reader", "tail-spacer");
        tail.setAttribute("aria-hidden", "true");
        tail.style.cssText = `position:absolute;right:${result.pages * width - 1}px;top:0;width:1px;height:1px`;
        viewer.append(tail);
        const index = buildVisibleTextIndex(document, viewer, projection);
        const cuts = [];
        for (let k = 0; k < (result.pages ?? 0); k++) {
          viewer.scrollLeft = -k * width;
          for (const range of index.collectTextRanges(document)) for (const r of Array.from(range.getClientRects()) as DOMRect[]) {
            if (r.width > 0 && r.right > .5 && r.left < width - .5 && (r.left < 31.5 || r.right > width - 31.5)) cuts.push(k);
          }
        }
        layouts.push({ ...result, cuts: Array.from(new Set(cuts)), sameSource: index.text === originalText,
          originalSelection: index.originalTextForOffsets(200, 1500) === originalSelection,
          legacyIndexes: originalNodes.filter(n => n.nodeType === 1).every(n => index.elementIndex(n) === before.elementIndex(n)),
          bodyClip: document.body.style.clipPath });
        tail.remove();
      }
      gaps.dispose();
      if (projection) projection.restore(originalNodes.filter(n => n.nodeType === 3));
      return { layouts, restoredMarkup: viewer.innerHTML === originalMarkup,
        restoredNodes: originalNodes.every(n => viewer.contains(n)), remainingSeams: viewer.querySelectorAll("[data-reader-page-gap]").length };
    }, kind);
  } finally { await page.close(); }
}

describe("vertical reader-owned page seams", () => {
  it.each(["text", "atomic", "projection"] as const)("keeps complete columns, canonical identities and reversible DOM across reflows (%s)", async kind => {
    const result = await fixture(kind);
    for (const layout of result.layouts) {
      expect(layout.kind).toBe("ready"); expect(layout.seams).toBeGreaterThan(0);
      expect(layout.cuts, JSON.stringify(layout)).toEqual([]); expect(layout.sameSource).toBe(true);
      expect(layout.originalSelection).toBe(true); expect(layout.legacyIndexes).toBe(true);
      expect(layout.bodyClip).toBe("");
    }
    expect(result.restoredMarkup).toBe(true); expect(result.restoredNodes).toBe(true);
    expect(result.remainingSeams).toBe(0);
  });
});
