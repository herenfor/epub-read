import {
  type ColorAssistKind,
  type ReaderPaintHandle,
  type ReaderVisualPreferences,
} from "./readerVisualPreferences";

export type ColorAssistMatrixProvider = (
  kind: Exclude<ColorAssistKind, "off">,
  strength: number,
) => string | null;

export interface ReaderVisualFilterNode {
  element: "feColorMatrix" | "feConvolveMatrix";
  attributes: Record<string, string>;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const FILTER_CLASS = "reader-visual-filter-defs";
const OVERLAY_CLASS = "reader-visual-dim-overlay";

const SATURATION_LUMINANCE = [0.213, 0.715, 0.072] as const;
const GRAYSCALE_LUMINANCE = [0.2126, 0.7152, 0.0722] as const;

let nextFilterId = 0;
let colorAssistMatrixProvider: ColorAssistMatrixProvider | null = null;

/**
 * FX-2 registers its fused 4x5 matrix here. The matrix is emitted as the first
 * SVG filter primitive and is the only node that declares linearRGB.
 */
export function setColorAssistMatrixProvider(provider: ColorAssistMatrixProvider | null): void {
  colorAssistMatrixProvider = provider;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function matrixValues(values: readonly number[]): string {
  return values.map(formatNumber).join(" ");
}

/** W3C CSS filter saturate() matrix. */
export function saturationFilterMatrix(saturation: number): string {
  const s = saturation;
  const [r, g, b] = SATURATION_LUMINANCE;
  return matrixValues([
    r * (1 - s) + s, g * (1 - s), b * (1 - s), 0, 0,
    r * (1 - s), g * (1 - s) + s, b * (1 - s), 0, 0,
    r * (1 - s), g * (1 - s), b * (1 - s) + s, 0, 0,
    0, 0, 0, 1, 0,
  ]);
}

/** W3C CSS filter grayscale() matrix. */
export function grayscaleFilterMatrix(grayscale: number): string {
  const g = grayscale;
  const [r, gr, b] = GRAYSCALE_LUMINANCE;
  const inverse = 1 - g;
  return matrixValues([
    inverse + r * g, gr * g, b * g, 0, 0,
    r * g, inverse + gr * g, b * g, 0, 0,
    r * g, gr * g, inverse + b * g, 0, 0,
    0, 0, 0, 1, 0,
  ]);
}

/** RGB slope=-1/intercept=1, alpha identity. */
export function invertFilterMatrix(): string {
  return matrixValues([
    -1, 0, 0, 0, 1,
    0, -1, 0, 0, 1,
    0, 0, -1, 0, 1,
    0, 0, 0, 1, 0,
  ]);
}

/** Unsharp-style 3x3 kernel: [0,-q,0,-q,1+4q,-q,0,-q,0]. */
export function sharpenFilterKernel(sharpen: number): string {
  const q = sharpen;
  return matrixValues([0, -q, 0, -q, 1 + 4 * q, -q, 0, -q, 0]);
}

function activeColorAssistMatrix(preferences: ReaderVisualPreferences): string | null {
  const kind = preferences.colorAssist.kind;
  const strength = preferences.colorAssist.strength;
  if (kind === "off" || !(strength > 0) || !colorAssistMatrixProvider) return null;
  try {
    return colorAssistMatrixProvider(kind, strength);
  } catch {
    return null;
  }
}

function sameReaderVisualPreferences(
  a: ReaderVisualPreferences,
  b: ReaderVisualPreferences,
): boolean {
  return (
    a.enabled === b.enabled &&
    a.invert === b.invert &&
    a.grayscale === b.grayscale &&
    a.saturation === b.saturation &&
    a.sharpen === b.sharpen &&
    a.dim === b.dim &&
    a.colorAssist.kind === b.colorAssist.kind &&
    a.colorAssist.strength === b.colorAssist.strength
  );
}

/**
 * Build the ordered SVG primitive list shared by every viewport.
 * Order is frozen: FX-2 linearRGB matrix -> saturation -> grayscale -> invert -> sharpen.
 */
export function readerVisualFilterNodes(
  preferences: ReaderVisualPreferences,
  colorAssistMatrix = activeColorAssistMatrix(preferences),
): ReaderVisualFilterNode[] {
  const nodes: ReaderVisualFilterNode[] = [];
  if (colorAssistMatrix) {
    nodes.push({
      element: "feColorMatrix",
      attributes: {
        type: "matrix",
        values: colorAssistMatrix,
        "color-interpolation-filters": "linearRGB",
      },
    });
  }
  if (preferences.saturation !== 1) {
    nodes.push({
      element: "feColorMatrix",
      attributes: {
        type: "matrix",
        values: saturationFilterMatrix(preferences.saturation),
        "color-interpolation-filters": "sRGB",
      },
    });
  }
  if (preferences.grayscale > 0) {
    nodes.push({
      element: "feColorMatrix",
      attributes: {
        type: "matrix",
        values: grayscaleFilterMatrix(preferences.grayscale),
        "color-interpolation-filters": "sRGB",
      },
    });
  }
  if (preferences.invert) {
    nodes.push({
      element: "feColorMatrix",
      attributes: {
        type: "matrix",
        values: invertFilterMatrix(),
        "color-interpolation-filters": "sRGB",
      },
    });
  }
  if (preferences.sharpen > 0) {
    nodes.push({
      element: "feConvolveMatrix",
      attributes: {
        order: "3",
        kernelMatrix: sharpenFilterKernel(preferences.sharpen),
        divisor: "1",
        edgeMode: "duplicate",
        preserveAlpha: "true",
        "color-interpolation-filters": "sRGB",
      },
    });
  }
  return nodes;
}

interface SurfaceRegistration {
  surface: HTMLElement;
  originalFilter: string;
  originalBackground: string;
  /** Same paper color as the visible reader background, applied only while filters are active. */
  background: string | null;
}

interface PaintGroup {
  document: Document;
  overlayHost: HTMLElement;
  svg: Element;
  filter: Element;
  overlay: HTMLDivElement;
  filterId: string;
  surfaces: SurfaceRegistration[];
  preferences: ReaderVisualPreferences;
  compareOriginal: boolean;
  filterSignature: string | null;
  forceNextFlush: boolean;
  scheduled: boolean;
  pendingFrame: number | null;
}

/**
 * One mounted overlay host is one viewport. Multiple visible iframes in that
 * viewport can share the same filter resources, while each surface keeps its
 * own original inline filter for disposal.
 */
const paintGroups = new WeakMap<HTMLElement, PaintGroup>();

function createFilterId(): string {
  nextFilterId += 1;
  return `reader-visual-${nextFilterId}`;
}

function createPaintGroup(
  surface: HTMLElement,
  overlayHost: HTMLElement,
  initial: ReaderVisualPreferences,
  background: string | null,
): PaintGroup {
  const document = overlayHost.ownerDocument ?? surface.ownerDocument;
  if (!document) throw new Error("reader visual paint surface is not in a document");
  if (surface.ownerDocument && surface.ownerDocument !== document) {
    throw new Error("reader visual paint surface and overlay host must share one document");
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", FILTER_CLASS);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none");
  const defs = document.createElementNS(SVG_NS, "defs");
  const filter = document.createElementNS(SVG_NS, "filter");
  const filterId = createFilterId();
  filter.setAttribute("id", filterId);
  filter.setAttribute("color-interpolation-filters", "sRGB");
  defs.appendChild(filter);
  svg.appendChild(defs);
  overlayHost.appendChild(svg);

  const overlay = document.createElement("div");
  overlay.className = OVERLAY_CLASS;
  overlay.setAttribute("aria-hidden", "true");
  overlay.setAttribute("style", [
    "position:absolute",
    "inset:0",
    "display:none",
    "pointer-events:none",
    "background:#000",
    "opacity:0",
  ].join(";"));
  overlayHost.appendChild(overlay);

  const group: PaintGroup = {
    document,
    overlayHost,
    svg,
    filter,
    overlay,
    filterId,
    surfaces: [{
      surface,
      originalFilter: surface.style.filter,
      originalBackground: surface.style.backgroundColor,
      background,
    }],
    preferences: initial,
    compareOriginal: false,
    filterSignature: null,
    forceNextFlush: false,
    scheduled: false,
    pendingFrame: null,
  };
  paintGroups.set(overlayHost, group);
  return group;
}

function applySurfaceState(group: PaintGroup, registration: SurfaceRegistration): void {
  const active = group.filterSignature !== null && group.filterSignature !== "";
  registration.surface.style.filter = group.filter.firstChild
    ? `url("#${group.filterId}")`
    : "none";
  if (active && registration.background) {
    registration.surface.style.backgroundColor = registration.background;
  } else {
    registration.surface.style.backgroundColor = registration.originalBackground;
  }
}

function acquirePaintGroup(
  surface: HTMLElement,
  overlayHost: HTMLElement,
  initial: ReaderVisualPreferences,
  background: string | null,
): PaintGroup {
  const existing = paintGroups.get(overlayHost);
  if (!existing) return createPaintGroup(surface, overlayHost, initial, background);
  if (surface.ownerDocument && surface.ownerDocument !== existing.document) {
    throw new Error("reader visual paint surface and overlay host must share one document");
  }
  if (existing.surfaces.some((registration) => registration.surface === surface)) {
    throw new Error("reader visual paint surface is already attached to this viewport");
  }
  const registration = {
    surface,
    originalFilter: surface.style.filter,
    originalBackground: surface.style.backgroundColor,
    background,
  };
  existing.surfaces.push(registration);
  applySurfaceState(existing, registration);
  return existing;
}

function clearFilterNodes(group: PaintGroup): void {
  while (group.filter.firstChild) group.filter.removeChild(group.filter.firstChild);
}

function syncFilterNodes(group: PaintGroup, nodes: readonly ReaderVisualFilterNode[]): void {
  clearFilterNodes(group);
  let input = "SourceGraphic";
  nodes.forEach((node, index) => {
    const element = group.document.createElementNS(SVG_NS, node.element);
    const result = `${group.filterId}-result-${index}`;
    element.setAttribute("in", input);
    element.setAttribute("result", result);
    for (const [name, value] of Object.entries(node.attributes)) {
      element.setAttribute(name, value);
    }
    group.filter.appendChild(element);
    input = result;
  });
}

function applyGroupPreferences(
  group: PaintGroup,
  preferences: ReaderVisualPreferences,
  compareOriginal: boolean,
  force = false,
): void {
  const effectiveChanged =
    force ||
    group.filterSignature === null ||
    group.compareOriginal !== compareOriginal ||
    !sameReaderVisualPreferences(group.preferences, preferences);
  if (!effectiveChanged) return;

  group.preferences = preferences;
  group.compareOriginal = compareOriginal;
  const active = preferences.enabled && !compareOriginal;
  const nodes = active ? readerVisualFilterNodes(preferences) : [];
  const filterValue = nodes.length > 0 ? `url("#${group.filterId}")` : "none";
  const signature = active ? JSON.stringify(nodes) : "";
  if (signature !== group.filterSignature) {
    if (nodes.length > 0) {
      syncFilterNodes(group, nodes);
    } else {
      clearFilterNodes(group);
    }
    group.filterSignature = signature;
  }
  for (const registration of group.surfaces) {
    registration.surface.style.filter = filterValue;
    if (active && registration.background) {
      registration.surface.style.backgroundColor = registration.background;
    } else if (registration.surface.style.backgroundColor !== registration.originalBackground) {
      registration.surface.style.backgroundColor = registration.originalBackground;
    }
  }

  const dim = active ? preferences.dim : 0;
  if (dim > 0) {
    group.overlay.style.display = "block";
    group.overlay.style.opacity = formatNumber(dim);
  } else {
    group.overlay.style.display = "none";
    group.overlay.style.opacity = "0";
  }
}

function cancelGroupFrame(group: PaintGroup): void {
  if (group.pendingFrame !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(group.pendingFrame);
  }
  group.pendingFrame = null;
  group.scheduled = false;
}

function scheduleGroupFlush(group: PaintGroup): void {
  if (group.scheduled || group.surfaces.length === 0) return;
  group.scheduled = true;
  if (typeof requestAnimationFrame === "function") {
    group.pendingFrame = requestAnimationFrame(() => {
      group.scheduled = false;
      group.pendingFrame = null;
      const force = group.forceNextFlush;
      group.forceNextFlush = false;
      if (paintGroups.get(group.overlayHost) === group && group.surfaces.length > 0) {
        applyGroupPreferences(group, group.preferences, group.compareOriginal, force);
      }
    });
    return;
  }
  group.scheduled = false;
  const force = group.forceNextFlush;
  group.forceNextFlush = false;
  applyGroupPreferences(group, group.preferences, group.compareOriginal, force);
}

function removePaintGroup(group: PaintGroup): void {
  cancelGroupFrame(group);
  clearFilterNodes(group);
  group.svg.remove();
  group.overlay.remove();
  group.surfaces = [];
  paintGroups.delete(group.overlayHost);
}

/**
 * Attach a viewport-local SVG filter and black overlay to one visible book
 * paint surface. Multiple surfaces attached to the same overlay host share
 * one filter id, one defs node, and one black overlay. It reads no layout,
 * starts no polling, and only mutates the surface filter property plus the
 * nodes it owns.
 */
export function attachReaderPaint(
  surface: HTMLElement,
  overlayHost: HTMLElement,
  initial: ReaderVisualPreferences,
  surfaceBackground: string | null = null,
): ReaderPaintHandle {
  const group = acquirePaintGroup(surface, overlayHost, initial, surfaceBackground);
  applyGroupPreferences(group, group.preferences, group.compareOriginal);
  let disposed = false;

  return {
    update(preferences, compareOriginal) {
      if (disposed) return;
      if (
        group.compareOriginal === compareOriginal &&
        sameReaderVisualPreferences(group.preferences, preferences)
      ) {
        return;
      }
      group.preferences = preferences;
      group.compareOriginal = compareOriginal;
      group.forceNextFlush = true;
      scheduleGroupFlush(group);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const registration = group.surfaces.find((candidate) => candidate.surface === surface);
      group.surfaces = group.surfaces.filter((candidate) => candidate.surface !== surface);
      if (registration) {
        surface.style.filter = registration.originalFilter;
        surface.style.backgroundColor = registration.originalBackground;
      }
      if (group.surfaces.length === 0) removePaintGroup(group);
    },
  };
}
