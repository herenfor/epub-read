import { describe, expect, it } from "vitest";
import {
  createContentAxis,
  displayedScrubRatio,
  initialScrubUi,
  labelProgressPct,
  reduceScrubUi,
  type AxisInput,
} from "./readerProgressAxis";

describe("readerProgressAxis (Section 5 Check 1)", () => {
  it("长度悬殊的两章：正确映射与正反还原", () => {
    const inputs: AxisInput[] = [
      { key: "0:ch1.xhtml", spineIndex: 0, weight: 10 },
      { key: "1:ch2.xhtml", spineIndex: 1, weight: 90 },
    ];
    const axis = createContentAxis(inputs);
    expect(axis.segments.length).toBe(2);
    expect(axis.segments[0].start).toBe(0);
    expect(axis.segments[0].end).toBe(0.1);
    expect(axis.segments[1].start).toBe(0.1);
    expect(axis.segments[1].end).toBe(1.0);

    // 0.05 位于第一章中点
    const loc1 = axis.locate(0.05);
    expect(loc1?.key).toBe("0:ch1.xhtml");
    expect(loc1?.fraction).toBeCloseTo(0.5, 5);
    const r1 = axis.ratioAt({ key: loc1!.key, fraction: loc1!.fraction });
    expect(r1).toBeCloseTo(0.05, 5);

    // 0.55 位于第二章中点：(0.55 - 0.1) / 0.9 = 0.5
    const loc2 = axis.locate(0.55);
    expect(loc2?.key).toBe("1:ch2.xhtml");
    expect(loc2?.fraction).toBeCloseTo(0.5, 5);
    const r2 = axis.ratioAt({ key: loc2!.key, fraction: loc2!.fraction });
    expect(r2).toBeCloseTo(0.55, 5);
  });

  it("单章书：整个区间为 0..1", () => {
    const inputs: AxisInput[] = [{ key: "0:single.xhtml", spineIndex: 0, weight: 500 }];
    const axis = createContentAxis(inputs);
    expect(axis.segments.length).toBe(1);
    expect(axis.segments[0].start).toBe(0);
    expect(axis.segments[0].end).toBe(1);

    const loc = axis.locate(0.35);
    expect(loc?.key).toBe("0:single.xhtml");
    expect(loc?.fraction).toBeCloseTo(0.35, 5);
    expect(axis.ratioAt(loc!)).toBeCloseTo(0.35, 5);
  });

  it("零权重与全零处理：不占区间，全零返回空轴", () => {
    const inputs: AxisInput[] = [
      { key: "0:empty.xhtml", spineIndex: 0, weight: 0 },
      { key: "1:real.xhtml", spineIndex: 1, weight: 200 },
    ];
    const axis = createContentAxis(inputs);
    expect(axis.segments.length).toBe(1);
    expect(axis.segments[0].key).toBe("1:real.xhtml");
    expect(axis.segments[0].start).toBe(0);
    expect(axis.segments[0].end).toBe(1);

    const allZero = createContentAxis([{ key: "0:a.xhtml", spineIndex: 0, weight: 0 }]);
    expect(allZero.segments.length).toBe(0);
    expect(allZero.locate(0.5)).toBeNull();
    expect(allZero.ratioAt({ key: "0:a.xhtml", fraction: 0.5 })).toBeNull();
  });

  it("精确接缝归下一章，100% 归最后非空章末", () => {
    const inputs: AxisInput[] = [
      { key: "0:c1.xhtml", spineIndex: 0, weight: 50 },
      { key: "1:c2.xhtml", spineIndex: 1, weight: 50 },
    ];
    const axis = createContentAxis(inputs);
    // 接缝 0.5 归下一章起点
    const seam = axis.locate(0.5);
    expect(seam?.key).toBe("1:c2.xhtml");
    expect(seam?.fraction).toBe(0);

    // 0 归第一章起点
    const start = axis.locate(0);
    expect(start?.key).toBe("0:c1.xhtml");
    expect(start?.fraction).toBe(0);

    // 1.0 归第二章末尾
    const end = axis.locate(1.0);
    expect(end?.key).toBe("1:c2.xhtml");
    expect(end?.fraction).toBe(1);
  });

  it("0/1 正反映射一致性", () => {
    const inputs: AxisInput[] = [
      { key: "0:c1.xhtml", spineIndex: 0, weight: 100 },
      { key: "1:c2.xhtml", spineIndex: 1, weight: 100 },
    ];
    const axis = createContentAxis(inputs);

    const loc0 = axis.locate(0)!;
    expect(loc0.fraction).toBe(0);
    expect(axis.ratioAt(loc0)).toBe(0);

    const loc1 = axis.locate(1)!;
    expect(loc1.fraction).toBe(1);
    expect(axis.ratioAt(loc1)).toBe(1);
  });

  it("reduceScrubUi: UI token 旧结果不能清除新 pending，合法 0 可提交", () => {
    let state = initialScrubUi(1);
    expect(displayedScrubRatio(state)).toBeNull();

    // 1. 提交合法 0：应该接受并展示 0，而不是拒绝归零
    state = reduceScrubUi(state, {
      type: "begin",
      token: { session: 1, request: 1 },
      ratio: 0,
    });
    expect(state.pending?.ratio).toBe(0);
    expect(displayedScrubRatio(state)).toBe(0);

    // pending 期间普通 sample 不覆盖 pending
    state = reduceScrubUi(state, {
      type: "sample",
      session: 1,
      actual: { ratio: 0.3, atEnd: false },
    });
    expect(displayedScrubRatio(state)).toBe(0);

    // 请求 1 成功结算为 0
    state = reduceScrubUi(state, {
      type: "settled",
      token: { session: 1, request: 1 },
      actual: { ratio: 0, atEnd: false },
    });
    expect(state.pending).toBeNull();
    expect(state.actual?.ratio).toBe(0);
    expect(displayedScrubRatio(state)).toBe(0);
    expect(labelProgressPct(state.actual!)).toBe(0);

    // 2. 发起请求 2 (ratio 0.65)
    state = reduceScrubUi(state, {
      type: "begin",
      token: { session: 1, request: 2 },
      ratio: 0.65,
    });
    expect(state.pending?.request).toBe(2);

    // 旧请求 1 迟到的 settled/failed 回执不能清除请求 2 的 pending
    state = reduceScrubUi(state, {
      type: "settled",
      token: { session: 1, request: 1 },
      actual: { ratio: 0.1, atEnd: false },
    });
    expect(state.pending?.request).toBe(2);
    expect(displayedScrubRatio(state)).toBe(0.65);

    // 请求 2 结算为真实落点 0.648
    state = reduceScrubUi(state, {
      type: "settled",
      token: { session: 1, request: 2 },
      actual: { ratio: 0.648, atEnd: false },
    });
    expect(state.pending).toBeNull();
    expect(state.actual?.ratio).toBe(0.648);
    expect(displayedScrubRatio(state)).toBe(0.648);
  });

  it("labelProgressPct: 未到书尾即使 99.6% 也不显示 100%，书尾才显示 100%", () => {
    expect(labelProgressPct({ ratio: 0.996, atEnd: false })).toBe(99);
    expect(labelProgressPct({ ratio: 1.0, atEnd: false })).toBe(99);
    expect(labelProgressPct({ ratio: 0.996, atEnd: true })).toBe(100);
    expect(labelProgressPct({ ratio: 1.0, atEnd: true })).toBe(100);
  });
});
