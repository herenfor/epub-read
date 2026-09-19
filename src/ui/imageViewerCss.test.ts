import { describe, expect, it } from "vitest";

describe("图片浮层 CSS 边界", () => {
  it("选择器只存在于模块私有样式，全局 styles.css 不被改动", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readFile } = await import("node:fs/promises");
    const globalCss = await readFile(new URL("../styles.css", import.meta.url), "utf8");
    const viewerCss = await readFile(new URL("./imageViewer.css", import.meta.url), "utf8");
    const component = await readFile(new URL("./ImageViewer.tsx", import.meta.url), "utf8");

    expect(globalCss).not.toMatch(/\.image-viewer/);
    expect(viewerCss).toMatch(/\.image-viewer\s*\{/);
    expect(viewerCss).toMatch(/\.image-viewer-stage/);
    expect(viewerCss).toMatch(/\.image-viewer-image/);
    expect(viewerCss).toMatch(/\.image-viewer-controls/);
    expect(component).toContain('import "./imageViewer.css"');
  });

  it("触控与可访问性约束：仅浮层内部 touch-action:none，控件不小于 44px，含 safe-area", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readFile } = await import("node:fs/promises");
    const viewerCss = await readFile(new URL("./imageViewer.css", import.meta.url), "utf8");

    // touch-action:none 只允许出现在 .image-viewer* 规则块内，绝不作用于正文/body。
    const blocks = viewerCss.split("}");
    for (const block of blocks) {
      if (block.includes("touch-action")) {
        expect(block).toMatch(/\.image-viewer/);
      }
    }
    expect(viewerCss).not.toMatch(/(^|\})\s*(body|html|:root)\s*\{[^}]*touch-action/);
    expect(viewerCss).toMatch(/min-width:\s*44px/);
    expect(viewerCss).toMatch(/min-height:\s*44px/);
    expect(viewerCss).toMatch(/env\(safe-area-inset/);
  });
});
