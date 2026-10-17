import { createElement } from "react";
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
