import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { READER_PALETTES } from "../config/readerPalette";
import { DARK_THEME_MARKER, type DarkThemeComputedStyle, type DarkThemeStyleAdapter } from "./darkThemeContrast";
import {
  buildThemeCss,
  createReaderTheme,
  getAuthorSafeBackgroundColor,
  isReaderTheme,
  type ReaderThemeKind,
} from "./readerTheme";
import { sanitizeChapter, type SanitizeOptions } from "./sanitize";
import { DEFAULT_SETTINGS } from "./settings";

function dummyOpts(): SanitizeOptions {
  return {
    basePath: "OEBPS/Text/ch1.xhtml",
    strictXml: false,
    urlFor: (p) => `blob:test/${p}`,
    settings: DEFAULT_SETTINGS,
  };
}

function mockStyle(overrides: Partial<DarkThemeComputedStyle> = {}): DarkThemeComputedStyle {
  return {
    color: "rgb(40, 40, 40)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    opacity: "1",
    ...overrides,
  };
}

function createMockAdapter(styles: Map<Element, DarkThemeComputedStyle>): DarkThemeStyleAdapter {
  const authorComputed = new Map<Element, string>();
  for (const [el, s] of styles.entries()) {
    authorComputed.set(el, s.color);
  }
  return {
    getComputedStyle: (element) => styles.get(element) ?? mockStyle(),
    setColor: (element, color) => {
      const current = styles.get(element) ?? mockStyle();
      styles.set(element, { ...current, color });
      (element as HTMLElement).style.color = color;
    },
    mark: (element) => element.setAttribute(DARK_THEME_MARKER, "1"),
    unmark: (element) => element.removeAttribute(DARK_THEME_MARKER),
    getColor: (element) => {
      const el = element as HTMLElement;
      const value = el.style?.color ?? styles.get(element)?.color ?? "";
      return { value, priority: "", hasInline: Boolean(el.style?.color) };
    },
    restoreColor: (element, originalValue, _priority, hadInlineColor, hadStyleAttribute) => {
      const el = element as HTMLElement;
      const current = styles.get(element) ?? mockStyle();
      const restoredComputed = hadInlineColor ? originalValue : (authorComputed.get(element) ?? "rgb(40, 40, 40)");
      styles.set(element, { ...current, color: restoredComputed });
      if (hadInlineColor) {
        el.style.color = originalValue;
      } else {
        el.style.removeProperty?.("color");
        el.style.color = "";
        if (!hadStyleAttribute) {
          el.removeAttribute("style");
        }
      }
    },
  };
}

