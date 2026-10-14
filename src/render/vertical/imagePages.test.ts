import { describe, expect, it } from "vitest";
import { buildVerticalPageModel } from "./pageModel";
import { buildVerticalChapterModel, fitVerticalImage, locateVerticalImage, verticalChapterPageAt, type VerticalImageBox } from "./imagePages";

const image = (start: number, width = 100, index = 0, signature = "entry:Images/art.png"): VerticalImageBox => ({
  start, end: start + width, naturalWidth: 1200, naturalHeight: 1800,
  anchor: { index, signature, tag: "img", ratio: 0.5 },
});

describe("vertical independent image leaves", () => {
  it("uses contain for landscape and tall images without clipping or rotation", () => {
    expect(fitVerticalImage(1200, 600, 300, 400)).toEqual({ width: 300, height: 150, left: 0, top: 125 });
    expect(fitVerticalImage(600, 2400, 300, 400)).toEqual({ width: 100, height: 400, left: 100, top: 0 });
    expect(fitVerticalImage(0, 2400, 300, 400)).toBeNull();
    expect(() => fitVerticalImage(1200, 600, 0, 400)).toThrow(RangeError);
  });

  it("keeps consecutive images as independent leaves even when the text model is empty", () => {
    const model = buildVerticalChapterModel(buildVerticalPageModel([], 100), [image(100, 100, 1), image(0)], 150);
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    expect(model.pages.map(p => [p.kind, p.start, p.end])).toEqual([["image", 0, 100], ["image", 100, 200]]);
    expect(verticalChapterPageAt(model, 100)).toBe(1);
    expect(verticalChapterPageAt(model, 200)).toBe(1);
    expect(locateVerticalImage(model, image(100, 100, 1).anchor)).toMatchObject({ status: "located", page: 1 });
  });

  it("separates text and full-page images and remaps text logical positions into the combined model", () => {
    const text = buildVerticalPageModel([{ start: 0, end: 20 }, { start: 200, end: 220 }], 100);
    const model = buildVerticalChapterModel(text, [image(100)], 150);
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    expect(model.pages.map(p => p.kind)).toEqual(["text", "image", "text"]);
    expect(model.pages[0]).toMatchObject({ start: 0, end: 20, blankAfter: 80 });
    expect(verticalChapterPageAt(model, 0)).toBe(0);
    expect(verticalChapterPageAt(model, 210)).toBe(2);
    expect(verticalChapterPageAt(model, 50)).toBeNull();
    expect(locateVerticalImage(model, image(100).anchor)).toMatchObject({ status: "located", page: 1, imageY: 75 });
  });

  it("keeps semantic whitespace inside a text segment without inventing a trailing empty page before an image", () => {
    const model = buildVerticalChapterModel(buildVerticalPageModel([{ start: 0, end: 20 }, { start: 300, end: 320 }], 100), [image(600)], 150);
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    expect(model.pages.map(p => p.end)).toEqual([100, 200, 300, 320, 700]);
    expect(model.pages.at(-1)?.kind).toBe("image");
  });

  it("does not call unloaded images empty or discard overlapping text and media", () => {
    const empty = buildVerticalPageModel([], 100);
    expect(buildVerticalChapterModel(empty, [{ ...image(0), naturalWidth: 0 }], 150)).toEqual({ kind: "pending", reason: "image-size" });
    expect(buildVerticalChapterModel(empty, [], 150).kind).toBe("empty");
    expect(buildVerticalChapterModel(empty, [image(0), image(100)], 150)).toEqual({ kind: "unsupported", reason: "image-box" });
    expect(buildVerticalChapterModel(empty, [image(0), image(50, 100, 1)], 150)).toEqual({ kind: "unsupported", reason: "overlap" });
    expect(buildVerticalChapterModel(buildVerticalPageModel([{ start: 95, end: 110 }], 100), [image(100)], 150))
      .toEqual({ kind: "unsupported", reason: "overlap" });
    expect(buildVerticalChapterModel(empty, [{ ...image(0), end: 200 }], 150)).toEqual({ kind: "unsupported", reason: "image-box" });
  });

  it("restores the same media identity and vertical ratio after resize or a stale index hint", () => {
    const anchor = { ...image(0).anchor, ratio: 0.25 };
    const first = buildVerticalChapterModel(buildVerticalPageModel([], 100), [image(0)], 150);
    const resized = buildVerticalChapterModel(buildVerticalPageModel([], 240), [image(0, 240, 7)], 300);
    expect(locateVerticalImage(first, anchor)).toMatchObject({ status: "located", page: 0, anchor: { ratio: 0.25 } });
    expect(locateVerticalImage(resized, anchor)).toMatchObject({ status: "located", page: 0, anchor: { index: 7, signature: anchor.signature, ratio: 0.25 }, imageY: 75 });
    expect(locateVerticalImage(resized, { ...anchor, signature: "missing" }).status).toBe("unresolved");
  });

  it("uses a matching hint to disambiguate repeated source images, otherwise refuses to guess", () => {
    const model = buildVerticalChapterModel(buildVerticalPageModel([], 100), [image(0), image(100, 100, 1)], 150);
    expect(locateVerticalImage(model, image(100, 100, 1).anchor)).toMatchObject({ status: "located", page: 1 });
    expect(locateVerticalImage(model, { ...image(0).anchor, index: 99 }).status).toBe("unresolved");
    expect(locateVerticalImage(model, { ...image(0).anchor, ratio: 2 }).status).toBe("unresolved");
  });
});
