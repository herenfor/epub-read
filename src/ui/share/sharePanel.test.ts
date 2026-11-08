import { describe, expect, it } from "vitest";
import { parseShareOptions } from "./shareOptions";
import { shareActions, shareFileName } from "./shareOutput";
import { DEFAULT_SHARE_OPTIONS } from "./shareCardModel";
import { closeReaderForeground, openReaderPanel, openShareSheet } from "../readerForeground";
import { readerForegroundSurfaces } from "../useReaderForeground";

describe("share panel model", () => {
  it("reads saved choices field by field and falls back on anything malformed", () => {
    expect(parseShareOptions(null)).toEqual(DEFAULT_SHARE_OPTIONS);
    expect(parseShareOptions("{bad")).toEqual(DEFAULT_SHARE_OPTIONS);
    expect(parseShareOptions(JSON.stringify({ template: "night", ratio: "9:16", showBrand: false, showNote: "yes" })))
      .toEqual({ ...DEFAULT_SHARE_OPTIONS, template: "night", ratio: "9:16", showBrand: false });
    expect(parseShareOptions(JSON.stringify({ template: "neon", ratio: "2:1" }))).toEqual(DEFAULT_SHARE_OPTIONS);
  });

  it("offers each platform its actions, the main one last", () => {
    expect(shareActions("desktop", { clipboardImage: true })).toEqual(["copyText", "copyImage", "saveImage"]);
    expect(shareActions("desktop", { clipboardImage: false })).toEqual(["copyText", "saveImage"]);
    expect(shareActions("browser", { clipboardImage: true })).toEqual(["copyText", "copyImage", "saveImage"]);
    expect(shareActions("android", { clipboardImage: true, androidNative: true })).toEqual(["copyText", "saveGallery", "share"]);
    expect(shareActions("android", { clipboardImage: false })).toEqual(["copyText", "saveGallery", "share"]);
    // A caller can still explicitly disable the native actions.
    expect(shareActions("android", { clipboardImage: true, androidNative: false })).toEqual(["copyText"]);
  });

  it("names the PNG after the book with characters every file system accepts", () => {
    const day = new Date(2026, 10, 8);
    expect(shareFileName("呐喊", day)).toBe("SeLis-呐喊-20261108.png");
    expect(shareFileName("A/B: C?*", day)).toBe("SeLis-A B C-20261108.png");
    expect(shareFileName("  ", day)).toBe("SeLis-20261108.png");
  });

  it("is a modal foreground: panels cannot open over it and closing clears it", () => {
    const draft = { quote: "路。", note: "", spineIndex: 2 };
    const open = openShareSheet({ kind: "none" }, draft);
    expect(readerForegroundSurfaces(open).shareDraft).toEqual(draft);
    expect(openReaderPanel(open, "toc")).toBe(open);
    expect(readerForegroundSurfaces(closeReaderForeground()).shareDraft).toBeNull();
  });
});
