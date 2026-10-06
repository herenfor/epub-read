import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import {
  attachReaderPaint,
  grayscaleFilterMatrix,
  invertFilterMatrix,
  saturationFilterMatrix,
  setColorAssistMatrixProvider,
  sharpenFilterKernel,
} from "./readerVisualPaint";
import {
  DEFAULT_VISUAL_PREFERENCES,
  VISUAL_PREFERENCES_STORAGE_KEY,
  loadVisualPreferences,
  normalizeVisualPreferences,
  resetVisualFilterPreferences,
  saveVisualPreferences,
  type ReaderVisualPreferences,
} from "./readerVisualPreferences";
import { ReaderVisualSettingsPanel } from "../../ui/visual/ReaderVisualSettingsPanel";

function setup() {
  const { document } = parseHTML("<!doctype html><html><body><div id='host'><div id='surface'></div></div></body></html>");
  const host = document.getElementById("host");
  const surface = document.getElementById("surface");
  if (!host || !surface) throw new Error("fixture not built");
  return { document, host, surface };
}

function preferences(patch: Partial<ReaderVisualPreferences> = {}): ReaderVisualPreferences {
  return normalizeVisualPreferences({
    ...DEFAULT_VISUAL_PREFERENCES,
    ...patch,
    colorAssist: {
      ...DEFAULT_VISUAL_PREFERENCES.colorAssist,
      ...(patch.colorAssist ?? {}),
    },
  });
}

function filterChildren(host: HTMLElement): Element[] {
  const filter = host.querySelector("filter");
  return filter ? Array.from(filter.children) : [];
}

function overlayElement(host: HTMLElement): HTMLElement {
  const overlay = host.querySelector(".reader-visual-dim-overlay");
  if (!overlay) throw new Error("overlay not found");
  return overlay as HTMLElement;
}

