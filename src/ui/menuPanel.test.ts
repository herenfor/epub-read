import { describe, expect, it } from "vitest";
import {
  forceHorizontalModeDescription,
  isCustomCssDraftDirty,
  preloadNextChapterModeDescription,
} from "./MenuPanel";

async function readStyles(): Promise<string> {
  // The production bundle handles CSS through Vite; this node-only contract
  // test reads source text so the detail-menu selector boundary is covered.
  // @ts-expect-error The project intentionally does not include @types/node.
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../styles.css", import.meta.url), "utf8");
}

describe("custom CSS draft commit", () => {
  it("仅在草稿与已保存值不同才允许保存，并支持清空", () => {
    expect(isCustomCssDraftDirty("body { color: red; }", "body { color: red; }")).toBe(false);
    expect(isCustomCssDraftDirty("body { color: blue; }", "body { color: red; }")).toBe(true);
    expect(isCustomCssDraftDirty("", "body { color: red; }")).toBe(true);
    expect(isCustomCssDraftDirty("", "")).toBe(false);
  });
});

describe("force horizontal menu", () => {
  it("明确显示关闭时跟随书籍、开启时竖排转横排", () => {
    expect(forceHorizontalModeDescription(false)).toBe("跟随书籍");
    expect(forceHorizontalModeDescription(true)).toBe("竖排转横排");
  });
});

describe("preload next chapter menu", () => {
  it("明确显示关闭、开启和上层禁用时的说明", () => {
    expect(preloadNextChapterModeDescription(false)).toBe("按需加载");
    expect(preloadNextChapterModeDescription(true)).toBe("预先准备相邻章节");
    expect(preloadNextChapterModeDescription(true, true)).toBe("当前不可用");
  });
});

describe("详细设置视觉契约", () => {
  it("菜单出现纵向滚动条前已预留稳定槽位，选项宽度不会跳变", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.menu-panel\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/s);
  });

  it("滑块与开关共享主题色卡片衬底", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.detail-body \.menu-control-card\s*\{[^}]*background:\s*var\(--menu-surface\);/s);
    expect(styles).toMatch(/\.detail-body \.menu-toggle-row\s*\{[^}]*background:\s*var\(--menu-surface\);/s);
    expect(styles).toMatch(/\.detail-body \.menu-toggle-row\s*\{[^}]*border:\s*1px solid var\(--menu-surface-border\);/s);
    expect(styles).toMatch(/\.detail-body \.custom-css-input\s*\{[^}]*background:\s*var\(--menu-surface\);/s);
  });

  it("保留原生 checkbox 的键盘焦点并绘制可见开关轨道", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.detail-body \.switch-control input\[type="checkbox"\]\s*\{[^}]*opacity:\s*0;/s);
    expect(styles).toMatch(/\.detail-body \.switch-control input:checked \+ \.switch-track\s*\{[^}]*background:\s*var\(--accent\);/s);
    expect(styles).toMatch(/\.detail-body \.switch-control input:focus-visible \+ \.switch-track\s*\{[^}]*outline:\s*2px solid var\(--accent\);/s);
  });

  it("纸色使用更浅的主题色混合，避免卡片压暗文字", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\[data-theme="sepia"\]\s*\{[^}]*--menu-surface:\s*color-mix\(in srgb, var\(--accent\) 5%, var\(--panel-bg\)\);/s);
    expect(styles).toMatch(/--menu-surface-hover:\s*color-mix\(in srgb, var\(--accent\) 9%, var\(--panel-bg\)\);/s);
  });

  it("窄菜单中滑块可收缩，开关文字不额外占用顶部空间", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.slider-row\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.slider-main\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.slider-line\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.detail-body \.menu-toggle-row \.menu-label\s*\{[^}]*padding-top:\s*0;/s);
    expect(styles).toMatch(/\.detail-body \.menu-control-card\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*60px;[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.detail-body \.slider-row \.menu-label\s*\{[^}]*padding-top:\s*15px;/s);
    expect(styles).not.toMatch(/\.detail-body \.menu-control-card \.menu-label\s*\{/s);
  });

  it("滑块两端步进按钮（+ / -）内部图标弹性居中对齐", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.step-btn\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  });

  it("二级菜单包含日志与诊断按钮契约", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.log-btn\s*\{[^}]*justify-content:\s*center;/s);
  });
});
