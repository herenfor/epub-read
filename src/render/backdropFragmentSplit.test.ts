import { describe, expect, it } from "vitest";
import { SHELL_MARKER, splitBackdropBox } from "./backdropFragmentSplit";

/**
 * Tiny fake DOM with a one-dimensional column layout: blocks stack in columns
 * of COLUMN px, a `break-before: column` shell starts a new column, and an
 * unforced overflow fragments the block into the next column.
 */
const COLUMN = 100;
const WIDTH = 50;
const STRIDE = 60;

type FakeNode = FakeElement | FakeText;

class FakeText {
  nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent() { return this.data; }
  get nextSibling(): FakeNode | null { return siblingAfter(this); }
}

class FakeElement {
  nodeType = 1;
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  rects: DOMRect[] = [];
  constructor(public tagName: string, public height = 0, public display = "block", public decoration = "slice") {}
  get ownerDocument() { return fakeDocument; }
  get children(): FakeElement[] { return this.childNodes.filter((n): n is FakeElement => n.nodeType === 1); }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get nextSibling(): FakeNode | null { return siblingAfter(this); }
  get parentElement() { return this.parentNode; }
  get textContent(): string { return this.childNodes.map((n) => n.textContent).join(""); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  appendChild(node: FakeNode) {
    detach(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  after(node: FakeElement) {
    const parent = this.parentNode!;
    detach(node);
    node.parentNode = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, node);
  }
  remove() { detach(this); }
  cloneNode(): FakeElement {
    const copy = new FakeElement(this.tagName, 0, this.display, this.decoration);
    for (const [key, value] of this.attributes) copy.attributes.set(key, value);
    return copy;
  }
  getClientRects() { layout(); return this.rects; }
  getBoundingClientRect() { layout(); return this.rects[0] ?? rect(0, 0, 0, 0); }
}

function siblingAfter(node: FakeNode): FakeNode | null {
  const siblings = node.parentNode?.childNodes ?? [];
  return siblings[siblings.indexOf(node) + 1] ?? null;
}
function detach(node: FakeNode) {
  const parent = node.parentNode;
  if (parent) parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
  node.parentNode = null;
}
function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

const fakeDocument = {
  defaultView: {
    getComputedStyle: (el: FakeElement) => ({
      display: el.display,
      getPropertyValue: (name: string) => (name.endsWith("box-decoration-break") ? el.decoration : ""),
    }),
  },
};

let root: FakeElement;

/** Lay out root's children; each box's children flow inside it. */
function layout() {
  let column = 0;
  let y = 0;
  const place = (height: number): DOMRect[] => {
    const out: DOMRect[] = [];
    let left = height;
    while (left > 0) {
      if (y >= COLUMN) { column += 1; y = 0; }
      const take = Math.min(left, COLUMN - y);
      out.push(rect(column * STRIDE, y, WIDTH, take));
      y += take;
      left -= take;
    }
    return out;
  };
  for (const box of root.children) {
    if (/break-before: column/.test(box.getAttribute("style") ?? "") && y > 0) { column += 1; y = 0; }
    const start = { column, y };
    for (const child of box.children) child.rects = place(child.height);
    if (!box.children.length) box.rects = place(box.height);
    else {
      const rects: DOMRect[] = [];
      for (let c = start.column; c <= column; c += 1) {
        const top = c === start.column ? start.y : 0;
        const bottom = c === column ? y : COLUMN;
        rects.push(rect(c * STRIDE, top, WIDTH, bottom - top));
      }
      box.rects = rects;
    }
  }
}

function makeBox(heights: number[], options: { lead?: number; decoration?: string; style?: string } = {}) {
  root = new FakeElement("body");
  if (options.lead) root.appendChild(new FakeElement("h1", options.lead));
  const box = new FakeElement("div", 0, "block", options.decoration ?? "slice");
  box.setAttribute("id", "intro");
  box.setAttribute("class", "blurbox");
  if (options.style) box.setAttribute("style", options.style);
  heights.forEach((height, i) => {
    box.appendChild(new FakeText("\n  "));
    const p = new FakeElement("p", height);
    p.appendChild(new FakeText(`段落${i}`));
    box.appendChild(p);
  });
  box.appendChild(new FakeText("\n"));
  root.appendChild(box);
  return box;
}

const asEl = (box: FakeElement) => box as unknown as HTMLElement;

describe("splitBackdropBox (ER-0126)", () => {
  it("splits a box spanning three columns into one single-fragment shell per column", () => {
    const box = makeBox([40, 40, 40, 40, 40, 40], { lead: 20, style: "border-radius: 10px" });
    const before = box.textContent;
    const children = [...box.childNodes];

    const result = splitBackdropBox(asEl(box));
    expect(result.kind).toBe("applied");
    const shells = root.children.filter((el) => el.getAttribute("class") === "blurbox");
    expect(shells).toHaveLength(3);
    expect(shells.every((shell) => shell.getClientRects().length === 1)).toBe(true);
    expect(shells.map((shell) => shell.textContent).join("")).toBe(before);
    // Only the original keeps the id; later shells are marked and start a column.
    expect(shells[0]).toBe(box);
    expect(shells.slice(1).every((s) => s.getAttribute("id") === null && s.hasAttribute(SHELL_MARKER))).toBe(true);
    expect(shells[1].getAttribute("style")).toMatch(/break-before: column/);
    // slice: cut edges lose their decoration, the outer ones keep it.
    expect(box.getAttribute("style")).toMatch(/padding-bottom: 0/);
    expect(box.getAttribute("style")).not.toMatch(/padding-top: 0/);
    expect(shells[2].getAttribute("style")).toMatch(/padding-top: 0/);
    expect(shells[2].getAttribute("style")).not.toMatch(/padding-bottom: 0/);
    expect(shells[1].children[0].getAttribute("style")).toMatch(/margin-top: 0/);

    if (result.kind !== "applied") return;
    result.restore();
    expect(root.children.filter((el) => el.getAttribute("class") === "blurbox")).toEqual([box]);
    expect(box.childNodes).toEqual(children);
    expect(box.getAttribute("style")).toBe("border-radius: 10px");
    expect(box.children.every((p) => p.getAttribute("style") === null)).toBe(true);

    result.restore();
    expect(box.childNodes).toEqual(children);
  });

  it("moves a child that would cross a column whole into the next shell", () => {
    const box = makeBox([40, 40, 40], { lead: 0 });
    // 0-40, 40-80, 80-120 crosses the first column at 100.
    const result = splitBackdropBox(asEl(box));
    expect(result.kind).toBe("applied");
    expect(box.children).toHaveLength(2);
    expect(box.getClientRects()).toHaveLength(1);
  });

  it("keeps clone decoration on every shell", () => {
    const box = makeBox([60, 60, 60], { decoration: "clone" });
    const result = splitBackdropBox(asEl(box));
    expect(result.kind).toBe("applied");
    const shell = root.children[1];
    expect(shell.getAttribute("style")).toMatch(/break-before: column/);
    expect(shell.getAttribute("style")).not.toMatch(/padding-top: 0/);
    expect(box.getAttribute("style")).toBeNull();
    expect(shell.children[0].getAttribute("style")).toBeNull();
  });

  it("rolls back when a child block is taller than a column", () => {
    const box = makeBox([30, 150]);
    const children = [...box.childNodes];
    const result = splitBackdropBox(asEl(box));
    expect(result).toEqual({ kind: "unsupported", reason: "a child block is taller than a column" });
    expect(root.children).toEqual([box]);
    expect(box.childNodes).toEqual(children);
    expect(box.getAttribute("style")).toBeNull();
    expect(box.children.every((p) => p.getAttribute("style") === null)).toBe(true);
  });

  it("refuses inline text directly in the box and leaves a single fragment alone", () => {
    const box = makeBox([60, 60]);
    box.appendChild(new FakeText("裸文字"));
    expect(splitBackdropBox(asEl(box)).kind).toBe("unsupported");
    expect(root.children).toEqual([box]);

    const short = makeBox([20, 20]);
    expect(splitBackdropBox(asEl(short))).toEqual({ kind: "unchanged" });
  });

  it("refuses non-block children", () => {
    const box = makeBox([60, 60]);
    box.children[0].display = "inline";
    expect(splitBackdropBox(asEl(box))).toEqual({ kind: "unsupported", reason: "child display inline" });
  });
});
