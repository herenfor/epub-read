import { describe, expect, it } from "vitest";
import { applyBasicVerticalShell, basicVerticalMode, verticalProgression } from "./basicVertical";

describe("basic vertical compatibility", () => {
  it("only routes actual paginated reflowable vertical styles", () => {
    expect(basicVerticalMode(" vertical-rl ", false, false)).toBe("vertical-rl");
    expect(basicVerticalMode("vertical-lr", false, false)).toBe("vertical-lr");
    expect(basicVerticalMode("horizontal-tb", false, false)).toBeNull();
    expect(basicVerticalMode("vertical-rl", true, false)).toBeNull();
    expect(basicVerticalMode("vertical-rl", false, true)).toBeNull();
    expect(verticalProgression("vertical-rl")).toBe("rtl");
    expect(verticalProgression("vertical-lr")).toBe("ltr");
  });

  it("isolates the shell, preserves authored glyph direction and restores styles exactly", () => {
    function element(initial: Array<[string, string, string]> = []) {
      const properties = new Map(initial.map(([key, value, priority]) => [key, { value, priority }]));
      const attributes = new Map<string, string>();
      return { properties, attributes, style: {
        getPropertyValue: (key: string) => properties.get(key)?.value ?? "",
        getPropertyPriority: (key: string) => properties.get(key)?.priority ?? "",
        setProperty: (key: string, value: string, priority = "") => { properties.set(key, { value, priority }); },
        removeProperty: (key: string) => { properties.delete(key); },
      }, getAttribute: (key: string) => attributes.get(key) ?? null,
      setAttribute: (key: string, value: string) => { attributes.set(key, value); },
      removeAttribute: (key: string) => { attributes.delete(key); } };
    }
    const documentElement = element([["writing-mode", "vertical-rl", "important"]]);
    const body = element([["color", "red", ""]]);
    const viewer = { ...element([["font-size", "20px", ""], ["direction", "ltr", ""]]),
      ownerDocument: { documentElement, body } };
    const originals = [documentElement, body, viewer].map(e => Array.from(e.properties.entries()));
    const restore = applyBasicVerticalShell(viewer as unknown as HTMLElement, "vertical-rl");
    expect(viewer.getAttribute("data-reader-vertical")).toBe("vertical-rl");
    expect(body.style.getPropertyValue("writing-mode")).toBe("horizontal-tb");
    expect(viewer.style.getPropertyValue("writing-mode")).toBe("vertical-rl");
    expect(viewer.style.getPropertyValue("direction")).toBe("ltr");
    restore();
    expect(viewer.getAttribute("data-reader-vertical")).toBeNull();
    expect([documentElement, body, viewer].map(e => Array.from(e.properties.entries()))).toEqual(originals);
  });
});
