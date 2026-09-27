import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar } from "./Toolbar";

describe("Toolbar 边缘感应与操作坞废除契约（Zen UI Packet A）", () => {
  it("Toolbar 彻底不渲染任何 DOM，杜绝边缘感应与悬浮胶囊", () => {
    const html = renderToStaticMarkup(
      createElement(Toolbar, {
        title: "测试书籍标题",
        issueCount: 0,
        onToggleBookmark: () => {},
        onOpenBookmarks: () => {},
        onOpenToc: () => {},
        onOpenNotes: () => {},
        isBookmarked: true,
      })
    );

    // 严禁存在任何边缘感应器
    expect(html).not.toContain("toolbar-sensor");
    expect(html).not.toContain("top-sensor");
    expect(html).not.toContain("bottom-sensor");
    expect(html).not.toContain("left-sensor");
    expect(html).not.toContain("right-sensor");

    // 严禁存在微手柄与操作坞
    expect(html).not.toContain("toolbar-side-handle");
    expect(html).not.toContain("toolbar-bottom-dock");
    expect(html).not.toContain("toolbar-top-island");

    // 最终输出为空
    expect(html).toBe("");
  });
});
