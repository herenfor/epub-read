import { describe, expect, it } from "vitest";

describe("page options CSS boundary", () => {
  it("keeps panel styles in pageOptions.css and loads them from the panel", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("./pageOptions.css", import.meta.url), "utf8");
    const panel = await readFile(new URL("./PageOptionsPanel.tsx", import.meta.url), "utf8");

    expect(panel).toContain('import "./pageOptions.css"');
    expect(css).toMatch(/\.page-options-panel\b/);
    expect(css).toMatch(/\.page-options-step\b/);
    // 至少 44px 触控区
    expect(css).toMatch(/width: 44px/);
    expect(css).toMatch(/height: 44px/);
    // 不重定义全局主题与外壳选择器
    expect(css).not.toMatch(/^\s*(:root|html|body|\.app|\.menu-panel|\.menu-item)\s*[,{]/m);
  });
});
