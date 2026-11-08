/**
 * ER-0126: Chromium paints a fragmented backdrop-filter box's blur from each
 * fragment's top using the unfragmented height, so the blur leaks below every
 * fragment.  A box too tall for one column is therefore split at child block
 * boundaries into one shell per column, so each shell is a single fragment.
 *
 * - The original element stays as the first shell and keeps its id; later
 *   shells are shallow clones without id.  Real child nodes are moved, never
 *   copied, so text identity, ranges rebuilt later and search stay valid.
 * - The author's box-decoration-break is kept: with the default `slice`, the
 *   cut edges lose padding, border and radius exactly like a native fragment.
 * - A forced column break keeps adjoining margins, unlike the unforced break it
 *   replaces, so the first child of each later shell loses its top margin
 *   (slice only; a clone shell has its own padding and nothing collapses).
 * - A child that would cross a column moves whole to the next shell.  A child
 *   taller than a column, inline text directly in the box, or a shell that still
 *   fragments after the bounded loop is unsupported and rolled back.
 * - restore() is idempotent and puts every node and inline style back.
 */

export const SHELL_MARKER = "data-reader-backdrop-shell";

export type SplitResult =
  | { kind: "applied"; shells: number; restore(): void }
  | { kind: "unchanged" }
  | { kind: "unsupported"; reason: string };

export interface SplitOptions {
  /** Upper bound on shells per box; one per column the box spans. */
  maxShells?: number;
}

const SLICE_BOTTOM =
  "padding-bottom: 0 !important; border-bottom-width: 0 !important; margin-bottom: 0 !important;" +
  " border-bottom-left-radius: 0 !important; border-bottom-right-radius: 0 !important;";
const SLICE_TOP =
  "padding-top: 0 !important; border-top-width: 0 !important; margin-top: 0 !important;" +
  " border-top-left-radius: 0 !important; border-top-right-radius: 0 !important;";
const COLUMN_START = "break-before: column !important; -webkit-column-break-before: always !important;";

function boxRects(el: Element): DOMRect[] {
  return Array.from(el.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
}

function withStyle(raw: string | null, extra: string): string {
  const base = (raw ?? "").trim();
  const separator = base && !base.endsWith(";") ? ";" : "";
  return `${base}${separator} ${extra}`.trim();
}

/** True when every rect of `child` sits inside the horizontal band and above the bottom of `fragment`. */
function insideFragment(child: Element, fragment: DOMRect): boolean {
  const rects = boxRects(child);
  if (!rects.length) return true;
  return rects.every(
    (rect) => rect.left >= fragment.left - 1 && rect.right <= fragment.right + 1 && rect.bottom <= fragment.bottom + 1,
  );
}

function isClone(el: HTMLElement): boolean {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  const value = cs?.getPropertyValue("box-decoration-break") || cs?.getPropertyValue("-webkit-box-decoration-break") || "";
  return value.trim() === "clone";
}

/**
 * Split one fragmented backdrop box.  The caller has already checked that the
 * box is a safe flow block (display block, static, no floats or transforms
 * inside) in horizontal paged layout.
 */
export function splitBackdropBox(el: HTMLElement, options: SplitOptions = {}): SplitResult {
  const doc = el.ownerDocument;
  const parent = el.parentNode;
  if (!parent || boxRects(el).length <= 1) return { kind: "unchanged" };

  const nodes = Array.from(el.childNodes);
  for (const node of nodes) {
    if (node.nodeType === 3 && /\S/u.test(node.textContent ?? "")) {
      return { kind: "unsupported", reason: "inline text directly in the box" };
    }
  }
  if (el.children.length < 2) return { kind: "unsupported", reason: "fewer than two child blocks" };

  const view = doc.defaultView;
  for (const child of Array.from(el.children)) {
    const display = view?.getComputedStyle(child).display ?? "block";
    if (!/^(block|list-item|flow-root)$/u.test(display)) {
      return { kind: "unsupported", reason: `child display ${display}` };
    }
  }

  const textBefore = el.textContent;
  const rawStyle = el.getAttribute("style");
  const clone = isClone(el);
  const shells: HTMLElement[] = [el];
  const childStyles: Array<{ element: Element; raw: string | null }> = [];
  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const { element, raw } of childStyles) {
      if (raw === null) element.removeAttribute("style");
      else element.setAttribute("style", raw);
    }
    for (const shell of shells.slice(1)) {
      while (shell.firstChild) el.appendChild(shell.firstChild);
      shell.remove();
    }
    if (rawStyle === null) el.removeAttribute("style");
    else el.setAttribute("style", rawStyle);
  };
  const fail = (reason: string): SplitResult => {
    restore();
    return { kind: "unsupported", reason };
  };

  const maxShells = Math.max(2, Math.floor(options.maxShells ?? 8));
  // Shell i's extra style: top slice for every shell after the first, bottom
  // slice for every shell that is followed by another.
  const styleFor = (index: number, hasNext: boolean): string | null => {
    let style = rawStyle;
    if (index > 0) style = withStyle(style, COLUMN_START + (clone ? "" : SLICE_TOP));
    if (hasNext && !clone) style = withStyle(style, SLICE_BOTTOM);
    return style;
  };

  let current = el;
  for (;;) {
    void current.getBoundingClientRect();
    const rects = boxRects(current);
    if (rects.length <= 1) break;
    if (shells.length >= maxShells) return fail("box spans more columns than allowed");

    const fragment = rects[0];
    const children = Array.from(current.children);
    const cutIndex = children.findIndex((child) => !insideFragment(child, fragment));
    if (cutIndex <= 0) return fail(cutIndex === 0 ? "a child block is taller than a column" : "fragment has no movable child");

    const shell = el.cloneNode(false) as HTMLElement;
    shell.removeAttribute("id");
    shell.setAttribute(SHELL_MARKER, "");
    const cut = children[cutIndex];
    // Whitespace or comments before the cut stay with the earlier shell.
    for (let node: ChildNode | null = cut; node; ) {
      const next: ChildNode | null = node.nextSibling;
      shell.appendChild(node);
      node = next;
    }
    current.after(shell);
    shells.push(shell);
    if (!clone) {
      const raw = cut.getAttribute("style");
      childStyles.push({ element: cut, raw });
      cut.setAttribute("style", withStyle(raw, "margin-top: 0 !important;"));
    }
    shells.forEach((item, index) => {
      const style = styleFor(index, index < shells.length - 1);
      if (style === null) item.removeAttribute("style");
      else item.setAttribute("style", style);
    });
    current = shell;
  }

  if (shells.length === 1) return { kind: "unchanged" };
  void el.parentElement?.getBoundingClientRect();
  for (const shell of shells) {
    if (boxRects(shell).length !== 1) return fail("a shell still fragments");
  }
  if (shells.map((shell) => shell.textContent).join("") !== textBefore) return fail("text changed");
  return { kind: "applied", shells: shells.length, restore };
}
