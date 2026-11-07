import { describe, expect, it } from "vitest";
import { highlightAtSelection, parseHexInput } from "./highlightModel";
import { DEFAULT_HIGHLIGHT_PREFERENCES, parseHighlightPreferences } from "./highlightPreferences";

const at = (id: string, start: number, end: number, extra: Partial<{ chapterPath: string; spineIndex: number }> = {}) =>
  ({ id, content: "", spineIndex: 0, chapterPath: "c0.xhtml", startTextOffset: start, endTextOffset: end, ...extra });
const sel = (start: number, end: number) => ({ chapterPath: "c0.xhtml", startTextOffset: start, endTextOffset: end });

describe("highlight under a selection", () => {
  it("matches only a selection entirely inside one highlight of the same chapter, narrowest first", () => {
    const notes = [at("wide", 0, 100), at("narrow", 10, 30), at("other", 10, 30, { spineIndex: 1, chapterPath: "c1.xhtml" })];
    expect(highlightAtSelection(notes, sel(12, 20), 0)?.id).toBe("narrow");
    expect(highlightAtSelection(notes, sel(10, 30), 0)?.id).toBe("narrow");
    expect(highlightAtSelection(notes, sel(40, 60), 0)?.id).toBe("wide");
    // Crossing the narrow highlight's edge inside the wide one is plain text.
    expect(highlightAtSelection(notes, sel(25, 40), 0)).toBeNull();
    expect(highlightAtSelection(notes, sel(5, 35), 0)).toBeNull();
    expect(highlightAtSelection([at("a", 0, 10), at("b", 10, 20)], sel(10, 15), 0)?.id).toBe("b");
    expect(highlightAtSelection(notes, sel(90, 120), 0)).toBeNull();
    expect(highlightAtSelection([at("a", 10, 30)], sel(5, 20), 0)).toBeNull();
    expect(highlightAtSelection([notes[2]], sel(12, 20), 0)).toBeNull();
  });

  it("reads typed hex colors in the usual forms", () => {
    expect(parseHexInput("#D9691F")).toBe("#d9691f");
    expect(parseHexInput(" d9691f ")).toBe("#d9691f");
    expect(parseHexInput("#abc")).toBe("#aabbcc");
    expect(parseHexInput("#12345")).toBeNull();
    expect(parseHexInput("red")).toBeNull();
  });
});

describe("local highlight preferences", () => {
  it("falls back field by field and keeps colors lowercase", () => {
    expect(parseHighlightPreferences(null)).toEqual(DEFAULT_HIGHLIGHT_PREFERENCES);
    expect(parseHighlightPreferences("{oops")).toEqual(DEFAULT_HIGHLIGHT_PREFERENCES);
    expect(parseHighlightPreferences(JSON.stringify({ style: "squiggly", color: "#AABBCC", custom: "#D9691F" })))
      .toEqual({ style: "squiggly", color: "#aabbcc", custom: "#d9691f" });
    expect(parseHighlightPreferences(JSON.stringify({ style: "bold", color: "pink", custom: "orange" })))
      .toEqual(DEFAULT_HIGHLIGHT_PREFERENCES);
  });
});
