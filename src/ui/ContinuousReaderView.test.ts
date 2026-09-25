import { describe, expect, it } from "vitest";
import { ContinuousChapterLayout } from "./continuousChapterLayout";

describe("ContinuousReaderView layout and projection integration", () => {
  it("projects single host scroll position across multiple linear chapters without chapter reload", () => {
    // 模拟 3 个线性章节，高度分别为 800, 1200, 600
    const extents = [
      { key: "0:c1.xhtml", height: 800, measured: true },
      { key: "1:c2.xhtml", height: 1200, measured: true },
      { key: "2:c3.xhtml", height: 600, measured: true },
    ];
    const layout = new ContinuousChapterLayout(extents);
    const V = 600;

    // 视口在章缝处：S = 700（跨越 c1 末尾 100px 与 c2 开头 500px）
    const proj = layout.project(700, V, 0);
    expect(proj).toHaveLength(2);

    const [p0, p1] = proj;
    // c1: top=0, height=800, S=700, V=600
    // I = clamp(700 - 0, 0, max(0, 800 - 600 = 200)) = 200
    expect(p0.box.key).toBe("0:c1.xhtml");
    expect(p0.frameOffset).toBe(200);
    expect(p0.innerScrollTop).toBe(200);
    // 屏幕上 c1 占用 [0, 100px)
    expect(p0.frameScreenTop).toBe(-500); // B + I - S = 0 + 200 - 700 = -500
    expect(p0.clipTop).toBe(500);
    expect(p0.clipBottom).toBe(600);
    expect(p0.frameScreenTop + p0.clipTop).toBe(0);
    expect(p0.frameScreenTop + p0.clipBottom).toBe(100);

    // c2: top=800, height=1200, S=700, V=600
    // I = clamp(700 - 800 = -100, 0, 600) = 0
    expect(p1.box.key).toBe("1:c2.xhtml");
    expect(p1.frameOffset).toBe(0);
    expect(p1.innerScrollTop).toBe(0);
    // 屏幕上 c2 占用 [100px, 600px)
    expect(p1.frameScreenTop).toBe(100); // 800 + 0 - 700 = 100
    expect(p1.clipTop).toBe(0);
    expect(p1.clipBottom).toBe(500);
    expect(p1.frameScreenTop + p1.clipTop).toBe(100);
    expect(p1.frameScreenTop + p1.clipBottom).toBe(600);
  });

  it("handles short chapters (80-150px) without stretching them to clientHeight", () => {
    // 视口 600px 内同时容纳 3 个短章
    const shortExtents = [
      { key: "0:short1.xhtml", height: 100, measured: true },
      { key: "1:short2.xhtml", height: 120, measured: true },
      { key: "2:short3.xhtml", height: 80, measured: true },
      { key: "3:c4.xhtml", height: 1000, measured: true },
    ];
    const layout = new ContinuousChapterLayout(shortExtents);
    const V = 600;

    // S = 0：短章 1、2、3 总高 300px，全部在第一屏内
    const proj = layout.project(0, V, 0);
    expect(proj.length).toBeGreaterThanOrEqual(3);
    expect(proj[0].box.key).toBe("0:short1.xhtml");
    expect(proj[0].box.height).toBe(100);
    expect(proj[1].box.key).toBe("1:short2.xhtml");
    expect(proj[1].box.height).toBe(120);
    expect(proj[2].box.key).toBe("2:short3.xhtml");
    expect(proj[2].box.height).toBe(80);

    // 第 4 章也在此屏露出一部分 (从 300px 到 600px)
    expect(proj[3].box.key).toBe("3:c4.xhtml");
    expect(proj[3].frameScreenTop).toBe(300);
  });

  it("high performance mode only expands cache window (0.5V -> 1.5V) without altering navigation coordinates", () => {
    const extents = Array.from({ length: 10 }, (_, i) => ({
      key: `${i}:c${i}.xhtml`,
      height: 600,
      measured: true,
    }));
    const layout = new ContinuousChapterLayout(extents);
    const V = 600;
    const S = 1800; // 停在第 4 章 (c3: [1800, 2400))

    // 普通模式：overscan = 0.5V (300px)
    // 可见 [1800, 2400], 缓冲窗口 [1500, 2700]
    // 覆盖 c2 [1200, 1800), c3 [1800, 2400), c4 [2400, 3000)
    const normalProj = layout.project(S, V, 0.5 * V);
    const normalKeys = normalProj.map((p) => p.box.key);
    expect(normalKeys).toEqual(["2:c2.xhtml", "3:c3.xhtml", "4:c4.xhtml"]);

    // 高性能模式：overscan = 1.5V (900px)
    // 缓冲窗口 [900, 3300]
    // 覆盖 c1, c2, c3, c4, c5
    const highPerfProj = layout.project(S, V, 1.5 * V);
    const highPerfKeys = highPerfProj.map((p) => p.box.key);
    expect(highPerfKeys).toEqual([
      "1:c1.xhtml",
      "2:c2.xhtml",
      "3:c3.xhtml",
      "4:c4.xhtml",
      "5:c5.xhtml",
    ]);

    // 当前章的核心投影完全一致，不随模式切换改变
    const normalC3 = normalProj.find((p) => p.box.key === "3:c3.xhtml")!;
    const highPerfC3 = highPerfProj.find((p) => p.box.key === "3:c3.xhtml")!;
    expect(normalC3.frameOffset).toBe(highPerfC3.frameOffset);
    expect(normalC3.innerScrollTop).toBe(highPerfC3.innerScrollTop);
    expect(normalC3.frameScreenTop).toBe(highPerfC3.frameScreenTop);
  });

  it("exposes a committed box per key and nothing for unknown keys (geometry DOM mapping)", () => {
    const layout = new ContinuousChapterLayout([
      { key: "0:a.xhtml", height: 640, measured: true },
      { key: "1:b.xhtml", height: 1200, measured: true },
    ]);
    expect(layout.boxFor("1:b.xhtml")).toMatchObject({ index: 1, top: 640, height: 1200 });
    expect(layout.boxFor("2:gone.xhtml")).toBeNull();
  });

  it("restores a re-resolved content anchor at the same screen line after a width reflow", () => {
    // 宽度变化触发正文换行：同一 textOffset 从章内 900 变成 1180
    const before = new ContinuousChapterLayout([{ key: "0:a.xhtml", height: 2400, measured: true }]);
    const V = 800;
    const screenY = 160;
    const anchorBefore = { key: "0:a.xhtml", offset: 900, screenY };
    // 旧几何下的宿主位置
    expect(before.scrollTopFor(anchorBefore, V)).toBe(740);
    expect(before.boxes[0].top + 900 - 740).toBe(screenY);

    const after = new ContinuousChapterLayout([{ key: "0:a.xhtml", height: 3000, measured: true }]);
    const restored = after.scrollTopFor({ ...anchorBefore, offset: 1180 }, V);
    // 同一屏幕行：章首偏移 + 新章内坐标 - 新宿主位置 = 旧 screenY
    expect(restored).toBe(1020);
    expect(after.boxes[0].top + 1180 - restored!).toBe(screenY);
  });

  it("keeps the anchor's screen line when content above it grows near the book tail", () => {
    const before = new ContinuousChapterLayout([
      { key: "0:c1.xhtml", height: 1000, measured: true },
      { key: "1:c2.xhtml", height: 1000, measured: true },
    ]);
    const V = 600;
    // 旧范围上限 1400；当前 1300 已接近书尾
    expect(before.maxScrollTop(V)).toBe(1400);
    const anchor = { key: "1:c2.xhtml", offset: 600, screenY: 300 };

    const { layout: after, scrollTop: S } = before.withMeasurements(
      [{ key: "0:c1.xhtml", height: 1800, measured: true }],
      anchor,
      V,
      1300
    );
    // 目标位置超出旧上限、但落在新上限内：只能先提交新几何再写 scrollTop
    expect(S).toBe(2100);
    expect(after.maxScrollTop(V)).toBe(2200);
    expect(after.boxes[1].top + anchor.offset - S).toBe(300);
  });
});
