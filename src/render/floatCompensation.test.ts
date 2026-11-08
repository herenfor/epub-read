import { describe, expect, it } from "vitest";
import { createFloatWidthSession } from "./floatCompensation";

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
