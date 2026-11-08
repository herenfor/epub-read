import { describe, expect, it } from "vitest";
import { applyReaderBodyPercentageSpacing, createPercentageSpacingSession, projectPercentageSpacing, projectPercentageSpacingToLocalWidth } from "./percentageSpacing";

describe("percentage spacing uses the reader measure", () => {
  it("projects vertical margin and padding without treating them as height percentages", () => {
    expect(projectPercentageSpacing("40%", 1280, 640)).toBe("256px");
    expect(projectPercentageSpacing("5%", 1280, 640)).toBe("32px");
    expect(projectPercentageSpacing("40%", 1280, 960)).toBe("384px");
  });
  it("preserves resolved length terms and negative percentages in computed math", () => {
    expect(projectPercentageSpacing("calc(40% + 32px)", 1280, 640)).toBe("calc(256px + 32px)");
    expect(projectPercentageSpacing("calc(-5% + 32px)", 1280, 640)).toBe("calc(-32px + 32px)");
    expect(projectPercentageSpacing("clamp(16px, 10%, 100px)", 1280, 640)).toBe("clamp(16px, 64px, 100px)");
  });
  it("leaves lengths, auto, narrow containing blocks and invalid geometry untouched", () => {
    for (const value of ["16px", "auto", "0px"]) expect(projectPercentageSpacing(value, 1280, 640)).toBeNull();
    for (const width of [500, 640, 0, NaN]) expect(projectPercentageSpacing("40%", width, 640)).toBeNull();
  });
  it("projects正文 direct-child spacing to the local width even below the measure cap", () => {
    expect(projectPercentageSpacingToLocalWidth("10%", 588, 640)).toBe("58.8px");
    expect(projectPercentageSpacingToLocalWidth("10%", 1200, 640)).toBe("64px");
    expect(projectPercentageSpacingToLocalWidth("16px", 588, 640)).toBeNull();
  });
});

describe("page-level percentage spacing uses the current physical column", () => {
  const makeReaderTop = () => {
    const values = new Map<string, string>();
    const priorities = new Map<string, string>();
    const el = {
      classList: { contains: (name: string) => name === "reader-top" },
      matches: () => false,
      style: {
        getPropertyValue: (property: string) => values.get(property) ?? "",
        getPropertyPriority: (property: string) => priorities.get(property) ?? "",
        setProperty: (property: string, value: string, priority = "") => {
          values.set(property, value);
          if (priority) priorities.set(property, priority);
          else priorities.delete(property);
        },
        removeProperty: (property: string) => {
          values.delete(property);
          priorities.delete(property);
          return "";
        },
      },
      computedStyleMap: () => new Map([["padding-left", { toString: () => "10%" }]]),
    };
    return { el: el as unknown as HTMLElement, values, priorities };
  };

  const docFor = (): Document => ({
    defaultView: {
      getComputedStyle: () => ({ writingMode: "horizontal-tb", position: "static", float: "none", width: "200px" }),
      CSS: { supports: () => true },
    },
    body: {},
  } as unknown as Document);

  it("uses the physical column width, not the whole body width", () => {
    const { el, values, priorities } = makeReaderTop();
    const viewer = { children: [el] } as unknown as HTMLElement;
    const restore = applyReaderBodyPercentageSpacing(docFor(), viewer, 588, 640);
    expect(values.get("padding-left")).toBe("58.8px");
    expect(priorities.get("padding-left")).toBe("important");
    restore();
  });

  it("projects against the reader measure once the local containing width exceeds it", () => {
    const { el, values, priorities } = makeReaderTop();
    const viewer = { children: [el] } as unknown as HTMLElement;
    const restore = applyReaderBodyPercentageSpacing(docFor(), viewer, 1000, 640);
    expect(values.get("padding-left")).toBe("64px");
    expect(priorities.get("padding-left")).toBe("important");
    restore();
    expect(values.get("padding-left")).toBeUndefined();
  });
});

describe("percentage spacing session", () => {
  function spacingElement(properties: Record<string, string>) {
    const values = new Map<string, string>();
    const priorities = new Map<string, string>();
    const style = {
      getPropertyValue: (property: string) => values.get(property) ?? "",
      getPropertyPriority: (property: string) => priorities.get(property) ?? "",
      setProperty: (property: string, value: string, priority = "") => {
        values.set(property, value);
        if (priority) priorities.set(property, priority);
        else priorities.delete(property);
      },
      removeProperty: (property: string) => {
        values.delete(property);
        priorities.delete(property);
        return "";
      },
    } as unknown as CSSStyleDeclaration;
    const el = {
      style,
      clientWidth: 1000,
      classList: { contains: () => false },
      matches: () => false,
      computedStyleMap: () =>
        new Map(Object.entries(properties).map(([property, value]) => [property, { toString: () => value }])),
    };
    return { el: el as unknown as HTMLElement, values, priorities };
  }

  function sessionDoc(
    root: ReturnType<typeof spacingElement>,
    body: ReturnType<typeof spacingElement>,
  ): Document {
    return {
      defaultView: {
        getComputedStyle: () => ({ writingMode: "horizontal-tb", position: "static", float: "none", width: "200px" }),
        CSS: { supports: () => true },
      },
      documentElement: root.el,
      body: body.el,
    } as unknown as Document;
  }

  it("restores root then body spacing and tolerates repeated restore", () => {
    const root = spacingElement({ "padding-left": "10%" });
    const body = spacingElement({ "padding-top": "10%" });
    const readerTop = spacingElement({ "padding-left": "10%" });
    (readerTop.el as unknown as { classList: { contains(name: string): boolean } }).classList = {
      contains: (name: string) => name === "reader-top",
    };
    const viewer = { children: [readerTop.el] } as unknown as HTMLElement;
    const doc = sessionDoc(root, body);
    const session = createPercentageSpacingSession();

    session.applyRoot(doc, viewer, 640);
    session.applyBody(doc, viewer, 588, 640);
    expect(root.values.get("padding-left")).toBe("64px");
    expect(body.values.get("padding-top")).toBe("64px");
    expect(readerTop.values.get("padding-left")).toBe("58.8px");

    session.restore();
    expect(root.values.size).toBe(0);
    expect(body.values.size).toBe(0);
    expect(readerTop.values.size).toBe(0);

    session.restore();
    expect(root.values.size).toBe(0);
    expect(body.values.size).toBe(0);
    expect(readerTop.values.size).toBe(0);

    session.applyRoot(doc, viewer, 640, false);
    expect(root.values.size).toBe(0);
    session.restore();
    expect(root.values.size).toBe(0);
  });

  it("a later root apply replaces the previous handle without restoring it first", () => {
    const firstRoot = spacingElement({ "padding-left": "10%" });
    const secondRoot = spacingElement({ "padding-left": "10%" });
    const session = createPercentageSpacingSession();
    const emptyViewer = { children: [] } as unknown as HTMLElement;

    session.applyRoot(sessionDoc(firstRoot, spacingElement({})), emptyViewer, 640);
    session.applyRoot(sessionDoc(secondRoot, spacingElement({})), emptyViewer, 640);
    expect(firstRoot.values.get("padding-left")).toBe("64px");
    expect(secondRoot.values.get("padding-left")).toBe("64px");

    session.restore();
    expect(firstRoot.values.get("padding-left")).toBe("64px");
    expect(secondRoot.values.size).toBe(0);
  });
});
