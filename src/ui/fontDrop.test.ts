import { describe, expect, it, vi } from "vitest";
import { createDragDepthTracker, isPhysicalPointInsideRect, isSupportedFontFileName, partitionFontItems, runFontImportBatch } from "./fontDrop";

describe("font drop helpers", () => {
  it("accepts the same four formats case-insensitively", () => {
    expect(["a.ttf", "b.OTF", "c.woff", "d.WoFf2"].every(isSupportedFontFileName)).toBe(true);
    expect(isSupportedFontFileName("book.epub")).toBe(false);
  });

  it("separates unsupported files without dropping supported fonts", () => {
    const result = partitionFontItems([{ name: "a.ttf" }, { name: "notes.txt" }, { name: "b.otf" }], (item) => item.name);
    expect(result.supported.map((item) => item.name)).toEqual(["a.ttf", "b.otf"]);
    expect(result.unsupported.map((item) => item.name)).toEqual(["notes.txt"]);
  });

  it("keeps nested dragleave active until the outer target leaves", () => {
    const tracker = createDragDepthTracker();
    expect(tracker.enter()).toBe(true);
    expect(tracker.enter()).toBe(true);
    expect(tracker.leave()).toBe(true);
    expect(tracker.leave()).toBe(false);
  });

  it("imports a batch strictly in order", async () => {
    const events: string[] = [];
    const importOne = vi.fn(async (name: string) => {
      events.push(`start:${name}`);
      await Promise.resolve();
      events.push(`end:${name}`);
    });
    await runFontImportBatch(["a", "b"], importOne);
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("maps the native physical drop position into the CSS panel bounds", () => {
    const rect = { left: 0, right: 360, top: 0, bottom: 700 };
    expect(isPhysicalPointInsideRect({ x: 540, y: 300 }, 1.5, rect)).toBe(true);
    expect(isPhysicalPointInsideRect({ x: 600, y: 300 }, 1.5, rect)).toBe(false);
  });
});
