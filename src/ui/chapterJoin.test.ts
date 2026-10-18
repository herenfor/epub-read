import { describe, expect, it } from "vitest";
import { canJoinChapters, chapterFillLayoutKey, joinLaneClip, type JoinLeaves } from "./chapterJoin";

const leaves = (leading: 0 | 1, contentLeafCount: number, pageCount: number, joinable = true): JoinLeaves =>
  ({ leading, contentLeafCount, pageCount, joinable });

describe("canJoinChapters", () => {
  it("joins when the earlier chapter ends on its first page and the later one starts with the reader blank", () => {
    expect(canJoinChapters(leaves(0, 5, 3), leaves(1, 4, 3))).toBe(true);
    // A shifted earlier chapter: blank + 4 leaves also ends on a first page.
    expect(canJoinChapters(leaves(1, 4, 3), leaves(1, 3, 2))).toBe(true);
  });

  it("does not join a full last screen, an unshifted next chapter or a layout that cannot shift", () => {
    expect(canJoinChapters(leaves(0, 4, 2), leaves(1, 4, 3))).toBe(false);
    expect(canJoinChapters(leaves(0, 5, 3), leaves(0, 4, 2))).toBe(false);
    expect(canJoinChapters(leaves(0, 5, 3, false), leaves(1, 4, 3))).toBe(false);
    expect(canJoinChapters(leaves(0, 5, 3), leaves(1, 4, 3, false))).toBe(false);
  });

  it("keeps one-screen chapters on their own so a joined screen never meets the other chapter edge", () => {
    expect(canJoinChapters(leaves(0, 1, 1), leaves(1, 4, 3))).toBe(false);
    expect(canJoinChapters(leaves(0, 5, 3), leaves(1, 1, 1))).toBe(false);
  });
});

describe("joinLaneClip", () => {
  it("shows the first page on the left in LTR and on the right in RTL", () => {
    expect(joinLaneClip(0, 700, 1400, "ltr")).toBe("inset(0 700px 0 0)");
    expect(joinLaneClip(1, 690, 1400, "ltr")).toBe("inset(0 0 0 690px)");
    expect(joinLaneClip(0, 700, 1400, "rtl")).toBe("inset(0 0 0 700px)");
    expect(joinLaneClip(1, 700, 1400, "rtl")).toBe("inset(0 700px 0 0)");
  });
});

describe("chapterFillLayoutKey", () => {
  it("changes with the viewport, layout settings or text projection", () => {
    const base = chapterFillLayoutKey(1400, 800, { fontSizePx: 20 }, "v1");
    expect(chapterFillLayoutKey(1400, 800, { fontSizePx: 20 }, "v1")).toBe(base);
    expect(chapterFillLayoutKey(1300, 800, { fontSizePx: 20 }, "v1")).not.toBe(base);
    expect(chapterFillLayoutKey(1400, 800, { fontSizePx: 22 }, "v1")).not.toBe(base);
    expect(chapterFillLayoutKey(1400, 800, { fontSizePx: 20 }, "v2")).not.toBe(base);
  });
});