describe("readerTheme: 纯颜色与在位更新核心", () => {
  it("isReaderTheme 准确校验主题枚举", () => {
    expect(isReaderTheme("light")).toBe(true);
    expect(isReaderTheme("dark")).toBe(true);
    expect(isReaderTheme("sepia")).toBe(true);
    expect(isReaderTheme("gray")).toBe(true);
    expect(isReaderTheme("solarized")).toBe(false);
    expect(isReaderTheme(null)).toBe(false);
  });

  it("buildThemeCss 仅生成纯颜色规则，保留选择器与绘制指令，不用 background 简写", () => {
    const cssLight = buildThemeCss("light", "#f5f0e6");
    expect(cssLight).toContain("body { color: #1a1a1a; background-color: #f5f0e6; }");
    expect(cssLight).not.toContain("background:");
    expect(cssLight).not.toContain("font-size:");
    expect(cssLight).not.toContain("font-family:");
    expect(cssLight).not.toContain("writing-mode:");
    expect(cssLight).toContain("::highlight(reader-notes)");
    expect(cssLight).toContain("::highlight(reader-search-hit)");
    expect(cssLight).toContain("#epub-viewer rt { color: #1a1a1a; }");
    // 浅色主题不带深色 text-emphasis、text-shadow、toc 链接覆盖与图片投影清除
    expect(cssLight).not.toContain("-webkit-text-emphasis-color");
    expect(cssLight).not.toContain("text-shadow");
    expect(cssLight).not.toContain(".toc a");

    const cssDark = buildThemeCss("dark", "#f5f0e6");
    // 深色主题下忽略作者 bgcolor，使用主题深色
    expect(cssDark).toContain("body { color: #d4d4d4; background-color: #1e1e1e; }");
    expect(cssDark).not.toContain("#f5f0e6");
    expect(cssDark).toContain("-webkit-text-emphasis-color: #d4d4d4;");
    expect(cssDark).toContain("#epub-viewer { text-shadow: 1px 1px 1px #1e1e1e; }");
    expect(cssDark).toContain(`#epub-viewer .toc a { color: ${READER_PALETTES.dark.tocLink}; }`);
    expect(cssDark).toContain("#epub-viewer img { box-shadow: none !important; }");

    const cssGray = buildThemeCss("gray");
    expect(cssGray).toContain("body { color: #d4d4d8; background-color: #2d2d30; }");
    expect(cssGray).toContain(`#epub-viewer .toc a { color: ${READER_PALETTES.gray.tocLink}; }`);

    const cssSepia = buildThemeCss("sepia");
    expect(cssSepia).toContain("body { color: #3b2f1e; background-color: #f4ecd8; }");
    expect(cssSepia).not.toContain("text-shadow");
  });

  it("四主题往返更新：文档节点/身份完全保留，作者背景图不受损，author safe bgcolor 正确往返恢复", async () => {
    const rawHtml = `<html xmlns="http://www.w3.org/1999/xhtml">
      <head><style>body { background-image: url(../Images/bg.jpg); }</style></head>
      <body bgcolor="#f5f0e6">
        <div id="content"><p id="p1">章节正文第一段</p><p id="p2">章节正文第二段</p></div>
      </body>
    </html>`;

    const sanitized = await sanitizeChapter(rawHtml, dummyOpts());
    expect(sanitized.authorBgColor).toBe("#f5f0e6");

    const { document } = parseHTML(sanitized.html);
    const contentNode = document.querySelector("#content")!;
    const p1Node = document.querySelector("#p1")!;

    expect(getAuthorSafeBackgroundColor(document)).toBe("#f5f0e6");

    const themeStyle = document.querySelector('style[data-reader="theme"]')!;
    expect(themeStyle).not.toBeNull();
    expect(themeStyle.textContent).toContain("body { color: #1a1a1a; background-color: #f5f0e6; }");

    const controller = createReaderTheme({
      doc: document,
      theme: "light",
      authorBgColor: sanitized.authorBgColor,
    });

    const themes: ReaderThemeKind[] = ["dark", "sepia", "gray", "light", "dark", "light"];
    for (const t of themes) {
      controller.update(t);
      expect(controller.currentTheme).toBe(t);

      // 验证正文节点身份完全未变（未发生重载或替换）
      expect(document.querySelector("#content")).toBe(contentNode);
      expect(document.querySelector("#p1")).toBe(p1Node);

      const styleContent = document.querySelector('style[data-reader="theme"]')!.textContent ?? "";
      if (t === "light") {
        expect(styleContent).toContain("background-color: #f5f0e6");
      } else {
        expect(styleContent).toContain(`background-color: ${READER_PALETTES[t].background}`);
        expect(styleContent).not.toContain("#f5f0e6");
      }
      expect(styleContent).not.toMatch(/body\s*\{[^}]*background:\s*#/);
    }

    controller.dispose();
  });

  it("深色对比度修补可撤销：进入 dark/gray 修补，切回 light/sepia 完整恢复，外部改色受保护", () => {
    const { document } = parseHTML(`<html>
      <body>
        <div id="viewer">
          <p id="plain">无内联正文</p>
          <p id="author-inline" style="color: rgb(40, 40, 40); font-weight: bold">带内联样式的正文</p>
          <p id="user-owned" style="color: rgb(40, 40, 40)">用户CSS所有的文字</p>
        </div>
      </body>
    </html>`);

    const plain = document.querySelector("#plain") as HTMLElement;
    const authorInline = document.querySelector("#author-inline") as HTMLElement;
    const userOwned = document.querySelector("#user-owned") as HTMLElement;

    const styles = new Map<Element, DarkThemeComputedStyle>([
      [document.body, mockStyle({ backgroundColor: "rgb(30, 30, 30)" })],
      [plain, mockStyle({ color: "rgb(40, 40, 40)" })],
      [authorInline, mockStyle({ color: "rgb(40, 40, 40)" })],
      [userOwned, mockStyle({ color: "rgb(40, 40, 40)" })],
    ]);
    const adapter = createMockAdapter(styles);

    const controller = createReaderTheme({
      doc: document,
      theme: "light",
      adapter,
      userOwnsColor: (el) => el === userOwned,
    });

    // 初始 light 主题下不修补
    expect(plain.hasAttribute(DARK_THEME_MARKER)).toBe(false);
    expect(authorInline.hasAttribute(DARK_THEME_MARKER)).toBe(false);

    // 切换到 dark：plain 与 authorInline 应该被修补，userOwned 被排除
    controller.update("dark");
    expect(plain.getAttribute(DARK_THEME_MARKER)).toBe("1");
    expect(authorInline.getAttribute(DARK_THEME_MARKER)).toBe("1");
    expect(userOwned.hasAttribute(DARK_THEME_MARKER)).toBe(false);
    expect(styles.get(plain)?.color).toBe("#d4d4d4");
    expect(styles.get(authorInline)?.color).toBe("#d4d4d4");

    // 切换到 gray：先撤销旧修补，再应用 gray 修补 (#d4d4d8)
    controller.update("gray");
    expect(plain.getAttribute(DARK_THEME_MARKER)).toBe("1");
    expect(styles.get(plain)?.color).toBe("#d4d4d8");
    expect(styles.get(authorInline)?.color).toBe("#d4d4d8");

    // 切换回 light：完整撤销修补
    controller.update("light");
    expect(plain.hasAttribute(DARK_THEME_MARKER)).toBe(false);
    expect(authorInline.hasAttribute(DARK_THEME_MARKER)).toBe(false);
    expect(authorInline.style.color).toBe("rgb(40, 40, 40)");
    expect(authorInline.style.fontWeight).toBe("bold");
    expect(plain.getAttribute("style") ?? "").toBe("");

    // 再次进入 dark
    controller.update("dark");
    expect(plain.getAttribute(DARK_THEME_MARKER)).toBe("1");

    // 模拟外部中途修改了 plain 的颜色
    plain.style.color = "rgb(0, 128, 0)";
    styles.set(plain, mockStyle({ color: "rgb(0, 128, 0)" }));

    // 撤销（切回 sepia）：外部修改的绿色不被覆盖，但 marker 被移除
    controller.update("sepia");
    expect(plain.hasAttribute(DARK_THEME_MARKER)).toBe(false);
    expect(plain.style.color).toBe("rgb(0, 128, 0)");

    controller.dispose();
  });

  it("update 同主题幂等，dispose 后释放引用并不再修改文档", () => {
    const { document } = parseHTML("<html><body><p id='txt'>正文</p></body></html>");
    const p = document.querySelector("#txt") as HTMLElement;
    const styles = new Map<Element, DarkThemeComputedStyle>([
      [document.body, mockStyle({ backgroundColor: "rgb(30, 30, 30)" })],
      [p, mockStyle({ color: "rgb(40, 40, 40)" })],
    ]);
    const adapter = createMockAdapter(styles);

    const controller = createReaderTheme({
      doc: document,
      theme: "dark",
      adapter,
    });

    const themeStyle = document.querySelector('style[data-reader="theme"]')!;
    expect(themeStyle).not.toBeNull();
    const styleSnapshot = themeStyle.textContent;

    // 重复 update 相同主题为幂等 no-op
    controller.update("dark");
    expect(themeStyle.textContent).toBe(styleSnapshot);

    // dispose() 移除样式并撤销修补
    controller.dispose();
    expect(document.querySelector('style[data-reader="theme"]')).toBeNull();
    expect(p.hasAttribute(DARK_THEME_MARKER)).toBe(false);

    // 销毁后 update 不再修改文档
    controller.update("sepia");
    expect(document.querySelector('style[data-reader="theme"]')).toBeNull();
  });

  it("单 doc 唯一 owner 约束：旧 owner 销毁或更新不能撤销新 owner 的样式与修补", () => {
    const { document } = parseHTML("<html><body><p id='txt'>正文</p></body></html>");
    const p = document.querySelector("#txt") as HTMLElement;
    const styles = new Map<Element, DarkThemeComputedStyle>([
      [document.body, mockStyle({ backgroundColor: "rgb(30, 30, 30)" })],
      [p, mockStyle({ color: "rgb(40, 40, 40)" })],
    ]);
    const adapter = createMockAdapter(styles);

    const owner1 = createReaderTheme({
      doc: document,
      theme: "light",
      adapter,
    });

    // owner2 接管同一 doc
    const owner2 = createReaderTheme({
      doc: document,
      theme: "dark",
      adapter,
    });

    expect(p.getAttribute(DARK_THEME_MARKER)).toBe("1");
    expect(owner2.currentTheme).toBe("dark");

    // owner1 调用 update 或 dispose：因为不再是活跃 owner，不得破坏 owner2 的修补与样式
    owner1.update("sepia");
    expect(document.querySelector('style[data-reader="theme"]')?.textContent).toContain(READER_PALETTES.dark.background);
    expect(p.getAttribute(DARK_THEME_MARKER)).toBe("1");

    owner1.dispose();
    expect(document.querySelector('style[data-reader="theme"]')).not.toBeNull();
    expect(p.getAttribute(DARK_THEME_MARKER)).toBe("1");

    // owner2 正常 dispose
    owner2.dispose();
    expect(document.querySelector('style[data-reader="theme"]')).toBeNull();
    expect(p.hasAttribute(DARK_THEME_MARKER)).toBe(false);
  });
});
