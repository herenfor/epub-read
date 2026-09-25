import { describe, expect, it } from "vitest";
import { ChapterPaginator, type MediaReadingAnchor } from "./paginator";

/** `top`/`height` 都是**内容坐标**；rect 会随 viewer.scrollTop 移动，和真实 DOM 一致。 */
interface FakeMedia {
  tagName: string;
  attrs: Record<string, string>;
  top: number;
  height: number;
}

function mediaElement(media: FakeMedia, scrollTop: number) {
  return {
    tagName: media.tagName.toUpperCase(),
    getAttribute: (name: string) => media.attrs[name] ?? null,
    getBoundingClientRect: () => ({
      top: media.top - scrollTop,
      bottom: media.top - scrollTop + media.height,
      height: media.height,
      left: 0,
      right: 640,
      width: 640,
    }),
  };
}

/** 只实现这两个方法用到的 viewer 表面；内容坐标 = viewer.scrollTop + viewportY。 */
function createPaginator(media: FakeMedia[], scrollTop: number) {
  const viewer = {
    scrollTop,
    clientWidth: 640,
    clientHeight: 836,
    getBoundingClientRect: () => ({
      top: 0,
      left: 0,
      right: 640,
      bottom: 836,
      width: 640,
      height: 836,
    }),
    querySelectorAll: () => media.map((item) => mediaElement(item, scrollTop)),
  };
  const paginator = Object.create(ChapterPaginator.prototype) as {
    viewer: unknown;
    getMediaAnchorAt(viewportY: number): { anchor: MediaReadingAnchor; contentY: number } | null;
    resolveMediaAnchorContentY(anchor: MediaReadingAnchor): number | null;
  };
  paginator.viewer = viewer;
  return paginator;
}

function longImage(overrides: Partial<FakeMedia> = {}): FakeMedia {
  return {
    tagName: "img",
    attrs: { class: "kuchie", src: "../Images/tall.png" },
    top: 100,
    height: 3000,
    ...overrides,
  };
}

describe("continuous media anchor (R3)", () => {
  it("keeps the in-image ratio instead of a stale chapter pixel offset", () => {
    const sample = createPaginator([longImage()], 0).getMediaAnchorAt(1600);
    expect(sample).not.toBeNull();
    expect(sample!.anchor.index).toBe(0);
    expect(sample!.anchor.ratio).toBeCloseTo(0.5, 6);
    expect(sample!.contentY).toBe(1600);

    // 窗口变窄/高度变化后图片实际高度只剩一半：同一图案应落到 100 + 750
    const resized = createPaginator([longImage({ height: 1500 })], 0);
    expect(resized.resolveMediaAnchorContentY(sample!.anchor)).toBeCloseTo(850, 6);
  });

  it("accounts for the viewer's own scroll when sampling and resolving", () => {
    const paginator = createPaginator([longImage()], 400);
    const sample = paginator.getMediaAnchorAt(300);
    expect(sample!.contentY).toBe(700);
    expect(sample!.anchor.ratio).toBeCloseTo(0.2, 6);
    expect(paginator.resolveMediaAnchorContentY(sample!.anchor)).toBeCloseTo(700, 6);
  });

  it("returns null when the reading line is outside every media element", () => {
    const paginator = createPaginator([longImage()], 0);
    // 图片从 100 开始；阅读线在图片上方
    expect(paginator.getMediaAnchorAt(10)).toBeNull();
    // 也在图片下方
    expect(paginator.getMediaAnchorAt(4000)).toBeNull();
  });

  it("falls back to the signature when the element order changes", () => {
    const sample = createPaginator([longImage()], 0).getMediaAnchorAt(1600);
    expect(sample).not.toBeNull();

    const svg: FakeMedia = {
      tagName: "svg",
      attrs: { viewBox: "0 0 100 100" },
      top: 0,
      height: 200,
    };
    // 顺序身份已失效（index 对不上），按签名回退找到同一张图
    const paginator = createPaginator([svg, longImage()], 0);
    expect(paginator.resolveMediaAnchorContentY(sample!.anchor)).toBeCloseTo(1600, 6);
  });

  it("returns null instead of guessing when the media identity is gone", () => {
    const sample = createPaginator([longImage()], 0).getMediaAnchorAt(1600);
    const other: FakeMedia = {
      tagName: "img",
      attrs: { src: "../Images/other.png" },
      top: 0,
      height: 3000,
    };
    const paginator = createPaginator([other], 0);
    expect(paginator.resolveMediaAnchorContentY(sample!.anchor)).toBeNull();
  });

  it("ignores zero-height media so an unloaded image cannot anchor a spot", () => {
    const paginator = createPaginator([longImage({ height: 0 })], 0);
    expect(paginator.getMediaAnchorAt(1600)).toBeNull();
  });
});
