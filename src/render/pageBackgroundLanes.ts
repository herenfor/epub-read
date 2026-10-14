/**
 * A12：双页时书的整页背景图按页铺，不横跨两页。
 *
 * 书常把整页背景图写在 html/body 上（cover + fixed）。章节文档的根视口就是
 * 整个双页区域，所以这张图会被拉伸铺满左右两页，内容只占一页时另一页也是
 * 一整块背景。这里把背景图从根元素移到左右两个固定定位的显示层上：
 * - 显示层是 html 的子元素、排在 body 之前，不在 viewer 内，不参与分页、
 *   文字索引和命中测试；
 * - 背景色留在画布上，只搬背景图；
 * - 没有正文的那一页不铺背景图。
 * 单页、滚动和固定版式不需要，由调用方 dispose 恢复原样。
 */

export const PAGE_BACKGROUND_LANE_TAG = "epub-page-background";
/** 背景图已被搬走的根元素；深色主题对比度修补仍应把它当作有背景图。 */
export const PAGE_BACKGROUND_SOURCE_ATTR = "data-reader-page-background-moved";

const COPIED_PROPERTIES = [
  "background-image",
  "background-position",
  "background-size",
  "background-repeat",
  "background-origin",
  "background-clip",
] as const;

export interface PageBackgroundLaneState {
  /** iframe 视口坐标：左右两页的分界线。 */
  readonly splitX: number;
  readonly leftFilled: boolean;
  readonly rightFilled: boolean;
}

export interface PageBackgroundLanes {
  readonly doc: Document;
  update(state: PageBackgroundLaneState): void;
  /** 移除显示层并恢复根元素原来的内联背景图。 */
  dispose(): void;
}

/** 画布背景图来自 html，html 没有时来自 body；都没有返回 null。 */
function backgroundSource(doc: Document): HTMLElement | null {
  const win = doc.defaultView;
  const root = doc.documentElement as HTMLElement | null;
  const body = doc.body;
  if (!win || !root || !body || typeof win.getComputedStyle !== "function") return null;
  for (const element of [root, body]) {
    try {
      if (win.getComputedStyle(element).backgroundImage.trim() !== "none") return element;
    } catch {
      return null;
    }
  }
  return null;
}

export function installPageBackgroundLanes(doc: Document): PageBackgroundLanes | null {
  const source = backgroundSource(doc);
  const body = doc.body;
  const root = doc.documentElement;
  const win = doc.defaultView;
  if (!source || !body || !root || !win) return null;

  const computed = win.getComputedStyle(source);
  const copied = COPIED_PROPERTIES.map((property) => [property, computed.getPropertyValue(property)] as const);
  const imageValue = computed.getPropertyValue("background-image");
  const inline = {
    value: source.style.getPropertyValue("background-image"),
    priority: typeof source.style.getPropertyPriority === "function" ? source.style.getPropertyPriority("background-image") : "",
  };

  const lanes = [0, 1].map(() => {
    const lane = doc.createElement(PAGE_BACKGROUND_LANE_TAG) as HTMLElement;
    lane.setAttribute("aria-hidden", "true");
    const style = lane.style;
    for (const [property, value] of copied) style.setProperty(property, value, "important");
    // fixed 附着会相对整个视口定位，正是要避免的“横跨两页”。
    style.setProperty("background-attachment", "scroll", "important");
    style.setProperty("background-color", "transparent", "important");
    style.setProperty("position", "fixed", "important");
    style.setProperty("top", "0", "important");
    style.setProperty("bottom", "0", "important");
    style.setProperty("margin", "0", "important");
    style.setProperty("padding", "0", "important");
    style.setProperty("border", "0", "important");
    // 负 z-index：画在画布背景之上、正文之下，与 body 是否定位无关。
    style.setProperty("z-index", "-1", "important");
    style.setProperty("pointer-events", "none", "important");
    style.setProperty("display", "none", "important");
    root.insertBefore(lane, body);
    return lane;
  }) as [HTMLElement, HTMLElement];

  source.style.setProperty("background-image", "none", "important");
  source.setAttribute(PAGE_BACKGROUND_SOURCE_ATTR, imageValue);

  let last = "";
  return {
    doc,
    update({ splitX, leftFilled, rightFilled }) {
      const key = `${splitX}|${leftFilled}|${rightFilled}`;
      if (key === last) return;
      last = key;
      const [left, right] = lanes;
      left.style.setProperty("left", "0", "important");
      left.style.setProperty("width", `${Math.max(0, splitX)}px`, "important");
      left.style.setProperty("display", leftFilled ? "block" : "none", "important");
      right.style.setProperty("left", `${Math.max(0, splitX)}px`, "important");
      right.style.setProperty("right", "0", "important");
      right.style.setProperty("display", rightFilled ? "block" : "none", "important");
    },
    dispose() {
      for (const lane of lanes) lane.remove();
      if (inline.value) source.style.setProperty("background-image", inline.value, inline.priority);
      else source.style.removeProperty("background-image");
      source.removeAttribute(PAGE_BACKGROUND_SOURCE_ATTR);
    },
  };
}