describe("reader visual paint", () => {
  it("bypasses when the total switch is off or compare-original is held", () => {
    const { host, surface } = setup();
    surface.style.color = "red";
    const handle = attachReaderPaint(surface, host, preferences());

    expect(surface.style.filter).toBe("none");
    expect(filterChildren(host)).toEqual([]);
    expect(overlayElement(host).style.display).toBe("none");

    handle.update(preferences({ enabled: true, invert: true, dim: 0.4 }), false);
    expect(surface.style.filter).toContain('url("#');
    expect(filterChildren(host)).toHaveLength(1);
    expect(overlayElement(host).style.display).toBe("block");
    expect(overlayElement(host).style.opacity).toBe("0.4");

    handle.update(preferences({ enabled: true, invert: true, dim: 0.4 }), true);
    expect(surface.style.filter).toBe("none");
    expect(filterChildren(host)).toEqual([]);
    expect(overlayElement(host).style.display).toBe("none");

    handle.update(preferences({ enabled: true, dim: 0.4 }), false);
    expect(surface.style.filter).toBe("none");
    expect(filterChildren(host)).toEqual([]);
    expect(overlayElement(host).style.display).toBe("block");

    handle.dispose();
    expect(surface.style.filter).toBe("");
    expect(surface.style.color).toBe("red");
    expect(host.querySelector(".reader-visual-filter-defs")).toBeNull();
    expect(host.querySelector(".reader-visual-dim-overlay")).toBeNull();
  });

  it("emits color and convolution primitives in the frozen order and releases them on dispose", () => {
    const { host, surface } = setup();
    const handle = attachReaderPaint(surface, host, preferences({
      enabled: true,
      saturation: 0.5,
      grayscale: 0.25,
      invert: true,
      sharpen: 0.5,
      dim: 0.3,
    }));

    const primitives = filterChildren(host);
    expect(primitives.map((node) => node.tagName.toLowerCase())).toEqual([
      "fecolormatrix",
      "fecolormatrix",
      "fecolormatrix",
      "feconvolvematrix",
    ]);
    expect(primitives[0]?.getAttribute("color-interpolation-filters")).toBe("sRGB");
    expect(primitives[0]?.getAttribute("values")).toBe(saturationFilterMatrix(0.5));
    expect(primitives[1]?.getAttribute("values")).toBe(grayscaleFilterMatrix(0.25));
    expect(primitives[2]?.getAttribute("values")).toBe(invertFilterMatrix());
    expect(primitives[3]?.getAttribute("kernelMatrix")).toBe(sharpenFilterKernel(0.5));
    expect(primitives[3]?.getAttribute("order")).toBe("3");
    expect(primitives[3]?.getAttribute("divisor")).toBe("1");
    expect(primitives[3]?.getAttribute("edgeMode")).toBe("duplicate");
    expect(primitives[3]?.getAttribute("preserveAlpha")).toBe("true");
    expect(primitives[0]?.getAttribute("in")).toBe("SourceGraphic");
    expect(primitives[1]?.getAttribute("in")).toBe(primitives[0]?.getAttribute("result"));

    const overlay = overlayElement(host);
    expect(overlay.style.display).toBe("block");
    expect(overlay.style.opacity).toBe("0.3");
    expect(overlay.getAttribute("style")).toContain("pointer-events:none");

    handle.dispose();
    expect(host.querySelector(".reader-visual-filter-defs")).toBeNull();
    expect(host.querySelector(".reader-visual-dim-overlay")).toBeNull();
    expect(surface.style.filter).toBe("");
  });

  it("puts an FX-2 matrix in the first linearRGB primitive and keeps later color primitives in sRGB", () => {
    const { host, surface } = setup();
    const matrix = "0.1 0.2 0.3 0 0.05 0.4 0.5 0.6 0 0.07 0.7 0.8 0.9 0 0.09 0 0 0 1 0";
    setColorAssistMatrixProvider(() => matrix);
    const handle = attachReaderPaint(surface, host, preferences({
      enabled: true,
      saturation: 1.2,
      colorAssist: { kind: "protan", strength: 0.5 },
    }));

    try {
      const primitives = filterChildren(host);
      expect(primitives).toHaveLength(2);
      expect(primitives[0]?.getAttribute("values")).toBe(matrix);
      expect(primitives[0]?.getAttribute("color-interpolation-filters")).toBe("linearRGB");
      expect(primitives[1]?.getAttribute("color-interpolation-filters")).toBe("sRGB");
      expect(primitives[1]?.getAttribute("values")).toBe(saturationFilterMatrix(1.2));
      expect(primitives[1]?.getAttribute("in")).toBe(primitives[0]?.getAttribute("result"));
    } finally {
      setColorAssistMatrixProvider(null);
      handle.dispose();
    }
  });
  it("renders the controlled panel and reserves the FX-2 slot", () => {
    const html = renderToStaticMarkup(createElement(ReaderVisualSettingsPanel, {
      value: preferences({ enabled: true, grayscale: 0.5 }),
      onChange: () => {},
      compareOriginal: true,
      onCompareOriginalChange: () => {},
      colorAssistSlot: createElement("div", { id: "fx2-preview" }, "FX-2"),
    }));
    expect(html).toContain("画面滤镜");
    expect(html).toContain('data-visual-slot="color-assist"');
    expect(html).toContain('id="fx2-preview"');
    expect(html).toContain("临时查看原画面");
    expect(html).toContain('aria-pressed="true"');
  });
  it("shares one viewport filter id and black overlay across visible surfaces", () => {
    const { document, host, surface } = setup();
    const secondSurface = document.createElement("div");
    const first = attachReaderPaint(surface, host, preferences({ enabled: true, invert: true, dim: 0.2 }));
    const second = attachReaderPaint(secondSurface, host, preferences({ enabled: true, invert: true, dim: 0.2 }));

    const filters = host.querySelectorAll("filter");
    expect(filters).toHaveLength(1);
    const filterId = filters[0]?.getAttribute("id") ?? "";
    expect(filterId).not.toBe("");
    expect(surface.style.filter).toContain(filterId);
    expect(secondSurface.style.filter).toContain(filterId);
    expect(host.querySelectorAll(".reader-visual-dim-overlay")).toHaveLength(1);

    second.update(preferences({ enabled: true, saturation: 0.5, dim: 0.2 }), false);
    expect(filterChildren(host)).toHaveLength(1);
    expect(filterChildren(host)[0]?.getAttribute("values")).toBe(saturationFilterMatrix(0.5));

    first.dispose();
    expect(surface.style.filter).toBe("");
    expect(secondSurface.style.filter).toContain(filterId);
    expect(host.querySelector("filter")).not.toBeNull();
    expect(host.querySelector(".reader-visual-dim-overlay")).not.toBeNull();

    second.dispose();
    expect(secondSurface.style.filter).toBe("");
    expect(host.querySelector("filter")).toBeNull();
    expect(host.querySelector(".reader-visual-dim-overlay")).toBeNull();
  });
});

describe("reader visual preferences", () => {
  it("sanitizes old/corrupt local values at the read boundary and preserves the FX-2 slot on reset", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    values.set(VISUAL_PREFERENCES_STORAGE_KEY, JSON.stringify({
      enabled: "yes",
      invert: true,
      grayscale: 2,
      saturation: -1,
      sharpen: 0.5,
      dim: 9,
      colorAssist: { kind: "deutan", strength: "nope" },
    }));
    const loaded = loadVisualPreferences(storage);
    expect(loaded.enabled).toBe(false);
    expect(loaded.invert).toBe(true);
    expect(loaded.grayscale).toBe(1);
    expect(loaded.saturation).toBe(0);
    expect(loaded.sharpen).toBe(0.5);
    expect(loaded.dim).toBe(0.8);
    expect(loaded.colorAssist).toEqual({ kind: "deutan", strength: 0.5 });

    values.set(VISUAL_PREFERENCES_STORAGE_KEY, "{bad json");
    expect(loadVisualPreferences(storage)).toEqual(DEFAULT_VISUAL_PREFERENCES);

    const reset = resetVisualFilterPreferences({
      ...loaded,
      enabled: true,
      colorAssist: { kind: "tritan", strength: 0.9 },
    });
    expect(reset.enabled).toBe(false);
    expect(reset.grayscale).toBe(0);
    expect(reset.colorAssist).toEqual({ kind: "tritan", strength: 0.9 });

    saveVisualPreferences(reset, storage);
    expect(JSON.parse(values.get(VISUAL_PREFERENCES_STORAGE_KEY) ?? "{}")).toEqual(reset);
  });
});
