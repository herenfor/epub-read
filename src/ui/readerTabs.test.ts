import { describe, expect, it } from "vitest";
import {
  EMPTY_READER_TABS,
  MAX_READER_TABS,
  activeReaderTabs,
  closeReaderTab,
  cycleReaderTab,
  fitReaderTabs,
  openReaderTab,
  parseReaderTabs,
  placeReaderTab,
  pruneReaderTabs,
  serializeReaderTabs,
  shortTabTitle,
  splitTabTitle,
} from "./readerTabs";

const open = (...ids: string[]) => ids.reduce(openReaderTab, EMPTY_READER_TABS);

describe("reader tabs (A11 V1)", () => {
  it("opens new books to the right of the current tab and focuses existing ones", () => {
    let state = open("a", "b");
    expect(activeReaderTabs(state)).toEqual({ tabs: ["a", "b"], active: "b" });
    state = openReaderTab(state, "a");
    expect(activeReaderTabs(state)).toEqual({ tabs: ["a", "b"], active: "a" });
    state = openReaderTab(state, "c");
    expect(activeReaderTabs(state)).toEqual({ tabs: ["a", "c", "b"], active: "c" });
  });

  it("closing the current tab moves right, then left, and the last one returns null", () => {
    const state = openReaderTab(open("a", "b", "c"), "b");
    const right = closeReaderTab(state, "b");
    expect(right.next).toBe("c");
    expect(activeReaderTabs(right.state).tabs).toEqual(["a", "c"]);
    const left = closeReaderTab(right.state, "c");
    expect(left.next).toBe("a");
    expect(closeReaderTab(left.state, "a").next).toBeNull();
  });

  it("closing another tab keeps the current book", () => {
    const { state, next } = closeReaderTab(open("a", "b"), "a");
    expect(next).toBe("b");
    expect(activeReaderTabs(state)).toEqual({ tabs: ["b"], active: "b" });
  });

  it("cycles in both directions", () => {
    const state = open("a", "b", "c");
    expect(cycleReaderTab(state, 1)).toBe("a");
    expect(cycleReaderTab(state, -1)).toBe("b");
    expect(cycleReaderTab(EMPTY_READER_TABS, 1)).toBeNull();
  });

  it("drops books that left the shelf", () => {
    const state = pruneReaderTabs(open("a", "b", "c"), (id) => id !== "c");
    expect(activeReaderTabs(state)).toEqual({ tabs: ["a", "b"], active: "a" });
  });

  it("round-trips and treats unreadable data as no tabs", () => {
    const state = open("a", "b");
    expect(parseReaderTabs(serializeReaderTabs(state))).toEqual(state);
    expect(parseReaderTabs("not json")).toEqual(EMPTY_READER_TABS);
    expect(parseReaderTabs(JSON.stringify({ groups: [{ tabs: ["a", "a", 3], active: "x" }], activeGroup: 9 })))
      .toEqual({ groups: [{ tabs: ["a"], active: "a" }], activeGroup: 0 });
  });

  it("an ordinary open replaces the current book; a new tab goes to its right until the limit", () => {
    let state = open("a", "b");
    state = placeReaderTab(state, "c", "replace");
    expect(activeReaderTabs(state)).toEqual({ tabs: ["a", "c"], active: "c" });
    state = placeReaderTab(state, "a", "replace");
    expect(activeReaderTabs(state)).toEqual({ tabs: ["a", "c"], active: "a" });
    state = placeReaderTab(state, "d", "new");
    expect(activeReaderTabs(state)).toEqual({ tabs: ["a", "d", "c"], active: "d" });
    expect(activeReaderTabs(placeReaderTab(EMPTY_READER_TABS, "x", "replace"))).toEqual({ tabs: ["x"], active: "x" });
    const full = open("a", "b", "c", "d", "e");
    expect(activeReaderTabs(full).tabs).toHaveLength(MAX_READER_TABS);
    // Full: a new tab takes the current one's place instead of growing past the limit.
    expect(activeReaderTabs(placeReaderTab(full, "f", "new"))).toEqual({ tabs: ["a", "b", "c", "d", "f"], active: "f" });
  });

  it("keeps the current book and its neighbours when stored tabs exceed the limit", () => {
    const raw = JSON.stringify({ v: 1, groups: [{ tabs: ["a", "b", "c", "d", "e", "f", "g", "h"], active: "g" }], activeGroup: 0 });
    expect(activeReaderTabs(parseReaderTabs(raw))).toEqual({ tabs: ["d", "e", "f", "g", "h"], active: "g" });
  });

  it("shortens titles in the middle, drops bracket prefixes and keeps the volume number", () => {
    expect(shortTabTitle("【测试专用】[小林湖底].家里蹲吸血姬的郁闷.03", 9)).toBe("家里蹲…郁闷 03");
    expect(shortTabTitle("家里蹲吸血姬的郁闷 3", 8)).toBe("家里蹲…郁闷 3");
    expect(shortTabTitle("记忆的琴键", 8)).toBe("记忆的琴键");
    expect(shortTabTitle("【测试专用】", 8)).toBe("【测试专用】");
    expect(splitTabTitle("【测试专用】[小林湖底].家里蹲吸血姬的郁闷.03")).toEqual({ head: "家里蹲吸血姬的郁闷", tail: "03" });
    expect(splitTabTitle("男女之间存在纯友情吗？（不，不存在！）3")).toEqual({ head: "男女之间存在纯友情吗？（不，不存在！）", tail: "3" });
    expect(splitTabTitle("2001")).toEqual({ head: "2001", tail: "" });
  });

  it("narrows tabs first, then folds the ones farthest from the current book into +N", () => {
    const extras = { plus: 28, more: 48, gap: 2 };
    const tabs = ["a", "b", "c", "d", "e"];
    expect(fitReaderTabs(tabs, "c", 0, extras)).toEqual({ visible: tabs, hidden: [] });
    expect(fitReaderTabs(tabs, "c", 1000, extras).hidden).toEqual([]);
    // 128 + 2 × 96 + 28 + 48 + gaps fits three: the current book and its two neighbours.
    expect(fitReaderTabs(tabs, "c", 410, extras)).toEqual({ visible: ["b", "c", "d"], hidden: ["a", "e"] });
    expect(fitReaderTabs(tabs, "a", 410, extras)).toEqual({ visible: ["a", "b", "c"], hidden: ["d", "e"] });
    // However narrow, the current book stays out.
    expect(fitReaderTabs(tabs, "e", 100, extras)).toEqual({ visible: ["e"], hidden: ["a", "b", "c", "d"] });
  });
});
