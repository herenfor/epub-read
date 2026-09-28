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

/**
 * 正文直接子的百分比 spacing 以“本轮局部包含宽，且不超过版心上限”为基准。
 * 多栏容器自己的 content width 可能仍是整屏宽，直接子若只靠浏览器原生
 * 百分比会拿整屏宽；这里显式写成本轮单栏/局部宽，避免根宽度混入。
 */
export function projectPercentageSpacingToLocalWidth(
  value: string,
  containingWidth: number,
  measure: number,
): string | null {
  if (!value.includes("%") || !Number.isFinite(containingWidth) || !Number.isFinite(measure) ||
      containingWidth <= 0 || measure <= 0) return null;
  const target = Math.min(containingWidth, measure);
  const projected = value.replace(/([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)%/giu,
    (_, number: string) => `${Number(number) * target / 100}px`);
  return projected === value ? null : projected;
}

interface PercentageSpacingFix {
  el: HTMLElement;
  property: string;
  value: string;
  priority: string;
}

const FULLPAGE_SELECTOR = ".illus, .kuchie, .cover, .duokan-image-fullscreen";

function restorePercentageSpacingFixes(fixes: PercentageSpacingFix[]): void {
  for (const { el, property, value, priority } of fixes.splice(0).reverse()) {
    if (value) el.style.setProperty(property, value, priority);
    else el.style.removeProperty(property);
  }
}

type PercentageProjector = (value: string, containingWidth: number, measure: number) => string | null;

function applyPercentageSpacing(
  win: Window,
  fixes: PercentageSpacingFix[],
  el: HTMLElement,
  properties: string[],
  containingWidth: number,
  measure: number,
  projector: PercentageProjector,
): void {
  const cs = win.getComputedStyle(el);
  if (cs.writingMode !== "horizontal-tb" || !/^(static|relative)$/u.test(cs.position) || cs.float !== "none") return;
  let map: { get(property: string): { toString(): string } | undefined } | undefined;
  try { map = (el as HTMLElement & { computedStyleMap?(): typeof map }).computedStyleMap?.(); } catch { return; }
  if (!map) return; // An unreadable cascade must not be guessed from matched rules.
  const css = (win as Window & { CSS?: { supports(property: string, value: string): boolean } }).CSS;
  for (const property of properties) {
    const value = projector(map.get(property)?.toString() ?? "", containingWidth, measure);
    if (value === null || !css?.supports(property, value)) continue;
    fixes.push({ el, property, value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property) });
    el.style.setProperty(property, value, "important");
  }
}

function allChildrenAreFullpage(viewer: HTMLElement): boolean {
  return (
    viewer.children.length > 0 &&
    Array.from(viewer.children).every((el) => el.matches(FULLPAGE_SELECTOR))
  );
}

/**
 * 根盒（html/body）padding 必须先于本轮栏几何处理：它参与确定分页根尺寸。
 * 这里只处理根 padding，不碰正文直接子的百分比 spacing。
 */
export function applyReaderRootPercentageSpacing(doc: Document, viewer: HTMLElement, measure: number): () => void {
  const win = doc.defaultView;
  const fixes: PercentageSpacingFix[] = [];
  if (!win || allChildrenAreFullpage(viewer)) return () => {};
  if (!Number.isFinite(measure) || measure <= 0) return () => {};
  const rootWidth = doc.documentElement.clientWidth;
  const padding = ["padding-top", "padding-bottom", "padding-left", "padding-right"];
  applyPercentageSpacing(win, fixes, doc.documentElement, padding, rootWidth, measure, projectPercentageSpacing);
  applyPercentageSpacing(win, fixes, doc.body, padding, rootWidth, measure, projectPercentageSpacing);
  return () => restorePercentageSpacingFixes(fixes);
}

/**
 * 正文直接子的百分比 spacing 要在本轮 SpreadGeometry（单栏/局部内容宽）建立后
 * 处理。containingWidth 是这些直接子的真实包含块内容宽：分页直接子为物理栏
 * 宽，滚动直接子为 viewer 扣掉水平 padding 后的内容宽。嵌套盒仍由浏览器按
 * 自己的父盒解析，不在这里全局替换。
 */
export function applyReaderBodyPercentageSpacing(
  doc: Document,
  viewer: HTMLElement,
  containingWidth: number,
  measure: number,
): () => void {
  const win = doc.defaultView;
  const fixes: PercentageSpacingFix[] = [];
  if (!win || allChildrenAreFullpage(viewer)) return () => {};
  if (!Number.isFinite(containingWidth) || containingWidth <= 0 || !Number.isFinite(measure) || measure <= 0) {
    return () => {};
  }
  for (const el of Array.from(viewer.children) as HTMLElement[]) {
    if (!el.classList.contains("reader-top") || el.matches(FULLPAGE_SELECTOR)) continue;
    const cs = win.getComputedStyle(el);
    if (parseFloat(cs.width) > measure + 0.5) continue; // Explicit breakout/full-width layouts.
    applyPercentageSpacing(
      win,
      fixes,
      el,
      ["margin-top", "margin-bottom", "padding-top", "padding-bottom", "padding-left", "padding-right"],
      containingWidth,
      measure,
      projectPercentageSpacingToLocalWidth,
    );
  }
  return () => restorePercentageSpacingFixes(fixes);
}

/**
 * 兼容旧调用的一步式入口。产品测量必须使用上面两个分阶段函数，避免在
 * 本轮 SpreadGeometry 建立前用整屏/body 宽处理正文直接子。
 * @deprecated 仅保留给旧调用方与定向诊断，不要在新接线中使用。
 */
export function applyReaderPercentageSpacing(
  doc: Document,
  viewer: HTMLElement,
  measure: number,
  bodyContainingWidth?: number,
): () => void {
  const restoreRoot = applyReaderRootPercentageSpacing(doc, viewer, measure);
  const bodyStyle = doc.defaultView?.getComputedStyle(doc.body);
  const bodyWidth = bodyContainingWidth ?? Math.max(
    0,
    doc.body.clientWidth - (parseFloat(bodyStyle?.paddingLeft ?? "") || 0) - (parseFloat(bodyStyle?.paddingRight ?? "") || 0),
  );
  const restoreBody = applyReaderBodyPercentageSpacing(doc, viewer, bodyWidth, measure);
  return () => {
    restoreBody();
    restoreRoot();
  };
}
