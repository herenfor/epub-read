import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Book } from "../../../core/types";
import { clearAppBuildSession, setAppBuildSession } from "../../../config/appBuildSession";
import { AiFoundationPanel } from "./AiFoundationPanel";

const renderPanel = () => renderToStaticMarkup(createElement(AiFoundationPanel, {
  snapshot: { status: "disabled", manifest: null, health: null, error: null },
  onEnable() {}, onDisable() {}, onClose() {},
  preparation: { book: { fixedLayout: false } as Book, fingerprint: "a".repeat(64), readingBusy: false, onNavigate() {} },
}));

describe("AI preparation entry by host", () => {
  afterEach(clearAppBuildSession);
  it("exposes the resumable index with honest browser storage diagnostics", () => {
    setAppBuildSession({ source: "browser", edition: "ai", debug: true });
    const html = renderPanel();
    expect(html).toContain("启用 mock");
    expect(html).toContain("浏览器 IndexedDB");
    expect(html).toContain("开始 / 继续");
    expect(html).toContain("清理假向量");
    expect(html).toContain("检查浏览器锁");
    expect(html).toContain("查看硬件预览");
    expect(html).toContain("桌面模型库的文件锁需在 Windows 验证");
  });
  it("exposes the index harness only for desktop debug, never release", () => {
    for (const debug of [true, false]) {
      setAppBuildSession({ source: "desktop", buildInfo: { edition: "ai", debug, version: "test", protocolVersion: 1, target: "test", profile: debug ? "debug" : "release" } });
      expect(renderPanel().includes("开始 / 继续")).toBe(debug);
      expect(renderPanel().includes("检查文件锁")).toBe(debug);
      expect(renderPanel().includes("探测本机硬件")).toBe(debug);
    }
  });
});
