import { describe, expect, it } from "vitest";
import { applyBasicVerticalShell, applyBasicVerticalMediaBounds, basicVerticalAutoMargins, basicVerticalGridBottom, basicVerticalMode, verticalProgression } from "./basicVertical";

describe("basic vertical compatibility", () => {
  it("keeps the head position, reserves the foot and fits a whole-character line length", () => {
    const margins = basicVerticalAutoMargins(16, { top: 42, bottom: 34, left: 20, right: 20 });
    expect(margins).toEqual({ top: 42, bottom: 64, left: 32, right: 32 });
    const bottom = basicVerticalGridBottom(798, margins.top, margins.bottom, 16);
    expect(bottom).toBe(68);
    expect((798 - margins.top - bottom) / 16).toBe(43);
    expect(basicVerticalGridBottom(800, 48, 64, 16)).toBe(64);
    expect(basicVerticalGridBottom(160, 48, 64, 16)).toBe(64);
    // Caller supplies the selected margins first; the grid does not shrink
    // them or redistribute the remainder to the already aligned head.
    expect(basicVerticalGridBottom(798, 50, 80, 16)).toBe(92);
  });
  it("bounds illustrations to one leaf and restores the original media styles", () => {
    const properties = new Map<string, { value: string; priority: string }>([
      ["max-width", { value: "100%", priority: "" }],
    ]);
    const image = { style: {
      getPropertyValue: (key: string) => properties.get(key)?.value ?? "",
      getPropertyPriority: (key: string) => properties.get(key)?.priority ?? "",
      setProperty: (key: string, value: string, priority: string) => { properties.set(key, { value, priority }); },
      removeProperty: (key: string) => { properties.delete(key); },
    } };
    const viewer = { querySelectorAll: () => [image] } as unknown as HTMLElement;
    const restore = applyBasicVerticalMediaBounds(viewer, 340, 640);
    expect(properties.get("max-width")).toEqual({ value: "340px", priority: "important" });
    expect(properties.get("max-height")?.value).toBe("640px");
    restore();
    expect(properties.get("max-width")).toEqual({ value: "100%", priority: "" });
    expect(properties.has("max-height")).toBe(false);
  });
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
