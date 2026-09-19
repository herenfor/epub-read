import { describe, expect, it } from "vitest";
import { applyBackdropCompatibility, type BackdropCompatibilityGeometry } from "./backdropCompatibility";

function rect(left: number, top: number, right: number, bottom: number) {
  return { left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect;
}

interface FakeOptions {
  fittedRect?: DOMRect;
  textRect?: DOMRect;
  viewerPadding?: Partial<Record<"top" | "right" | "bottom" | "left", string>>;
  transform?: string;
  beforeContent?: string;
}

function fakeContext(options: FakeOptions = {}) {
  const attributes = new Map<string, string>();
  let appliedBreak = false;
  const splitRectA = rect(100, 600, 700, 700);
  const splitRectB = rect(900, 67, 1500, 180);
  const fittedRect = options.fittedRect ?? rect(620, 67, 1200, 300);
  const textNode = { nodeType: 3, data: "正文" };
  const element = {
    style: {},
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
      if (name === "style") appliedBreak = value.includes("break-inside");
    },
    removeAttribute: (name: string) => attributes.delete(name),
    hasAttribute: (name: string) => attributes.has(name),
    querySelector: () => null,
    querySelectorAll: () => [],
    getClientRects: () => (appliedBreak ? [fittedRect] : [splitRectA, splitRectB]),
    getBoundingClientRect: () => (appliedBreak ? fittedRect : rect(100, 67, 1500, 700)),
  };
  attributes.set("style", "background-color:red;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(25px)");
  const viewerPadding = {
    top: "0px",
    right: "0px",
    bottom: "0px",
    left: "0px",
    ...options.viewerPadding,
  };
  const viewer = {
    clientHeight: 667,
    clientWidth: 600,
    scrollLeft: 0,
    scrollWidth: 600,
    ownerDocument: null,
    contains: () => true,
    querySelector: (selector: string) => (selector.includes("backdrop") ? element : null),
    querySelectorAll: () => [element],
    getBoundingClientRect: () => rect(0, 0, 600, 667),
  };
  const cs = {
    backdropFilter: "blur(25px)",
    display: "block",
    position: "static",
    float: "none",
    breakInside: "auto",
    breakBefore: "auto",
    breakAfter: "auto",
    transform: options.transform ?? "none",
    writingMode: "horizontal-tb",
    overflowX: "visible",
    overflowY: "visible",
    height: "220px",
    visibility: "visible",
    content: "normal",
    getPropertyValue: (name: string) => (name === "-webkit-backdrop-filter" ? "blur(10px)" : ""),
  };
  const viewerCs = {
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    paddingLeft: viewerPadding.left,
    paddingRight: viewerPadding.right,
    paddingTop: viewerPadding.top,
    paddingBottom: viewerPadding.bottom,
  };
  const doc = {
    styleSheets: [],
    defaultView: {
      getComputedStyle: (target: unknown) => (target === viewer ? viewerCs : { ...cs, content: options.beforeContent ?? "normal" }),
    },
    createTreeWalker: () => {
      let done = false;
      return {
        nextNode: () => {
          if (done) return null;
          done = true;
          return textNode;
        },
      };
    },
    createRange: () => {
      const textRect = options.textRect ?? fittedRect;
      return {
        selectNodeContents() {},
        getClientRects: () => [textRect],
      };
    },
  } as unknown as Document;
  return { doc, viewer: viewer as unknown as HTMLElement, element: element as unknown as HTMLElement, attributes };
}

const geometry: BackdropCompatibilityGeometry = { pageWidth: 600, step: 600 };

describe("backdrop compatibility", () => {
  it("applies one-column avoid only after validating the moved box and real text Range", () => {
    const { doc, viewer, element, attributes } = fakeContext();
    const restore = applyBackdropCompatibility(doc, viewer, geometry);
    expect(restore).not.toBeNull();
    expect(attributes.get("style")).toContain("break-inside: avoid-column !important");
    expect(attributes.get("style")).toContain("-webkit-backdrop-filter:blur(10px)");
    expect(element.getAttribute("data-reader-backdrop-break")).toBe("applied");
    restore?.();
    expect(attributes.get("style")).toBe("background-color:red;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(25px)");
    expect(element.getAttribute("data-reader-backdrop-break")).toBeNull();
  });

  it("skips boxes with no backdrop declaration without a full scan", () => {
    const { doc, viewer } = fakeContext();
    (viewer as unknown as { querySelector: () => null }).querySelector = () => null;
    expect(applyBackdropCompatibility(doc, viewer, geometry)).toBeNull();
  });

  it("rejects a candidate that overflows the viewer content boundary after padding", () => {
    const { doc, viewer, element, attributes } = fakeContext({
      fittedRect: rect(620, 540, 1200, 600),
      textRect: rect(620, 540, 1200, 600),
      viewerPadding: { bottom: "100px" },
    });
    const restore = applyBackdropCompatibility(doc, viewer, geometry);
    expect(restore).toBeNull();
    expect(attributes.get("style")).toContain("-webkit-backdrop-filter:blur(10px)");
    expect(element.getAttribute("data-reader-backdrop-break")).toBeNull();
  });

  it("rejects a candidate that intrudes into the inter-column gap", () => {
    const { doc, viewer, element } = fakeContext({
      fittedRect: rect(520, 67, 1100, 300),
      textRect: rect(520, 67, 1100, 300),
    });
    expect(applyBackdropCompatibility(doc, viewer, { pageWidth: 500, step: 600 })).toBeNull();
    expect(element.getAttribute("data-reader-backdrop-break")).toBeNull();
  });

  it("rejects unsupported transform and generated content without writing style", () => {
    const transformed = fakeContext({ transform: "scale(1)" });
    expect(applyBackdropCompatibility(transformed.doc, transformed.viewer, geometry)).toBeNull();
    expect(transformed.attributes.get("style")).toBe(
      "background-color:red;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(25px)"
    );

    const generated = fakeContext({ beforeContent: "\"x\"" });
    expect(applyBackdropCompatibility(generated.doc, generated.viewer, geometry)).toBeNull();
    expect(generated.element.getAttribute("data-reader-backdrop-break")).toBeNull();
  });

  it("rejects when the real text Range falls into another column even if the box rect does not", () => {
    const { doc, viewer, element } = fakeContext({
      fittedRect: rect(620, 67, 1200, 300),
      textRect: rect(20, 67, 180, 300),
    });
    expect(applyBackdropCompatibility(doc, viewer, geometry)).toBeNull();
    expect(element.getAttribute("data-reader-backdrop-break")).toBeNull();
  });
});
