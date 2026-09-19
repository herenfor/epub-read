import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { ChapterPaginator, type LoadOptions, type ReadingAnchor } from "./paginator";

function iframe(): HTMLIFrameElement {
  return {
    style: {},
    src: "about:blank",
    clientWidth: 800,
    clientHeight: 600,
    addEventListener() {},
    removeEventListener() {},
    contentDocument: null,
  } as unknown as HTMLIFrameElement;
}

function anchor(): ReadingAnchor {
  return {
    index: -1,
    ratio: 0,
    charsRead: 12,
    totalChars: 80,
    textOffset: 12,
    textSnippet: "旧snippet",
  };
}

describe("settings reload snapshots", () => {
  it("passes an immutable anchor snapshot and current page fallback before load", async () => {
    const paginator = new ChapterPaginator(
      iframe(),
      { textFor: () => "chapter" } as never,
      DEFAULT_SETTINGS,
      true,
      vi.fn()
    ) as unknown as {
      anchor: ReadingAnchor | null;
      anchorPath: string;
      _currentPath: string;
      metrics: { currentPage: number; pageCount: number };
      load(path: string, options?: LoadOptions): Promise<void>;
      reloadWithSettings(settings: typeof DEFAULT_SETTINGS, anchor?: string): Promise<void>;
    };
    paginator.anchor = anchor();
    paginator.anchorPath = "chapter.xhtml";
    paginator._currentPath = "chapter.xhtml";
    paginator.metrics = { currentPage: 2, pageCount: 3 };
    const load = vi.spyOn(paginator, "load").mockResolvedValue();
    await paginator.reloadWithSettings({ ...DEFAULT_SETTINGS, fontSizePx: 19 });
    expect(load).toHaveBeenCalledTimes(1);
    const [, options] = load.mock.calls[0] ?? [];
    expect(options).toMatchObject({ fallbackPage: 2, readingAnchor: anchor() });
    expect(options?.readingAnchor).not.toBe(paginator.anchor);
  });

  it("carries the committed search highlight identity across a settings reload", async () => {
    const paginator = new ChapterPaginator(
      iframe(),
      { textFor: () => "chapter" } as never,
      DEFAULT_SETTINGS,
      true,
      vi.fn()
    ) as unknown as {
      anchor: ReadingAnchor | null;
      anchorPath: string;
      _currentPath: string;
      metrics: { currentPage: number; pageCount: number };
      searchHighlightTarget: { requestId: number; textHits: Array<{ start: number; end: number; exactText: string }> } | null;
      load(path: string, options?: LoadOptions): Promise<void>;
      reloadWithSettings(settings: typeof DEFAULT_SETTINGS, anchor?: string): Promise<void>;
    };
    paginator.anchor = anchor();
    paginator.anchorPath = "chapter.xhtml";
    paginator._currentPath = "chapter.xhtml";
    paginator.metrics = { currentPage: 2, pageCount: 3 };
    paginator.searchHighlightTarget = {
      requestId: 7,
      textHits: [{ start: 12, end: 14, exactText: "旧文" }],
    };
    const load = vi.spyOn(paginator, "load").mockResolvedValue();
    await paginator.reloadWithSettings({ ...DEFAULT_SETTINGS, fontSizePx: 19 });
    const [, options] = load.mock.calls[0] ?? [];
    expect(options?.preserveSearchHighlight).toEqual({
      requestId: 7,
      textHits: [{ start: 12, end: 14, exactText: "旧文" }],
    });
    expect(options?.preserveSearchHighlight).not.toBe(paginator.searchHighlightTarget);
    expect(options?.preserveSearchHighlight?.textHits[0]).not.toBe(paginator.searchHighlightTarget?.textHits[0]);
  });

  it("keeps an existing anchor when capture has no document", async () => {
    const paginator = new ChapterPaginator(
      iframe(),
      { textFor: () => "chapter" } as never,
      DEFAULT_SETTINGS,
      true,
      vi.fn()
    ) as unknown as {
      anchor: ReadingAnchor | null;
      anchorPath: string;
      _currentPath: string;
      metrics: { currentPage: number; pageCount: number };
      load(path: string, options?: LoadOptions): Promise<void>;
      reloadWithSettings(settings: typeof DEFAULT_SETTINGS, anchor?: string): Promise<void>;
    };
    const existing = anchor();
    paginator.anchor = existing;
    paginator.anchorPath = "chapter.xhtml";
    paginator._currentPath = "chapter.xhtml";
    paginator.metrics = { currentPage: 1, pageCount: 3 };
    const load = vi.spyOn(paginator, "load").mockResolvedValue();
    await paginator.reloadWithSettings({ ...DEFAULT_SETTINGS, fontSizePx: 20 });
    expect(load.mock.calls[0][1]?.readingAnchor).toEqual(existing);
    expect(load.mock.calls[0][1]?.fallbackPage).toBe(1);
  });
});
