import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { PageOptionsPanel, type PageOptionsPanelProps } from "./PageOptionsPanel";
import type { PageOptionsValue } from "../render/pageLayout";
import { createReactDomHarness } from "../test/reactDomHarness";

interface HostOptions {
  fixedLayout?: boolean;
  effectiveColumns?: 1 | 2;
  fontSizePx?: number;
}

async function renderPanel(initial: PageOptionsValue, options: HostOptions = {}) {
  const dom = createReactDomHarness();
  const calls: PageOptionsValue[] = [];
  let current = initial;

  function Host() {
    const [value, setValue] = useState(initial);
    current = value;
    const props: PageOptionsPanelProps = {
      value,
      effectiveColumns: options.effectiveColumns ?? 2,
      fixedLayout: options.fixedLayout ?? false,
      fontSizePx: options.fontSizePx ?? 16,
      onChange: (next) => {
        calls.push(next);
        setValue(next);
      },
    };
    return createElement(PageOptionsPanel, props);
  }

  await dom.render(createElement(Host));
  return {
    dom,
    calls,
    get value(): PageOptionsValue {
      return current;
    },
    button(label: string): HTMLButtonElement {
      const element = dom.container.querySelector(`[aria-label="${label}"]`);
      if (!element) throw new Error(`missing button: ${label}`);
      return element as unknown as HTMLButtonElement;
    },
    text(): string {
      return dom.container.textContent ?? "";
    },
  };
}

describe("PageOptionsPanel", () => {
  it("shows the legacy auto value for unset vertical margins and steps from it", async () => {
    const panel = await renderPanel({ gapPx: 24 });
    try {
      expect(panel.text()).toContain("自动（35px）");
      expect(panel.text()).toContain("自动（26px）");
      await panel.dom.click(panel.button("增大上边距"));
      expect(panel.calls[0]).toEqual({ gapPx: 24, pageMarginsPx: { top: 36 } });
      await panel.dom.click(panel.button("减小下边距"));
      expect(panel.calls[1]).toEqual({ gapPx: 24, pageMarginsPx: { top: 36, bottom: 24 } });
    } finally {
      await panel.dom.dispose();
    }
  });

  it("keeps unset horizontal margins at zero and only steps upward", async () => {
    const panel = await renderPanel({ gapPx: 24 });
    try {
      expect(panel.button("减小左边距").disabled).toBe(true);
      expect(panel.button("增大左边距").disabled).toBe(false);
      await panel.dom.click(panel.button("增大左边距"));
      expect(panel.calls[0]).toEqual({ gapPx: 24, pageMarginsPx: { left: 2 } });
      expect(panel.button("重置左边距")).toBeTruthy();
    } finally {
      await panel.dom.dispose();
    }
  });

  it("resets a single margin to automatic and keeps the other sides", async () => {
    const panel = await renderPanel({ gapPx: 24, pageMarginsPx: { top: 44, left: 16 } });
    try {
      expect(panel.text()).toContain("44px");
      await panel.dom.click(panel.button("重置上边距"));
      expect(panel.calls[0]).toEqual({ gapPx: 24, pageMarginsPx: { left: 16 } });
      expect(panel.text()).toContain("自动（35px）");
    } finally {
      await panel.dom.dispose();
    }
  });

  it("steps the column gap through zero and respects both bounds", async () => {
    const zero = await renderPanel({ gapPx: 0 });
    try {
      expect(zero.button("减小额外边距（列间距）").disabled).toBe(true);
      await zero.dom.click(zero.button("增大额外边距（列间距）"));
      expect(zero.calls[0]).toEqual({ gapPx: 2 });
    } finally {
      await zero.dom.dispose();
    }

    const max = await renderPanel({ gapPx: 96 });
    try {
      expect(max.button("增大额外边距（列间距）").disabled).toBe(true);
      await max.dom.click(max.button("减小额外边距（列间距）"));
      expect(max.calls[0]).toEqual({ gapPx: 94 });
    } finally {
      await max.dom.dispose();
    }
  });

  it("switches columns between one and two without writing back the narrow window fallback", async () => {
    const narrow = await renderPanel({ gapPx: 24, columnsPerView: 2 }, { effectiveColumns: 1 });
    try {
      expect(narrow.text()).toContain("当前窗口使用单栏");
      await narrow.dom.click(narrow.button("减小分栏数"));
      expect(narrow.calls[0]).toEqual({ gapPx: 24, columnsPerView: 1 });
      expect(narrow.button("增大分栏数").disabled).toBe(false);
    } finally {
      await narrow.dom.dispose();
    }

    const single = await renderPanel({ gapPx: 24 });
    try {
      expect(single.button("减小分栏数").disabled).toBe(true);
      await single.dom.click(single.button("增大分栏数"));
      expect(single.calls[0]).toEqual({ gapPx: 24, columnsPerView: 2 });
    } finally {
      await single.dom.dispose();
    }
  });

  it("disables columns and gap in scroll mode while keeping margins and the value", async () => {
    const panel = await renderPanel({ gapPx: 24, readingMode: "scroll", pageMarginsPx: { top: 10 } });
    try {
      expect(panel.button("增大额外边距（列间距）").disabled).toBe(true);
      expect(panel.button("减小分栏数").disabled).toBe(true);
      expect(panel.button("增大分栏数").disabled).toBe(true);
      expect(panel.text()).toContain("滚动模式不可用");
      expect(panel.button("增大上边距").disabled).toBe(false);
      await panel.dom.click(panel.button("增大上边距"));
      expect(panel.calls[0]).toEqual({ gapPx: 24, readingMode: "scroll", pageMarginsPx: { top: 12 } });
    } finally {
      await panel.dom.dispose();
    }
  });

  it("disables all six rows for fixed layout and explains it is not applicable", async () => {
    const panel = await renderPanel({ gapPx: 24, pageMarginsPx: { top: 20 }, columnsPerView: 2 }, { fixedLayout: true });
    try {
      expect(panel.text()).toContain("不适用");
      for (const label of ["上边距", "下边距", "左边距", "右边距", "额外边距（列间距）", "分栏数"]) {
        expect(panel.button(`增大${label}`).disabled).toBe(true);
        expect(panel.button(`减小${label}`).disabled).toBe(true);
      }
      await panel.dom.click(panel.button("增大上边距"));
      expect(panel.calls).toEqual([]);
    } finally {
      await panel.dom.dispose();
    }
  });

  it("resets only the page fields and preserves reading mode", async () => {
    const panel = await renderPanel({
      gapPx: 40,
      readingMode: "paginated",
      pageMarginsPx: { top: 20, left: 10 },
      columnsPerView: 2,
    });
    try {
      await panel.dom.click(panel.button("恢复页面默认"));
      expect(panel.calls[0]).toEqual({ gapPx: 24, readingMode: "paginated" });
      expect("pageMarginsPx" in panel.calls[0]).toBe(false);
      expect("columnsPerView" in panel.calls[0]).toBe(false);
    } finally {
      await panel.dom.dispose();
    }
  });
});
