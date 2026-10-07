import { describe, expect, it } from "vitest";
import type { ShelfEntry } from "./shelf";
import { projectShelfProgressReadiness, shelfProgressLabel } from "./shelfProgressDisplay";

function entry(patch: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    id: "book", contentHash: "hash", title: "长正文", creator: "", fileName: "book.epub",
    fileSize: 1, coverMime: "", addedAtMs: 1, lastReadAtMs: 2, spineIndex: 12, page: 3,
    progressPct: 0, anchorIndex: null, anchorRatio: null, anchorTextOffset: 20, isNew: false,
    ...patch,
  };
}

describe("shelf progress readiness", () => {
  it("shows pending without changing the persisted position or mutating the source row", () => {
    const original = entry();
    const [shown] = projectShelfProgressReadiness([original], new Set());
    expect(shelfProgressLabel(shown, " 已读")).toBe("待统计");
    expect(shown.spineIndex).toBe(12);
    expect(shown.anchorTextOffset).toBe(20);
    expect(shown.progressPct).toBe(0);
    expect(original).not.toHaveProperty("progressPctPending");
    const [ready] = projectShelfProgressReadiness([original], new Set(["hash"]));
    expect(shelfProgressLabel(ready)).toBe("0%");
  });

  it("keeps an existing percentage even while full-book statistics are unavailable", () => {
    const original = entry({ progressPct: 42 });
    const [shown] = projectShelfProgressReadiness([original], new Set());
    expect(shown).toBe(original);
    expect(shelfProgressLabel(shown, " 已读")).toBe("42% 已读");
  });

  it("does not label a genuinely unread book as pending", () => {
    const original = entry({ isNew: true, lastReadAtMs: 0, spineIndex: 0, page: 0, anchorTextOffset: null });
    const [shown] = projectShelfProgressReadiness([original], new Set());
    expect(shown).toBe(original);
    expect(shelfProgressLabel(shown)).toBe("0%");
  });
});
