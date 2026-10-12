import { describe, expect, it, vi } from "vitest";
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
    /** 这些假媒体互为兄弟，谁也不包含谁；真实 DOM 的 Element.contains 在
     *  兄弟之间同样恒为 false，`collectMediaElements` 的去重因此不会误删。 */
    contains: () => false,
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

// ---- B-237: paginated sampling of an image page ----

interface Box { left: number; top: number; width: number; height: number }

function fakeMedia(tag: string, attrs: Record<string, string>, box: Box) {
  return {
    tagName: tag.toUpperCase(),
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }),
    contains: () => false,
  };
}

type Pager = Record<string, any>;

/**
 * Two-leaf spread, 400px columns, 40px gap. Coordinates are iframe viewport
 * coordinates, as in Chrome: over a full-page image the caret APIs return the
 * wrapper element (no text node) and elementFromPoint the image or wrapper.
 */
function pagedFixture(media: ReturnType<typeof fakeMedia>[], caretText = false) {
  const p = Object.create(ChapterPaginator.prototype) as Pager;
  const wrapper = { nodeType: 1, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 500 }) };
  const textEl = { textContent: "右页正文", getBoundingClientRect: () => ({ left: 440, top: 0, width: 400, height: 20 }) };
  const caret = vi.fn(() => caretText
    ? { offsetNode: { nodeType: 3, parentElement: textEl }, offset: 0 }
    : { offsetNode: wrapper, offset: 1 });
  const viewer = {
    clientWidth: 840, clientHeight: 500, clientLeft: 0, scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ paddingLeft: "0" }) } },
    querySelectorAll: () => media,
  };
  Object.assign(p, {
    viewer,
    contentDoc: {
      documentElement: { clientWidth: 840, clientHeight: 500 },
      caretPositionFromPoint: caret,
      elementFromPoint: () => wrapper,
      defaultView: { getComputedStyle: () => ({ paddingLeft: "0" }) },
    },
    textIndex: {
      offsetForNode: () => 400,
      elementIndex: (el: unknown) => (el === wrapper ? 7 : el === textEl ? 9 : 41 + media.indexOf(el as never)),
      snippetAt: () => "右页正文",
      totalChars: 900,
      mediaUnits: media.length,
    },
    settings: { readingMode: "paginated", gapPx: 40 }, disposed: false,
    pageWidth: 400, step: 440, leadingColumns: 0, effectiveColumns: 2, geometry: { columns: 2, columnWidth: 400 },
    metrics: { currentPage: 3, pageCount: 10 },
    lastState: { status: "ready", currentPage: 3, pageCount: 10, empty: false },
    _currentPath: "OEBPS/Text/p19.xhtml", pageMotion: null,
    readVisualPosition: () => ({ page: 3, left: 1320, snapLeft: 1320, aligned: true }),
    readyState: (empty: boolean, page = p.metrics.currentPage) => ({ status: "ready", currentPage: page, pageCount: 10, empty }),
  });
  return { p, viewer, caret };
}

/** Full-page image centred in the left leaf; the session URL is not identity. */
const kuchie = () => fakeMedia("img", { class: "fit", src: "blob:https://app/4f1c" }, { left: 87.5, top: 0, width: 225, height: 300 });

describe("paginated media anchor (B-237)", () => {
  it("an image page records the visible image's identity, and getReadingAnchor carries it", () => {
    const { p } = pagedFixture([kuchie()]);
    p.captureAnchor();
    const anchor = p.getReadingAnchor();
    expect(anchor).toMatchObject({ path: "OEBPS/Text/p19.xhtml", index: 41, textOffset: null });
    expect(anchor.mediaAnchor).toEqual({ index: 0, tag: "img", signature: "img||fit||", ratio: 250 / 300 });
    // The public reading is a copy; callers cannot mutate the live anchor.
    anchor.mediaAnchor.ratio = 0;
    expect(p.getReadingAnchor().mediaAnchor.ratio).toBeCloseTo(250 / 300, 6);
  });

  it("text under the point stays a text anchor", () => {
    const { p } = pagedFixture([kuchie()], true);
    const media = vi.spyOn(p, "visibleMediaAt");
    p.captureAnchor();
    expect(p.getReadingAnchor()).toMatchObject({ textOffset: 400, mediaAnchor: null });
    expect(media).not.toHaveBeenCalled();
  });

  it("does not borrow an image from the other leaf for blank space", () => {
    const right = fakeMedia("img", { class: "fit" }, { left: 527.5, top: 0, width: 225, height: 300 });
    const { p } = pagedFixture([right]);
    p.captureAnchor();
    expect(p.getReadingAnchor()).toMatchObject({ index: 7, textOffset: null, mediaAnchor: null });
  });

  it("samples the moving window's visible leaf without settling it or writing scroll", () => {
    // Window mid-motion: page 3's left leaf sits at client x 100..500.
    const moved = fakeMedia("svg", { viewBox: "0 0 1200 1700" }, { left: 187.5, top: 0, width: 225, height: 300 });
    const neighbour = fakeMedia("img", { class: "fit" }, { left: -252.5, top: 0, width: 225, height: 300 });
    const { p, viewer } = pagedFixture([neighbour, moved]);
    const driver = { active: true, settleTo: vi.fn(), holdSettledAt: vi.fn() };
    Object.assign(p, {
      metrics: { currentPage: 2, pageCount: 10 },
      pageMotion: { driver, session: { state: { kind: "moving" } } },
      readVisualPosition: () => ({ page: 3, left: 1220, snapLeft: 1320, aligned: false }),
    });
    viewer.getBoundingClientRect = () => ({ left: -1220, top: 0 });
    const snapshot = p.readPositionSnapshot();
    expect(snapshot.state).toMatchObject({ currentPage: 3, transient: true });
    expect(snapshot.readingAnchor.mediaAnchor).toMatchObject({ index: 1, tag: "svg", signature: "svg|||0 0 1200 1700|" });
    // A retained (idle) window samples the same way for the stored anchor.
    p.pageMotion.session.state = { kind: "idle" };
    p.captureAnchor();
    expect(p.getReadingAnchor().mediaAnchor).toMatchObject({ index: 1, tag: "svg" });
    expect(driver.settleTo).not.toHaveBeenCalled();
    expect(viewer.scrollLeft).toBe(0);
  });

  it("resolves an image bookmark by signature when the image order changed", () => {
    const first = fakeMedia("img", { class: "inline" }, { left: 500, top: 0, width: 100, height: 100 });
    const target = fakeMedia("img", { class: "fit" }, { left: 2727.5, top: 0, width: 225, height: 300 });
    const { p } = pagedFixture([first, target]);
    Object.assign(p, {
      textIndex: null,
      bookmarkSpreadCache: new Map(),
      spreadLayout: { pageCount: 10, firstColumn: 0, empty: false, geometry: { columns: 2, columnStep: 440 } },
    });
    // Saved when the image was media #0; an inserted image moved it to #1.
    const page = p.resolveBookmarkPage({ mediaAnchor: { index: 0, tag: "img", signature: "img||fit||", ratio: 0.5 } });
    expect(page).toBe(3);
  });
});
