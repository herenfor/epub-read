import { beforeEach, describe, expect, it } from "vitest";
import { readShelfPlaceLabel, writeShelfPlaceLabel } from "./shelfPlaceCache";

describe("shelf place cache", () => {
  const memory = new Map<string, string>();
  beforeEach(() => {
    memory.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => { memory.set(key, value); },
        removeItem: (key: string) => { memory.delete(key); },
      },
    });
  });

  it("returns the chapter name only for the position it was saved at", () => {
    writeShelfPlaceLabel("book", 6, " 第一章 诡异的住家 ");
    expect(readShelfPlaceLabel("book", 6)).toBe("第一章 诡异的住家");
    expect(readShelfPlaceLabel("book", 7)).toBeNull();
    expect(readShelfPlaceLabel("other", 6)).toBeNull();
    expect(readShelfPlaceLabel(null, 6)).toBeNull();
  });

  it("forgets the entry when the reader reaches a page outside the contents", () => {
    writeShelfPlaceLabel("book", 6, "第一章");
    writeShelfPlaceLabel("book", 0, "");
    expect(readShelfPlaceLabel("book", 6)).toBeNull();
    expect(readShelfPlaceLabel("book", 0)).toBeNull();
  });

  it("ignores damaged storage", () => {
    memory.set("epub-reader-shelf-place-v1", "{not json");
    expect(readShelfPlaceLabel("book", 0)).toBeNull();
    memory.set("epub-reader-shelf-place-v1", JSON.stringify({ book: { spineIndex: -1, label: "x" } }));
    expect(readShelfPlaceLabel("book", -1)).toBeNull();
  });
});
