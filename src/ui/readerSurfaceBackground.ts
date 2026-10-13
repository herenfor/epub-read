/** Actual paper color for visual filters; each engine supplies its host selector. */
export function surfaceBackground(surface: HTMLElement, hostSelector: string): string | null {
  const contentDoc = (surface as HTMLIFrameElement).contentDocument;
  if (contentDoc && contentDoc.defaultView) {
    try {
      for (const candidate of [contentDoc.body, contentDoc.documentElement]) {
        if (!candidate) continue;
        const color = contentDoc.defaultView.getComputedStyle(candidate).backgroundColor;
        if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
      }
    } catch {
      // Cross-origin or detached iframe fallback
    }
  }

  const doc = surface.ownerDocument;
  const candidates = [
    surface.closest(hostSelector) as HTMLElement | null,
    doc?.body,
    doc?.documentElement,
  ];
  try {
    for (const candidate of candidates) {
      if (!candidate || !doc?.defaultView) continue;
      const color = doc.defaultView.getComputedStyle(candidate).backgroundColor;
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
    }
  } catch {
    // Fall through to no synthesized background.
  }
  return null;
}
