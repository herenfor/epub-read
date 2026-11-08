import { hasAuthoredCssProperty } from "./cssRewrite";

/** True only for an authored inline width declaration (comments are inert). */
export function hasAuthoredInlineWidth(styleText: string): boolean {
  return hasAuthoredCssProperty(styleText, "width");
}

/**
 * 只有直接 img/svg 与源码格式化空白的 float 是正常的媒体浮动，不属于
 * C-08 要修复的文字 shrink-to-fit。注释等非渲染节点不影响判断。
 */
export function isMediaOnlyFloatContent(nodes: Iterable<Node>): boolean {
  let hasMedia = false;
  for (const node of nodes) {
    if (node.nodeType === 3) {
      if ((node.textContent ?? "").trim() !== "") return false;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = (node as Element).tagName.toLowerCase();
    if (tag !== "img" && tag !== "svg") return false;
    hasMedia = true;
  }
  return hasMedia;
}

const MEDIA_ONLY_TAGS = new Set(["img", "svg", "image", "video", "audio", "canvas"]);

/**
 * Recursive variant used only for the trailing decorative-float guard. Wrapper
 * elements and comments are allowed, while any non-whitespace text vetoes the
 * media-only classification. A media element itself counts as the payload;
 * SVG descendants are still visited so embedded visible text is not hidden.
 */
export function isMediaOnlyFloatSubtree(nodes: Iterable<Node>): boolean {
  let hasMedia = false;
  const visit = (node: Node): boolean => {
    if (node.nodeType === 3) return (node.textContent ?? "").trim() === "";
    if (node.nodeType === 8) return true;
    if (node.nodeType !== 1) return true;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (MEDIA_ONLY_TAGS.has(tag)) hasMedia = true;
    const children = (el as unknown as { childNodes?: Iterable<Node> }).childNodes;
    if (!children) return true;
    for (const child of children) if (!visit(child)) return false;
    return true;
  };
  for (const node of nodes) if (!visit(node)) return false;
  return hasMedia;
}

export interface FloatWidthSession {
  /** Apply the C-08 width fix; pending fixes from earlier applies are kept. */
  apply(doc: Document | null | undefined, viewer: HTMLElement | null | undefined): void;
  /** Remove the widths written by this session; safe to call repeatedly. */
  restore(): void;
}

/**
 * Holds the text-float width fixes so the paginator owns one session field.
 * The apply/restore positions stay in the paginator's existing measure order.
 */
export function createFloatWidthSession(): FloatWidthSession {
  let fixes: HTMLElement[] = [];
  return {
    apply(doc, viewer) {
      if (!doc || !viewer) return;
      const win = doc.defaultView;
      if (!win) return;
      applyFloatWidthFixes(win, doc, viewer, fixes);
    },
    restore() {
      for (const el of fixes) el.style.removeProperty("width");
      fixes = [];
    },
  };
}

function applyFloatWidthFixes(win: Window, doc: Document, viewer: HTMLElement, fixes: HTMLElement[]): void {
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const familiesOf = (fontFamily: string): string[] =>
    fontFamily
      .split(",")
      .map((f) => f.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

  const textWidth = (text: string, parent: Element | null): number => {
    if (!text) return 0;
    const cs = parent ? win.getComputedStyle(parent) : null;
    const families = cs ? familiesOf(cs.fontFamily) : ["sans-serif"];
    const style = cs
      ? `${cs.fontWeight} ${cs.fontSize}`
      : "400 16px";
    for (const family of families) {
      ctx.font = `${style} ${family}`;
      const w = ctx.measureText(text).width;
      if (w > 0) return w;
    }
    return 0;
  };

  const measureNode = (node: Node): number => {
    if (node.nodeType === 3) {
      return textWidth(node.textContent ?? "", node.parentElement);
    }
    if (node.nodeType !== 1) return 0;
    const el = node as HTMLElement;
    if (el.tagName.toLowerCase() === "br") return 0;
    const cs = win.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    if (tag !== "img" && tag !== "svg" && cs.display !== "inline") return 0;
    const r = el.getBoundingClientRect();
    if (r.width > 0) return r.width;
    const img = el as HTMLImageElement;
    if (img.naturalWidth) return img.naturalWidth;
    return 0;
  };

  for (const el of Array.from(viewer.querySelectorAll("*")) as HTMLElement[]) {
    const cs = win.getComputedStyle(el);
    if (cs.float === "none") continue;
    // C-08 measures horizontal inline advance. An orthogonal paragraph's
    // narrow physical width is the intended line thickness, not collapse.
    if (cs.writingMode !== "horizontal-tb") continue;
    if (hasAuthoredInlineWidth(el.getAttribute("style") ?? "")) continue;
    // 只修复“塌缩成逐字宽”的浮动元素；已有明确宽度且正常布局
    // （如目录标题 width:100% + float:left）不处理。
    const currentWidth = parseFloat(cs.width);
    if (!Number.isFinite(currentWidth) || currentWidth > 48) continue;
    // [L5-C23] 小头像等媒体本来就可能窄于 48px；源码缩进空白不是内容，
    // 不能由 Canvas 累加后反向撑宽其 float 容器。
    if (isMediaOnlyFloatContent(el.childNodes)) continue;
    if (
      Array.from(el.children).some((c) => {
        const d = win.getComputedStyle(c as Element).display;
        return (
          d.startsWith("block") ||
          d.startsWith("list-item") ||
          d === "table" ||
          d === "flex"
        );
      })
    ) {
      continue;
    }
    let maxContent = 0;
    let lineWidth = 0;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 1 && (n as HTMLElement).tagName.toLowerCase() === "br") {
        maxContent = Math.max(maxContent, lineWidth);
        lineWidth = 0;
        continue;
      }
      lineWidth += measureNode(n);
    }
    maxContent = Math.max(maxContent, lineWidth);
    if (maxContent <= 0) continue;
    const padding =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const border =
      (parseFloat(cs.borderLeftWidth) || 0) +
      (parseFloat(cs.borderRightWidth) || 0);
    const parent = el.parentElement;
    const parentCs =
      parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
    const avail =
      (parent ? parent.clientWidth : viewer.clientWidth) -
      (parseFloat(parentCs?.paddingLeft ?? "") || 0) -
      (parseFloat(parentCs?.paddingRight ?? "") || 0) -
      (parseFloat(cs.marginLeft) || 0) -
      (parseFloat(cs.marginRight) || 0);
    const target = Math.max(0, Math.min(maxContent + padding + border, avail));
    el.style.setProperty("width", `${target}px`);
    fixes.push(el);
  }
}
