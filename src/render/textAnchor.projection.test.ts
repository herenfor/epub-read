import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  buildVisibleTextIndex,
  captureTextSelection,
  collectVisibleTextNodes,
  resolveTextRangeOffsets,
} from "./textAnchor";
import { compileTextProjection } from "./textProjection/compile";
import { isProjectionExcludedTextNode, TextProjectionSession } from "./textProjection/session";
import type { TextProjectionPreferences } from "./textProjection/types";

function chapter(markup: string): { document: Document; viewer: HTMLElement } {
  const { document } = parseHTML(`<html><body><epub-viewer id="epub-viewer">${markup}</epub-viewer></body></html>`);
  return { document: document as unknown as Document, viewer: document.getElementById("epub-viewer") as HTMLElement };
}

function selectionFor(range: Range): Selection {
  return { rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as unknown as Selection;
}

describe("VisibleTextIndex with a T-1 display projection", () => {
  it("keeps original code points while mapping an unequal replacement back to a canonical selection", async () => {
    const preferences: TextProjectionPreferences = {
      mode: "original",
      rules: [{ id: "r1", from: "甲😀", to: "X", enabled: true }],
    };
    const compiled = await compileTextProjection(preferences);
    const { document, viewer } = chapter("<p>甲😀乙</p>");
    const session = new TextProjectionSession();
    await session.apply(collectVisibleTextNodes(document, viewer), compiled);
    expect(viewer.textContent).toBe("X乙");

    const index = buildVisibleTextIndex(document, viewer, session);
    expect(index.text).toBe("甲😀乙");
    expect(index.totalChars).toBe(3);
    expect(index.snippetAt(0)).toBe("甲😀乙");
    expect(index.snippetBefore(2)).toBe("甲😀");

    const startPosition = index.positionForOffset(0, "start");
    const endPosition = index.positionForOffset(2, "end");
    expect(startPosition).toMatchObject({ rawOffset: 0 });
    expect(endPosition).toMatchObject({ rawOffset: 1 });

    const text = document.querySelector("p")!.firstChild as Text;
    const range = {
      collapsed: false,
      startContainer: text,
      endContainer: text,
      startOffset: 0,
      endOffset: 1,
      toString: () => "X",
      getClientRects: () => [{ left: 0, top: 0, right: 10, bottom: 10 }],
    } as unknown as Range;
    const payload = captureTextSelection(document, viewer, index, selectionFor(range));
    expect(payload).toMatchObject({
      selectedText: "X",
      startTextOffset: 0,
      endTextOffset: 2,
      startTextSnippet: "甲😀乙",
      endTextSnippet: "甲😀",
    });
  });

  it("restores the original DOM when a later identity snapshot is applied", async () => {
    const replacement = await compileTextProjection({
      mode: "original",
      rules: [{ id: "r1", from: "后", to: "後", enabled: true }],
    });
    const identity = await compileTextProjection({ mode: "original", rules: [] });
    const { document, viewer } = chapter("<p>皇后</p>");
    const nodes = collectVisibleTextNodes(document, viewer);
    const session = new TextProjectionSession();
    await session.apply(nodes, replacement);
    expect(viewer.textContent).toBe("皇後");
    await session.apply(nodes, identity);
    expect(viewer.textContent).toBe("皇后");
  });

  it("keeps pre/code/SVG-range text original when the caller applies the first-version exclusion", async () => {
    const compiled = await compileTextProjection({
      mode: "original",
      rules: [{ id: "r1", from: "甲", to: "X", enabled: true }],
    });
    const { document, viewer } = chapter("<p>甲</p><pre>甲</pre><code>甲</code>");
    const nodes = collectVisibleTextNodes(document, viewer)
      .filter((node) => !isProjectionExcludedTextNode(node));
    const session = new TextProjectionSession();
    await session.apply(nodes, compiled);
    expect(viewer.textContent).toBe("X甲甲");
  });

  it("R4 copies original raw text with internal whitespace and block separators", () => {
    const first = chapter("<p>hello world</p>");
    const index = buildVisibleTextIndex(first.document, first.viewer);
    expect(index.originalTextForOffsets(0, index.totalChars)).toBe("hello world");

    const emoji = chapter("<p>😀 a</p>");
    const emojiIndex = buildVisibleTextIndex(emoji.document, emoji.viewer);
    expect(emojiIndex.originalTextForOffsets(0, emojiIndex.totalChars)).toBe("😀 a");

    const blocks = chapter("<p>a</p><p>b</p>");
    const blockIndex = buildVisibleTextIndex(blocks.document, blocks.viewer);
    expect(blockIndex.originalTextForOffsets(0, blockIndex.totalChars)).toBe("a\nb");

    const em = chapter("<p>Hello <em>world</em></p>");
    const emIndex = buildVisibleTextIndex(em.document, em.viewer);
    expect(emIndex.originalTextForOffsets(0, emIndex.totalChars)).toBe("Hello world");

    const spans = chapter("<p><span>Hello</span> <span>world</span></p>");
    const spanIndex = buildVisibleTextIndex(spans.document, spans.viewer);
    expect(spanIndex.originalTextForOffsets(0, spanIndex.totalChars)).toBe("Hello world");
  });

  it("R7 stores the canonical original quote so notes do not jump to a later display word", async () => {
    const compiled = await compileTextProjection({
      mode: "original",
      rules: [{ id: "r1", from: "AB", to: "X", enabled: true }],
    });
    const { document, viewer } = chapter("<p>AB X</p>");
    const nodes = collectVisibleTextNodes(document, viewer);
    const session = new TextProjectionSession();
    await session.apply(nodes, compiled);
    const index = buildVisibleTextIndex(document, viewer, session);
    const text = document.querySelector("p")!.firstChild as Text;
    const range = {
      collapsed: false,
      startContainer: text,
      endContainer: text,
      startOffset: 0,
      endOffset: 1,
      toString: () => "X",
      getClientRects: () => [{ left: 0, top: 0, right: 10, bottom: 10 }],
    } as unknown as Range;
    const payload = captureTextSelection(document, viewer, index, selectionFor(range));
    expect(payload?.selectedText).toBe("X");
    expect(payload?.originalSelectedText).toBe("AB");
    expect(payload).toMatchObject({ startTextOffset: 0, endTextOffset: 2 });
    expect(
      resolveTextRangeOffsets(
        index,
        {
          startTextOffset: payload!.startTextOffset,
          endTextOffset: payload!.endTextOffset,
          startTextSnippet: payload!.startTextSnippet,
          endTextSnippet: payload!.endTextSnippet,
        },
        payload!.originalSelectedText,
      ),
    ).toEqual({ start: 0, end: 2 });
  });

  it("R5 stops applying a cancelled batch snapshot before later nodes are mutated", async () => {
    const compiled = await compileTextProjection({
      mode: "original",
      rules: [{ id: "r1", from: "甲", to: "X", enabled: true }],
    });
    const { document, viewer } = chapter("<p>甲</p><p>甲</p>");
    const nodes = collectVisibleTextNodes(document, viewer);
    const session = new TextProjectionSession();
    let calls = 0;
    await session.apply(nodes, compiled, {
      batchSize: 1,
      isCurrent: () => {
        calls += 1;
        return calls <= 1;
      },
      yieldToHost: async () => {},
    });
    const paragraphs = document.querySelectorAll("p");
    expect(paragraphs[0]?.textContent).toBe("X");
    expect(paragraphs[1]?.textContent).toBe("甲");
  });
});
