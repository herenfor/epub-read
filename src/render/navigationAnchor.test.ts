import { describe, expect, it } from "vitest";
import { adaptNavigationAnchor } from "./navigationAnchor";

describe("navigation anchor adaptation", () => {
  it("keeps a valid persisted text anchor instead of dropping it as undefined textOffset", () => {
    expect(adaptNavigationAnchor({
      index: -1,
      ratio: 0,
      anchorTextOffset: 12,
      anchorTextSnippet: "正文",
    })).toEqual({
      index: -1,
      ratio: 0,
      charsRead: 12,
      totalChars: 0,
      textOffset: 12,
      textSnippet: "正文",
    });
  });

  it("falls back to legacy index/ratio only when both text fields are absent", () => {
    expect(adaptNavigationAnchor({
      index: 4,
      ratio: 0.5,
      anchorTextOffset: null,
      anchorTextSnippet: null,
    })).toMatchObject({ index: 4, ratio: 0.5, textOffset: null });
    expect(adaptNavigationAnchor({
      index: -1,
      ratio: 0,
      anchorTextOffset: null,
      anchorTextSnippet: null,
    })).toBeNull();
  });

  it("discards a hostile snippet/offset pair as a whole", () => {
    expect(adaptNavigationAnchor({
      index: -1,
      ratio: 0,
      anchorTextOffset: 12,
      anchorTextSnippet: "包含 空白",
    })).toBeNull();
  });
});
