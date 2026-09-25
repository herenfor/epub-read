import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TocPanel } from "./TocPanel";

describe("目录当前章节渲染", () => {
  it("标记当前章节并保留目录容器", () => {
    const tocHtml = renderToStaticMarkup(
      createElement(TocPanel, {
        toc: [
          { label: "第一章", href: "ch1.xhtml", children: [] },
          { label: "第二章", href: "ch2.xhtml", children: [] },
        ],
        activeHref: "ch2.xhtml",
        onNavigate: () => {},
        onClose: () => {},
      })
    );
    expect(tocHtml).toContain('class="toc-content"');
    expect(tocHtml).toContain("toc-item level-0 active");
  });
});
