import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { LogPanel, type LogItem } from "./LogPanel";

it("keeps recovered records out of the active issue count and offers manual diagnostic refresh", async () => {
  const dom = createReactDomHarness();
  const onRefresh = vi.fn();
  const records: LogItem[] = [
    { kind: "reader_error", source: "render", message: "资源已恢复", resolved: true },
    { kind: "reader_error", source: "render", message: "资源缺失" },
  ];
  const render = (items: LogItem[]) => dom.render(createElement(LogPanel, {
    items, diagText: "采集时间：10:00", onRefresh, onClose: () => {},
  }));
  try {
    await render(records);
    const badge = () => dom.container.querySelector(".log-badge")!;
    expect(badge().textContent).toBe("1 个问题");
    await dom.click([...dom.container.querySelectorAll("button")].find((button) => button.textContent === "刷新诊断")!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(dom.container.querySelector(".log-diag-pre")?.textContent).toBe("采集时间：10:00");

    await render([records[0]]);
    expect(badge().textContent).toBe("正常");
    expect(badge().classList.contains("has-issues")).toBe(false);
    expect(dom.container.querySelector(".log-list")?.textContent).toContain("资源已恢复");
  } finally {
    await dom.dispose();
  }
});

it("copies diagnostics once per click, shows the result, and stays quiet after closing", async () => {
  const dom = createReactDomHarness();
  let finish!: (outcome: "copied" | "clipboard-failed") => void;
  const copyDiagnostics = vi.fn(() => new Promise<"copied" | "clipboard-failed">((resolve) => { finish = resolve; }));
  const render = () => dom.render(createElement(LogPanel, { items: [], onClose: () => {}, copyDiagnostics }));
  const button = () => [...dom.container.querySelectorAll("button")].find((b) => b.textContent === "复制诊断信息")!;
  const status = () => dom.container.querySelector(".log-copy-diag-status");
  try {
    await render();
    await dom.click(button());
    await dom.click(button());
    expect(copyDiagnostics).toHaveBeenCalledTimes(1);
    expect(button().hasAttribute("disabled")).toBe(true);
    expect(status()).toBeNull();
    await act(async () => finish("copied"));
    expect(status()?.textContent).toBe("已复制诊断信息");

    await dom.click(button());
    await act(async () => finish("clipboard-failed"));
    expect(status()?.textContent).toBe("没能复制到剪贴板，请再试一次。");
    expect(status()?.classList.contains("is-error")).toBe(true);

    await dom.click(button());
    await dom.render(null);
    await act(async () => finish("copied"));
    expect(copyDiagnostics).toHaveBeenCalledTimes(3);
  } finally {
    await dom.dispose();
  }
});
