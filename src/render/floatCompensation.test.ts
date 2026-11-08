import { describe, expect, it } from "vitest";
import { createFloatWidthSession, createTrailingFloatSession } from "./floatCompensation";

function fakeFloatContext(text = "hello") {
  const styles = new Map<string, string>();
  const textNode = { nodeType: 3, textContent: text, parentElement: null as unknown as HTMLElement };
  const element = {
    nodeType: 1,
    tagName: "DIV",
    getAttribute: () => "",
    childNodes: [textNode],
    children: [],
    parentElement: null,
    style: {
      setProperty: (property: string, value: string) => styles.set(property, value),
      removeProperty: (property: string) => {
        styles.delete(property);
        return "";
      },
    },
  };
  textNode.parentElement = element as unknown as HTMLElement;
  const computed = {
    float: "left",
    writingMode: "horizontal-tb",
    width: "20px",
    display: "block",
    paddingLeft: "0px",
    paddingRight: "0px",
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    marginLeft: "0px",
    marginRight: "0px",
    fontFamily: "serif",
    fontWeight: "400",
    fontSize: "16px",
  };
  const ctx = { font: "", measureText: () => ({ width: 100 }) };
  const doc = {
    defaultView: {
      getComputedStyle: () => computed,
    },
    createElement: () => ({ getContext: () => ctx }),
  } as unknown as Document;
  const viewer = {
    clientWidth: 500,
    querySelectorAll: () => [element],
  } as unknown as HTMLElement;
  return { doc, viewer, element, styles };
}

describe("float width compensation session", () => {
  it("applies collapsed float widths and restores them, tolerating repeated restore", () => {
    const { doc, viewer, styles } = fakeFloatContext();
    const session = createFloatWidthSession();

    session.apply(doc, viewer);
    expect(styles.get("width")).toBe("100px");

    session.restore();
    expect(styles.has("width")).toBe(false);

    session.restore();
    expect(styles.has("width")).toBe(false);

    session.apply(doc, viewer);
    expect(styles.get("width")).toBe("100px");
    session.restore();
    expect(styles.has("width")).toBe(false);
  });

  it("a later apply keeps pending fixes and restore clears every pending element", () => {
    const first = fakeFloatContext();
    const second = fakeFloatContext();
    const session = createFloatWidthSession();

    session.apply(first.doc, first.viewer);
    session.apply(second.doc, second.viewer);
    expect(first.styles.get("width")).toBe("100px");
    expect(second.styles.get("width")).toBe("100px");

    session.restore();
    expect(first.styles.has("width")).toBe(false);
    expect(second.styles.has("width")).toBe(false);
  });
});

function fakeTrailingFloatContext() {
  const styles = new Map<string, string>();
  let applied = false;
  const beforeRects = [
    { left: 0, right: 50, top: 0, bottom: 150, width: 50, height: 150 },
    { left: 100, right: 150, top: 0, bottom: 50, width: 50, height: 50 },
  ];
  const afterRects = [
    { left: 0, right: 50, top: 0, bottom: 50, width: 50, height: 50 },
  ];
  const image = { nodeType: 1, tagName: "IMG", childNodes: [] };
  const candidate = {
    nodeType: 1,
    tagName: "DIV",
    childNodes: [image],
    style: {
      getPropertyValue: (property: string) => styles.get(property) ?? "",
      getPropertyPriority: () => "",
      setProperty: (property: string, value: string) => {
        styles.set(property, value);
        if (property === "margin-top") applied = true;
      },
      removeProperty: (property: string) => {
        styles.delete(property);
        if (property === "margin-top") applied = false;
        return "";
      },
    },
    getClientRects: () => (applied ? afterRects : beforeRects),
    scrollHeight: 150,
    querySelectorAll: () => [],
  };
  const viewer = {
    children: [candidate],
    scrollLeft: 0,
    clientLeft: 0,
    offsetWidth: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }),
  };
  const candidateStyle = { float: "left", position: "static", marginTop: "0px" };
  const viewerStyle = { paddingBottom: "0px", paddingLeft: "0px" };
  const doc = {
    defaultView: {
      getComputedStyle: (el: unknown) => (el === viewer ? viewerStyle : candidateStyle),
    },
  } as unknown as Document;
  return { doc, viewer: viewer as unknown as HTMLElement, candidate, styles };
}

describe("trailing float compensation session", () => {
  it("applies the margin-top fix and restores it, tolerating repeated restore", () => {
    const { doc, viewer, styles } = fakeTrailingFloatContext();
    const session = createTrailingFloatSession();

    session.apply(doc, viewer, { step: 100, pageWidth: 100, flowProgression: "ltr" });
    expect(styles.get("margin-top")).toBe("-51px");

    session.restore();
    expect(styles.has("margin-top")).toBe(false);

    session.restore();
    expect(styles.has("margin-top")).toBe(false);

    session.apply(doc, viewer, { step: 100, pageWidth: 100, flowProgression: "ltr" });
    expect(styles.get("margin-top")).toBe("-51px");
    session.restore();
    expect(styles.has("margin-top")).toBe(false);
  });

  it("a later apply keeps pending fixes and restore clears every pending element", () => {
    const first = fakeTrailingFloatContext();
    const second = fakeTrailingFloatContext();
    const session = createTrailingFloatSession();
    const geometry = { step: 100, pageWidth: 100, flowProgression: "ltr" as const };

    session.apply(first.doc, first.viewer, geometry);
    session.apply(second.doc, second.viewer, geometry);
    expect(first.styles.get("margin-top")).toBe("-51px");
    expect(second.styles.get("margin-top")).toBe("-51px");

    session.restore();
    expect(first.styles.has("margin-top")).toBe(false);
    expect(second.styles.has("margin-top")).toBe(false);
  });
});
