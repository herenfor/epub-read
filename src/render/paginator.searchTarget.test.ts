import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ChapterPaginator } from "./paginator";
import { buildVisibleTextIndex, collectVisibleTextNodes } from "./textAnchor";
import { compileTextProjection } from "./textProjection/compile";
import { createDisplaySearchSession } from "./textProjection/displaySearch";
import { TextProjectionSession } from "./textProjection/session";
import type { Book } from "../core/types";

function fakeBook(chapters: string[]): Book {
  const spine = chapters.map((_, index) => ({ idref: `c${index}`, linear: true }));
  const manifest = new Map(chapters.map((_, index) => [
    `c${index}`,
    { id: `c${index}`, href: `Text/c${index}.xhtml`, mediaType: "application/xhtml+xml", properties: [] },
  ]));
  return {
    version: 3,
    opfPath: "OEBPS/content.opf",
    metadata: { title: "测试", identifier: "test", language: "zh" },
    manifest,
    spine,
    guide: [],
    toc: chapters.map((_, index) => ({ label: `第${index + 1}章`, href: `OEBPS/Text/c${index}.xhtml`, children: [] })),
    resources: new Map(chapters.map((content, index) => [
      `OEBPS/Text/c${index}.xhtml`,
      { path: `OEBPS/Text/c${index}.xhtml`, data: new TextEncoder().encode(content), mediaType: "application/xhtml+xml" },
    ])),
    fixedLayout: false,
    issues: [],
    drmProtected: false,
  };
}

interface FakeRange {
  startContainer: Node | null;
  startOffset: number;
  endContainer: Node | null;
  endOffset: number;
}

function installFakeRanges(doc: Document): void {
  (doc as unknown as { createRange: () => Range }).createRange = (() => {
    const range = {
      startContainer: null as Node | null,
      startOffset: 0,
      endContainer: null as Node | null,
      endOffset: 0,
      setStart(node: Node, offset: number) {
        this.startContainer = node;
        this.startOffset = offset;
      },
      setEnd(node: Node, offset: number) {
        this.endContainer = node;
        this.endOffset = offset;
      },
      toString: () => "",
    };
    return range as unknown as Range;
  }) as unknown as () => Range;
}

describe("R2 paginator display target resolver", () => {
  it("produces two different live DOM ranges for two display hits of one canonical replacement", async () => {
    const compiled = await compileTextProjection({
      mode: "original",
      rules: [{ id: "r1", from: "AB", to: "ZZ", enabled: true }],
    });
    const book = fakeBook(["<html><body><p>AB</p></body></html>"]);
    const session = createDisplaySearchSession(book, compiled, { yieldToHost: async () => {} });
    const results = await session.search("Z");
    expect(results).toHaveLength(2);

    const { document } = parseHTML("<html><body><epub-viewer id=\"epub-viewer\"><p>AB</p></epub-viewer></body></html>");
    const viewer = document.getElementById("epub-viewer") as HTMLElement;
    installFakeRanges(document as unknown as Document);

    const textProjection = new TextProjectionSession();
    const visibleNodes = collectVisibleTextNodes(document as unknown as Document, viewer);
    await textProjection.apply(visibleNodes, compiled);
    const canonicalIndex = buildVisibleTextIndex(document as unknown as Document, viewer, textProjection);

    const prototype = ChapterPaginator.prototype as unknown as {
      resolveRequestedSearchTarget: (this: unknown, index: unknown, request: unknown) => {
        canonicalHits: Array<{ start: number; end: number }>;
        paintIndex: ReturnType<typeof buildVisibleTextIndex>;
        paintHits: Array<{ start: number; end: number }>;
      } | null;
      resolveRequestedTextRanges: (index: unknown, request: unknown) => Array<{ start: number; end: number }> | null;
      dedupeHighlightRanges: (ranges: readonly { start: number; end: number }[]) => Array<{ start: number; end: number }>;
      buildHighlightRanges: (this: unknown, doc: Document, index: unknown, ranges: readonly { start: number; end: number }[]) => Range[] | null;
    };

    const fake = {
      contentDoc: document as unknown as Document,
      viewer,
      getTextProjectionVersion: () => compiled.version,
      resolveRequestedTextRanges: prototype.resolveRequestedTextRanges,
      dedupeHighlightRanges: prototype.dedupeHighlightRanges,
    };

    const resolvedFor = (index: number) => prototype.resolveRequestedSearchTarget.call(fake, canonicalIndex, {
      textHits: results[index].textHits,
      occurrence: results[index].occurrence,
      displayTarget: {
        projectionVersion: results[index].display!.projectionVersion,
        textHits: results[index].display!.textHits,
        occurrence: results[index].display!.occurrence,
      },
    });

    const first = resolvedFor(0);
    const second = resolvedFor(1);
    expect(first?.canonicalHits).toEqual([{ start: 0, end: 2 }]);
    expect(second?.canonicalHits).toEqual([{ start: 0, end: 2 }]);
    expect(first?.paintHits).toEqual([{ start: 0, end: 1 }]);
    expect(second?.paintHits).toEqual([{ start: 1, end: 2 }]);

    const firstRanges = prototype.buildHighlightRanges.call(fake, document as unknown as Document, first!.paintIndex, first!.paintHits);
    const secondRanges = prototype.buildHighlightRanges.call(fake, document as unknown as Document, second!.paintIndex, second!.paintHits);
    const firstRange = firstRanges?.[0] as unknown as FakeRange | undefined;
    const secondRange = secondRanges?.[0] as unknown as FakeRange | undefined;
    expect(firstRange).toMatchObject({ startOffset: 0, endOffset: 1 });
    expect(secondRange).toMatchObject({ startOffset: 1, endOffset: 2 });
    expect(firstRange?.startContainer).toBe(secondRange?.startContainer);
    expect(firstRange?.startOffset).not.toBe(secondRange?.startOffset);
    session.dispose();
  });
});
