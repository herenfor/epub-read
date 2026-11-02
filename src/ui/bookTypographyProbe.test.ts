import { describe, expect, it } from "vitest";
import { readTypographyFrom } from "./bookTypographyProbe";

/** A content document whose body paragraph has the given computed style. */
function contentDoc(style: Partial<CSSStyleDeclaration>, paragraphText = "第一章　春天来的时候，雪还没有化完。") {
  const paragraph = { textContent: paragraphText };
  const viewer = { querySelectorAll: () => [paragraph] };
  return {
    defaultView: { getComputedStyle: (element: unknown) => (element === paragraph ? style : { fontSize: "1px" }) },
    getElementById: () => viewer,
    body: viewer,
  } as unknown as Document;
}

describe("book typography probe", () => {
  it("reads the body paragraph's line height as a ratio, its weight and spacing", () => {
    expect(readTypographyFrom(contentDoc({ fontSize: "20px", lineHeight: "30px", fontWeight: "400", letterSpacing: "normal", wordSpacing: "0px" })))
      .toEqual({ lineHeight: 1.5, fontWeight: 400, letterSpacingPx: 0, wordSpacingPx: 0 });
    expect(readTypographyFrom(contentDoc({ fontSize: "18px", lineHeight: "normal", fontWeight: "300", letterSpacing: "1.5px", wordSpacing: "normal" })))
      .toEqual({ fontWeight: 300, letterSpacingPx: 1.5, wordSpacingPx: 0 });
  });

  it("skips headings too short to stand for the body text", () => {
    // Only a short line: the viewer itself is read instead.
    const doc = contentDoc({ fontSize: "20px", lineHeight: "36px", fontWeight: "700" }, "序");
    expect(readTypographyFrom(doc)?.fontWeight).toBeUndefined();
  });
});
