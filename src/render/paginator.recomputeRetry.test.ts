import { describe, expect, it, vi } from "vitest";
import { ChapterPaginator } from "./paginator";

type RecomputeContext = {
  disposed: boolean;
  loadSeq: number;
  _currentPath: string;
  viewer: HTMLElement;
  fixedLayout: boolean;
  settings: { readingMode: "paginated" };
  step: number;
  recomputeRetries: number;
  metrics: { pageCount: number; currentPage: number };
  measure: ReturnType<typeof vi.fn>;
  rebuildTextIndexForCurrentDoc: ReturnType<typeof vi.fn>;
  applyContainedMediaMaxWidth: () => void;
  recomputeInner: ReturnType<typeof vi.fn>;
  recompute?: (this: RecomputeContext, useAnchor: boolean, loadSeq?: number) => Promise<boolean>;
};

const recompute = (ChapterPaginator.prototype as unknown as {
  recompute(this: RecomputeContext, useAnchor: boolean, loadSeq?: number): Promise<boolean>;
}).recompute;

function makeContext(options: {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
}): {
  context: RecomputeContext;
  measure: ReturnType<typeof vi.fn>;
  rebuild: ReturnType<typeof vi.fn>;
  inner: ReturnType<typeof vi.fn>;
} {
  const measure = vi.fn(async () => true);
  const rebuild = vi.fn();
  const inner = vi.fn();
  const context = Object.create(ChapterPaginator.prototype) as RecomputeContext;
  Object.assign(context, {
    disposed: false,
    loadSeq: 1,
    _currentPath: "Text/chapter.xhtml",
    viewer: {
      scrollWidth: options.scrollWidth,
      clientWidth: options.clientWidth,
      scrollHeight: options.scrollHeight,
      clientHeight: options.clientHeight,
      children: [{}],
      textContent: "正文",
    },
    fixedLayout: false,
    settings: { readingMode: "paginated" },
    step: 100,
    recomputeRetries: 0,
    metrics: { pageCount: 3, currentPage: 0 },
    measure,
    rebuildTextIndexForCurrentDoc: rebuild,
    applyContainedMediaMaxWidth: () => {},
    recomputeInner: inner,
    recompute,
  });
  return { context, measure, rebuild, inner };
}

describe("paginated recompute retry", () => {
  it("does not re-measure when columns already overflow horizontally", async () => {
    const { context, measure, rebuild, inner } = makeContext({
      scrollWidth: 2782,
      clientWidth: 1070,
      scrollHeight: 492,
      clientHeight: 374,
    });

    await expect(recompute.call(context, true, 1)).resolves.toBe(true);

    expect(measure).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(context.recomputeRetries).toBe(0);
  });

  it("keeps the existing bounded retry when columns are not horizontally active", async () => {
    const { context, measure, rebuild, inner } = makeContext({
      scrollWidth: 900,
      clientWidth: 1070,
      scrollHeight: 492,
      clientHeight: 374,
    });

    await expect(recompute.call(context, true, 1)).resolves.toBe(true);

    expect(measure).toHaveBeenCalledTimes(2);
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(context.recomputeRetries).toBe(2);
  });
});
