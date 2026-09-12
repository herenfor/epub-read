/** Resolve only the percentage terms of an engine-computed spacing value.
 * Typed OM has already resolved em/rem and the winning cascade; calc/min/max
 * keep their length terms and are evaluated by the browser after substitution.
 */
export function projectPercentageSpacing(value: string, containingWidth: number, measure: number): string | null {
  if (!value.includes("%") || !Number.isFinite(containingWidth) || !Number.isFinite(measure) ||
      containingWidth <= 0 || measure <= 0 || containingWidth <= measure) return null;
  const projected = value.replace(/([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)%/giu,
    (_, number: string) => `${Number(number) * measure / 100}px`);
  return projected === value ? null : projected;
}

/** L3/L4: a page-level box's spacing uses the virtual text measure, while
 * nested boxes retain their actual containing block. Never rewrite book CSS
 * or percentage heights (including image aspect ratios).
 */
export function applyReaderPercentageSpacing(doc: Document, viewer: HTMLElement, measure: number): () => void {
  const win = doc.defaultView;
  const fixes: Array<{ el: HTMLElement; property: string; value: string; priority: string }> = [];
  if (!win) return () => {};
  const padding = ["padding-top", "padding-bottom", "padding-left", "padding-right"];
  const apply = (el: HTMLElement, properties: string[], width: number) => {
    const cs = win.getComputedStyle(el);
    if (cs.writingMode !== "horizontal-tb" || !/^(static|relative)$/u.test(cs.position) || cs.float !== "none") return;
    let map: { get(property: string): { toString(): string } | undefined } | undefined;
    try { map = (el as HTMLElement & { computedStyleMap?(): typeof map }).computedStyleMap?.(); } catch { return; }
    if (!map) return; // An unreadable cascade must not be guessed from matched rules.
    for (const property of properties) {
      const value = projectPercentageSpacing(map.get(property)?.toString() ?? "", width, measure);
      if (value === null || !win.CSS.supports(property, value)) continue;
      fixes.push({ el, property, value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property) });
      el.style.setProperty(property, value, "important");
    }
  };
  // Root padding affects the page dimensions, so it must settle before the
  // paginator computes its column width/height. Root margins remain L3-owned.
  const fullpage = ".illus, .kuchie, .cover, .duokan-image-fullscreen";
  if (viewer.children.length > 0 && Array.from(viewer.children).every((el) => el.matches(fullpage))) return () => {};
  apply(doc.documentElement, padding, doc.documentElement.clientWidth);
  apply(doc.body, padding, doc.documentElement.clientWidth);
  const bodyStyle = win.getComputedStyle(doc.body);
  const available = doc.body.clientWidth - (parseFloat(bodyStyle.paddingLeft) || 0) - (parseFloat(bodyStyle.paddingRight) || 0);
  for (const el of Array.from(viewer.children) as HTMLElement[]) {
    if (!el.classList.contains("reader-top") || el.matches(".illus, .kuchie, .cover, .duokan-image-fullscreen")) continue;
    const cs = win.getComputedStyle(el);
    if (parseFloat(cs.width) > measure + 0.5) continue; // Explicit breakout/full-width layouts.
    apply(el, ["margin-top", "margin-bottom", ...padding], available);
  }
  return () => {
    for (const { el, property, value, priority } of fixes.splice(0).reverse()) {
      if (value) el.style.setProperty(property, value, priority);
      else el.style.removeProperty(property);
    }
  };
}
