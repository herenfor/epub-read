import { describe, expect, it } from "vitest";
import {
  EMPTY_READER_TABS,
  activeReaderTabs,
  closeReaderTab,
  cycleReaderTab,
  openReaderTab,
  parseReaderTabs,
  pruneReaderTabs,
  serializeReaderTabs,
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
});
