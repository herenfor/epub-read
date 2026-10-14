import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { buildVisibleTextIndex } from "../textAnchor";
import { createNodeProjection } from "../textProjection/nodeProjection";
import { compileTextProjection } from "../textProjection/compile";
import { VerticalTextLayout } from "./textLayout";

function fixture(text = "甲😀乙丙丁") {
  const parsed = parseHTML(`<html><body><div id="root"><p>${text}</p></div></body></html>`);
  const doc = parsed.document as unknown as Document;
  const root = doc.getElementById("root") as HTMLElement;
  root.scrollLeft = 0;
  root.getBoundingClientRect = () => ({ right: 500 } as DOMRect);
  Object.defineProperty(doc.defaultView, "getComputedStyle", { configurable: true,
    value: () => ({ writingMode: "vertical-rl", borderRightWidth: "0px", display: "block", visibility: "visible" }) });
  doc.createRange = () => {
    let node: Text, start = 0, end = 0;
    return {
      selectNodeContents(n: Text) { node = n; start = 0; end = n.data.length; },
      setStart(n: Text, s: number) { node = n; start = s; },
      setEnd(n: Text, e: number) { node = n; end = e; },
      getClientRects() {
        const rawPrefix = Array.from(node.data.slice(0, start)).length;
        return Array.from(node.data.slice(start, end), (_, n) => {
          const logical = Math.floor((rawPrefix + n) / 2) * 60;
          return { right: 500 - logical - root.scrollLeft, left: 480 - logical - root.scrollLeft, width: 20, height: 18 };
        });
      },
    } as unknown as Range;
  };
  const index = buildVisibleTextIndex(doc, root);
  return { doc, root, index };
}

describe("vertical canonical location", () => {
  it("keeps annotation and base together even with a horizontal gap between their ink", () => {
    const { doc, root } = fixture();
    root.innerHTML = "<p>甲<ruby>漢<rt>あ</rt></ruby></p>";
    const rect = (start: number, end: number) => ({ right: 500 - start, left: 500 - end, width: end - start, height: 18 });
    doc.createRange = () => {
      let selected: Node;
      return {
        selectNodeContents(node: Node) { selected = node; },
        setStart(node: Node) { selected = node; },
        setEnd() {},
        getClientRects() {
          if (selected.nodeType === 1) return [rect(65, 85), rect(45, 55)];
          return [(selected as Text).data === "甲" ? rect(0, 20) : (selected as Text).data === "漢" ? rect(65, 85) : rect(45, 55)];
        },
      } as unknown as Range;
    };
    const layout = new VerticalTextLayout(root, buildVisibleTextIndex(doc, root), 60);
    expect(layout.locate({ textOffset: 1, textSnippet: "漢" })).toMatchObject({ status: "located", page: 1 });
    expect(layout.locate({ textOffset: 2, textSnippet: "あ" })).toMatchObject({ status: "located", page: 1 });
  });
  it("keeps Unicode canonical identity while a new width selects a new page", () => {
    const { root, index } = fixture();
    const anchor = { textOffset: 4, textSnippet: "丁" };
    const old = new VerticalTextLayout(root, index, 100);
    expect(old.locate(anchor)).toMatchObject({ status: "located", page: 1, anchor });
    old.invalidate();
    expect(old.locate(anchor).status).toBe("stale-layout");
    expect(new VerticalTextLayout(root, index, 60).locate(anchor)).toMatchObject({ status: "located", page: 2, anchor });
  });

  it("does not change page identity after negative native horizontal scrolling", () => {
    const { root, index } = fixture();
    const layout = new VerticalTextLayout(root, index, 100);
    root.scrollLeft = -80;
    expect(layout.locate({ textOffset: 4, textSnippet: "丁" })).toMatchObject({ status: "located", page: 1, logicalOffset: 120 });
    expect(new VerticalTextLayout(root, index, 100).model).toEqual(layout.model);
  });

  it("validates snippets and exact duplicate offsets; no failed anchor becomes page zero", () => {
    const { root, index } = fixture("甲共享乙共享丙");
    const layout = new VerticalTextLayout(root, index, 100);
    expect(layout.locate({ textOffset: 4, textSnippet: "共享" })).toMatchObject({ status: "located", page: 1, anchor: { textOffset: 4 } });
    expect(layout.locate({ textOffset: 4, textSnippet: "不存在" }).status).toBe("unresolved");
    expect(layout.locate({ textOffset: index.totalChars, textSnippet: null }).status).toBe("located");
  });

  it("resolves original identities after one source character expands into several displayed glyphs", async () => {
    const { root, doc } = fixture();
    const node = root.querySelector("p")!.firstChild as Text;
    const compiled = await compileTextProjection({ mode: "original",
      rules: [{ id: "expand", from: "😀", to: "ZZZZZZ", enabled: true }] });
    const projection = createNodeProjection(node.data, compiled);
    node.data = projection.display;
    const index = buildVisibleTextIndex(doc, root, {
      projectionForNode: candidate => candidate === node ? projection : undefined,
    });
    expect(index.text).toBe("甲😀乙丙丁");
    expect(new VerticalTextLayout(root, index, 100).locate({ textOffset: 4, textSnippet: "丁" }))
      .toMatchObject({ status: "located", page: 2, anchor: { textOffset: 4, textSnippet: "丁" } });
  });

  it("requires a vertical scrolling owner and cannot use another document's index", () => {
    const first = fixture(), second = fixture();
    expect(() => new VerticalTextLayout(second.root, first.index, 100)).toThrow("another document");
    Object.defineProperty(first.doc.defaultView, "getComputedStyle", { configurable: true,
      value: () => ({ writingMode: "horizontal-tb" }) });
    expect(() => new VerticalTextLayout(first.root, first.index, 100)).toThrow("vertical-rl");
  });
});
