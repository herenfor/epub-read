import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COVER_URL_BUDGET_BYTES,
  acquireCoverUrl,
  clearCoverUrlCacheForTests,
  coverUrlCacheSize,
  forgetCoverUrls,
  peekCoverUrl,
  storeCoverUrl,
} from "./coverUrlCache";

describe("coverUrlCache", () => {
  let revoked: string[];

  beforeEach(() => {
    revoked = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
      revoked.push(url);
    });
  });

  afterEach(() => {
    clearCoverUrlCacheForTests();
    vi.restoreAllMocks();
  });

  it("书架重新挂载时直接拿到上次的封面", () => {
    const held = storeCoverUrl("a", "blob:a", 100);
    held.release();
    expect(peekCoverUrl("a")).toBe("blob:a");
    const again = acquireCoverUrl("a");
    expect(again?.url).toBe("blob:a");
    expect(revoked).toEqual([]);
  });

  it("超出预算时先丢最久没用的，正在显示的不丢", () => {
    const half = COVER_URL_BUDGET_BYTES / 2;
    const shown = storeCoverUrl("shown", "blob:shown", half);
    storeCoverUrl("old", "blob:old", half).release();
    storeCoverUrl("new", "blob:new", half).release();
    expect(revoked).toEqual(["blob:old"]);
    expect(peekCoverUrl("shown")).toBe("blob:shown");
    expect(peekCoverUrl("new")).toBe("blob:new");
    shown.release();
    expect(coverUrlCacheSize().bytes).toBeLessThanOrEqual(COVER_URL_BUDGET_BYTES);
  });

  it("同一封面同时读完时只留一个地址", () => {
    const first = storeCoverUrl("a", "blob:first", 100);
    const second = storeCoverUrl("a", "blob:second", 100);
    expect(second.url).toBe("blob:first");
    expect(revoked).toEqual(["blob:second"]);
    first.release();
    second.release();
    second.release();
    expect(coverUrlCacheSize()).toEqual({ count: 1, bytes: 100 });
  });

  it("移走的书只丢它自己没在显示的封面", () => {
    storeCoverUrl("book-a|hash|image/jpeg|", "blob:a", 100).release();
    const shown = storeCoverUrl("book-a|hash|image/png|", "blob:a-shown", 100);
    storeCoverUrl("book-b|hash|image/jpeg|", "blob:b", 100).release();
    forgetCoverUrls("book-a|");
    expect(revoked).toEqual(["blob:a"]);
    expect(peekCoverUrl("book-a|hash|image/png|")).toBe("blob:a-shown");
    expect(peekCoverUrl("book-b|hash|image/jpeg|")).toBe("blob:b");
    shown.release();
  });
});
