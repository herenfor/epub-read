import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  buildVisibleTextIndex,
  captureTextSelection,
  collectVisibleTextNodes,
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
});
