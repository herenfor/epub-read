import { describe, expect, it } from "vitest";
import {
  CHAPTER_KEY_ATTRIBUTE,
  applyContinuousGeometry,
  commitContinuousGeometry,
} from "./continuousGeometryCommit";
import { ContinuousChapterLayout } from "./continuousChapterLayout";

interface FakeChild {
  getAttribute(name: string): string | null;
  style: { top: string; height: string };
}

function fakeCanvas(entries: Array<{ key: string | null }>): {
  style: { height: string };
  children: FakeChild[];
} {
  return {
    style: { height: "" },
    children: entries.map((entry) => {
      const attrs = new Map<string, string>();
      if (entry.key !== null) attrs.set(CHAPTER_KEY_ATTRIBUTE, entry.key);
      return {
        getAttribute: (name: string) => attrs.get(name) ?? null,
        style: { top: "", height: "" },
      };
    }),
  };
}

/**
 * 宿主替身：像浏览器一样按**当前** canvas 高度钳制 scrollTop。
 * 因此“先写几何、后写位置”的顺序差异会直接体现在接受的数值上。
 */
function clampingHost(canvas: { style: { height: string } }, viewportHeight: number) {
  let value = 0;
  let heightAtLastWrite: string | null = null;
  return {
    get scrollTop() {
      return value;
    },
    set scrollTop(next: number) {
      heightAtLastWrite = canvas.style.height;
      const max = Math.max(0, (parseFloat(canvas.style.height) || 0) - viewportHeight);
      value = Math.min(max, Math.max(0, next));
    },
    get heightAtLastWrite() {
      return heightAtLastWrite;
    },
    get value() {
      return value;
    },
  };
}

describe("continuous geometry commit order (R1)", () => {
  it("writes canvas height before scrollTop so a book-tail compensation is not truncated", () => {
    const oldLayout = new ContinuousChapterLayout([
      { key: "0:c1.xhtml", height: 1000, measured: true },
      { key: "1:c2.xhtml", height: 1000, measured: true },
    ]);
    const V = 600;
    // 旧范围上限 1400，当前位置 1300 已接近书尾
    expect(oldLayout.maxScrollTop(V)).toBe(1400);

    const canvas = fakeCanvas([{ key: "0:c1.xhtml" }, { key: "1:c2.xhtml" }]);
    canvas.style.height = `${oldLayout.totalHeight}px`;
    const host = clampingHost(canvas, V);

    // 所读文字在 c2 章内 600px、屏幕上 300px 处
    const anchor = { key: "1:c2.xhtml", offset: 600, screenY: 300 };
    const { layout: newLayout, scrollTop: newS } = oldLayout.withMeasurements(
      [{ key: "0:c1.xhtml", height: 1800, measured: true }],
      anchor,
      V,
      1300
    );
    // 目标 2100 超出旧上限 1400，但未超新上限 2200
    expect(newS).toBe(2100);

    const accepted = commitContinuousGeometry({ canvas, host, layout: newLayout, scrollTop: newS });

    expect(host.heightAtLastWrite).toBe("2800px");
    expect(accepted).toBe(2100);
    expect(host.value).toBe(2100);
  });

  it("demonstrates the truncation that happens when scrollTop is written against the old range", () => {
    const canvas = fakeCanvas([{ key: "0:c1.xhtml" }]);
    canvas.style.height = "2000px";
    const host = clampingHost(canvas, 600);
    host.scrollTop = 2100;
    // 先写位置会被旧上限截断；这正是必须先提交几何的原因
    expect(host.value).toBe(1400);
  });

  it("clamps legitimately when the content becomes shorter than the new range", () => {
    const oldLayout = new ContinuousChapterLayout([
      { key: "0:c1.xhtml", height: 3000, measured: true },
    ]);
    const canvas = fakeCanvas([{ key: "0:c1.xhtml" }]);
    canvas.style.height = `${oldLayout.totalHeight}px`;
    const host = clampingHost(canvas, 600);

    const { layout: newLayout, scrollTop: newS } = oldLayout.withMeasurements(
      [{ key: "0:c1.xhtml", height: 1200, measured: true }],
      { key: "0:c1.xhtml", offset: 2600, screenY: 120 },
      600,
      2400
    );
    // 书尾合法钳制：内容只有 1200 高
    expect(newS).toBe(600);
    expect(commitContinuousGeometry({ canvas, host, layout: newLayout, scrollTop: newS })).toBe(600);
  });

  it("updates every live wrapper box and ignores unknown keys", () => {
    const canvas = fakeCanvas([
      { key: "0:c1.xhtml" },
      { key: "9:gone.xhtml" },
      { key: null },
    ]);
    const layout = new ContinuousChapterLayout([
      { key: "0:c1.xhtml", height: 700, measured: true },
      { key: "1:c2.xhtml", height: 900, measured: true },
    ]);

    applyContinuousGeometry(canvas, layout);

    expect(canvas.style.height).toBe("1600px");
    expect(canvas.children[0].style.top).toBe("0px");
    expect(canvas.children[0].style.height).toBe("700px");
    // 不在布局表里的旧 wrapper 不写、不猜
    expect(canvas.children[1].style.top).toBe("");
    expect(canvas.children[1].style.height).toBe("");
    expect(canvas.children[2].style.height).toBe("");
  });
});
