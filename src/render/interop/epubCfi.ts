/**
 * Read-only EPUB CFI support for importing positions written by other readers
 * (first user: Readest, which writes CFIs with foliate-js).
 *
 * Everything here runs on the *original* package/chapter XML parsed from the
 * book's own resources — never on the live reader DOM, which carries page
 * gaps, projections and highlights that would shift CFI child indices.
 *
 * The step-indexing rules follow the EPUB CFI specification the same way
 * foliate-js does: element children take even indices, the character data
 * between them takes odd indices (adjacent text nodes form one chunk), and
 * character offsets count UTF-16 code units inside that chunk.
 */
import {
  MAX_ANCHOR_SNIPPET_CODE_POINTS,
  isStructurallyHiddenElement,
} from "../textAnchor";

export interface CfiStep {
  index: number;
  /** `[id]` assertion on an element step. */
  id?: string;
  /** Character offset (UTF-16 code units) on a character-data step. */
  offset?: number;
  /** Text-location assertion values, kept only for diagnostics. */
  text?: string[];
}

/** Steps grouped by `!` indirection: [package steps, content steps, ...]. */
export type CfiPath = CfiStep[][];

export type ParsedCfi =
  | { kind: "point"; path: CfiPath }
  | { kind: "range"; parent: CfiPath; start: CfiPath; end: CfiPath };

/** Hostile-input bound: real CFIs are a few dozen characters. */
export const MAX_CFI_LENGTH = 4096;
const MAX_STEP_INDEX = 1_000_000;

type Token =
  | { type: "/"; value: number }
  | { type: ":"; value: number }
  | { type: "["; value: string }
  | { type: "!" }
  | { type: "," }
  | { type: "skip" };

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  const chars = Array.from(input);
  let i = 0;
  const readNumber = (allowDot: boolean): string => {
    let value = "";
    while (i < chars.length && (/\d/.test(chars[i]) || (allowDot && chars[i] === "."))) value += chars[i++];
    return value;
  };
  while (i < chars.length) {
    const char = chars[i];
    if (char === "/" || char === ":") {
      i++;
      const digits = readNumber(false);
      if (!digits) return null;
      const value = Number(digits);
      if (!Number.isSafeInteger(value) || value > MAX_STEP_INDEX * 1000) return null;
      tokens.push({ type: char, value });
    } else if (char === "~" || char === "@") {
      // Temporal/spatial offsets (audio/video/images) carry no text position.
      i++;
      readNumber(true);
      while (char === "@" && chars[i] === ":") {
        i++;
        readNumber(true);
      }
      tokens.push({ type: "skip" });
    } else if (char === "[") {
      i++;
      let value = "";
      let closed = false;
      // Unescaped `;` starts parameters such as `;s=a` — not part of the value.
      let inParameters = false;
      while (i < chars.length) {
        const c = chars[i++];
        if (c === "^") {
          if (i >= chars.length) return null;
          if (!inParameters) value += chars[i];
          i++;
        } else if (c === "]") {
          closed = true;
          break;
        } else if (c === ";") {
          inParameters = true;
        } else if (!inParameters) value += c;
      }
      if (!closed) return null;
      tokens.push({ type: "[", value });
    } else if (char === "!" || char === ",") {
      i++;
      tokens.push({ type: char });
    } else if (/\s/.test(char)) {
      i++;
    } else {
      return null;
    }
  }
  return tokens;
}

function parsePath(tokens: Token[]): CfiPath | null {
  const groups: CfiPath = [[]];
  let previous: Token["type"] | null = null;
  for (const token of tokens) {
    const group = groups[groups.length - 1];
    const last = group[group.length - 1];
    if (token.type === "/") {
      if (token.value > MAX_STEP_INDEX) return null;
      group.push({ index: token.value });
    } else if (token.type === ":") {
      if (!last || last.offset !== undefined) return null;
      last.offset = token.value;
    } else if (token.type === "[") {
      if (!last) return null;
      if (previous === "/") {
        if (token.value) last.id = token.value;
      }
      else last.text = [...(last.text ?? []), token.value];
    } else if (token.type === "!") {
      if (!group.length) return null;
      groups.push([]);
    } else if (token.type === "skip") {
      if (!last) return null;
    } else {
      return null;
    }
    previous = token.type;
  }
  return groups.every((group) => group.length > 0) ? groups : null;
}

export function parseEpubCfi(input: string): ParsedCfi | null {
  if (typeof input !== "string" || input.length > MAX_CFI_LENGTH) return null;
  const match = /^epubcfi\(([\s\S]*)\)$/.exec(input.trim());
  const body = match ? match[1] : input.trim();
  const tokens = tokenize(body);
  if (!tokens || !tokens.length || tokens[0].type !== "/") return null;
  const commas = tokens.reduce<number[]>((at, token, i) => (token.type === "," ? [...at, i] : at), []);
  if (commas.length === 0) {
    const path = parsePath(tokens);
    return path ? { kind: "point", path } : null;
  }
  if (commas.length !== 2) return null;
  const parent = parsePath(tokens.slice(0, commas[0]));
  const startTokens = tokens.slice(commas[0] + 1, commas[1]);
  const endTokens = tokens.slice(commas[1] + 1);
  if (!parent || !startTokens.length || !endTokens.length) return null;
  const start = parsePath(startTokens);
  const end = parsePath(endTokens);
  return parent && start && end ? { kind: "range", parent, start, end } : null;
}

/** Full path of a range's start (or end): parent's last group joined with the local part. */
export function collapseCfi(parsed: ParsedCfi, toEnd = false): CfiPath {
  if (parsed.kind === "point") return parsed.path;
  const local = toEnd ? parsed.end : parsed.start;
  const head = parsed.parent.slice(0, -1);
  const joined = [...parsed.parent[parsed.parent.length - 1], ...local[0]];
  return [...head, joined, ...local.slice(1)];
}

// ---------------------------------------------------------------------------
// Child indexing shared by package and content documents.

type IndexedChild = Node | Node[] | "before" | "first" | "last" | "after" | null;

const isText = (node: Node | null | undefined): boolean => node?.nodeType === 3 || node?.nodeType === 4;
const isElement = (node: Node | null | undefined): node is Element => node?.nodeType === 1;

/** foliate-js `indexChildNodes`: always `[before, (first), el, chunk, el, ..., (last), after]`. */
function indexChildNodes(node: Node): IndexedChild[] {
  const children = Array.from(node.childNodes).filter((child) => isText(child) || isElement(child));
  const nodes: IndexedChild[] = ["before"];
  if (isElement(children[0])) nodes.push("first");
  let last: IndexedChild | undefined;
  for (const child of children) {
    if (last === undefined) nodes.push(child);
    else if (isText(child)) {
      if (Array.isArray(last)) last.push(child);
      else if (last !== null && typeof last !== "string" && isText(last)) nodes[nodes.length - 1] = [last, child];
      else nodes.push(child);
    } else if (last !== null && typeof last !== "string" && !Array.isArray(last) && isElement(last)) {
      nodes.push(null, child);
    } else {
      nodes.push(child);
    }
    last = nodes[nodes.length - 1];
  }
  if (isElement(children[children.length - 1])) nodes.push("last");
  nodes.push("after");
  return nodes;
}

function findElementById(root: Node, id: string): Element | null {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isElement(node) && node.getAttribute("id") === id) return node;
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      const child = node.childNodes[i];
      if (isElement(child)) stack.push(child);
    }
  }
  return null;
}

export type CfiDomPoint =
  | { node: Node; offset: number }
  | { node: Node; edge: "before" | "after" };

export interface CfiPointResult {
  point: CfiDomPoint;
  /** The index path did not reach the asserted id; the id was used instead. */
  idCorrected: boolean;
}

function walkSteps(root: Node, steps: readonly CfiStep[]): CfiDomPoint | null {
  let node: IndexedChild = root;
  for (const { index } of steps) {
    if (node === null || typeof node === "string" || Array.isArray(node)) return null;
    const next: IndexedChild | undefined = indexChildNodes(node)[index];
    if (next === undefined || next === null) return null;
    if (next === "first") return { node: node.firstChild ?? node, edge: "before" };
    if (next === "last") return { node: node.lastChild ?? node, edge: "after" };
    if (next === "before") return { node, edge: "before" };
    if (next === "after") return { node, edge: "after" };
    node = next;
  }
  const offset = steps[steps.length - 1]?.offset;
  if (node === null || typeof node === "string") return null;
  if (!Array.isArray(node)) {
    if (offset === undefined) return { node, edge: "before" };
    if (!isText(node)) return null;
    return offset <= (node.nodeValue ?? "").length ? { node, offset } : null;
  }
  const target = offset ?? 0;
  let sum = 0;
  for (const piece of node) {
    const length = (piece.nodeValue ?? "").length;
    if (sum + length >= target) return { node: piece, offset: target - sum };
    sum += length;
  }
  return null;
}

/**
 * Resolve content-document steps (everything after the package `!`).
 * The index path is authoritative when it lands on the asserted element;
 * otherwise an existing asserted id corrects it, as the spec allows.
 */
export function resolveCfiInDocument(doc: Document, steps: readonly CfiStep[]): CfiPointResult | null {
  const root = doc.documentElement;
  if (!root || !steps.length) return null;
  // Like foliate-js, content steps index the children of the document
  // element: `/4` is <body> in an ordinary XHTML chapter.
  const point = walkSteps(root, steps);
  const asserted = [...steps].reverse().find((step) => step.id)?.id;
  if (point && (!asserted || elementOnPath(root, steps, asserted))) return { point, idCorrected: false };
  if (!asserted) return null;
  const element = findElementById(root, asserted);
  if (!element) return null;
  // Re-walk the remainder of the path below the asserted element.
  const at = steps.findIndex((step) => step.id === asserted);
  const rest = steps.slice(at + 1);
  if (!rest.length) return { point: { node: element, edge: "before" }, idCorrected: true };
  const below = walkSteps(element, rest);
  return below ? { point: below, idCorrected: true } : null;
}

function elementOnPath(root: Node, steps: readonly CfiStep[], id: string): Element | null {
  let node: IndexedChild = root;
  for (const step of steps) {
    if (node === null || typeof node === "string" || Array.isArray(node)) return null;
    const next: IndexedChild | undefined = indexChildNodes(node)[step.index];
    if (!next || typeof next === "string" || Array.isArray(next)) return null;
    node = next;
    if (step.id === id) return isElement(node) && node.getAttribute("id") === id ? node : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Package document: which spine item a CFI names.

export interface CfiSpineTarget {
  spineIndex: number;
  /** "path" when the OPF walk found the itemref; "index-guess" when no OPF was available. */
  via: "path" | "id" | "index-guess";
}

/**
 * Resolve the package part of a CFI against the book's own OPF, the way
 * foliate-js does (itemref element → idref → spine position). Without an OPF,
 * fall back to the conventional `/6/N` spine numbering and say so.
 */
export function resolveCfiSpine(
  packageSteps: readonly CfiStep[],
  spineIdrefs: readonly string[],
  opfDoc?: Document | null,
): CfiSpineTarget | null {
  if (!packageSteps.length) return null;
  const last = packageSteps[packageSteps.length - 1];
  if (opfDoc?.documentElement) {
    const toIndex = (element: Element | null): number => {
      if (!element || element.localName !== "itemref") return -1;
      return spineIdrefs.indexOf(element.getAttribute("idref") ?? "");
    };
    const walked = walkSteps(opfDoc.documentElement, packageSteps);
    const pathIndex = walked && "edge" in walked && walked.edge === "before" && isElement(walked.node)
      ? toIndex(walked.node) : -1;
    if (pathIndex >= 0) return { spineIndex: pathIndex, via: "path" };
    if (last.id) {
      const byId = toIndex(findElementById(opfDoc.documentElement, last.id));
      if (byId >= 0) return { spineIndex: byId, via: "id" };
    }
    return null;
  }
  if (packageSteps.length !== 2 || packageSteps[0].index !== 6 || last.index % 2 !== 0 || last.index < 2) return null;
  const spineIndex = last.index / 2 - 1;
  return spineIndex < spineIdrefs.length ? { spineIndex, via: "index-guess" } : null;
}

// ---------------------------------------------------------------------------
// Canonical text coordinates (visible-codepoints-no-whitespace-v1).

const WHITESPACE = /\p{White_Space}/u;

interface IndexedText {
  start: number;
  /** UTF-16 start of every counted code point. */
  rawStarts: number[];
  rawEnds: number[];
}

/**
 * Structural twin of the reader's VisibleTextIndex for a parsed chapter.
 * It applies the same structural exclusions (script/style/hidden/aria-hidden/
 * explicit footnotes) but cannot see CSS-hidden elements; the stored snippet
 * lets the reader re-validate the offset when it opens the real chapter.
 */
export class ChapterTextIndex {
  readonly codePoints: string[] = [];
  private readonly texts = new Map<Node, IndexedText>();
  private readonly nodeStart = new Map<Node, number>();
  private readonly nodeEnd = new Map<Node, number>();
  readonly root: Element | null;

  constructor(doc: Document) {
    const html = doc.documentElement;
    this.root = html
      ? Array.from(html.childNodes).find((node): node is Element => isElement(node) && node.localName === "body") ?? html
      : null;
    if (this.root) this.visit(this.root, false);
  }

  get totalChars(): number {
    return this.codePoints.length;
  }

  private visit(node: Node, excluded: boolean): void {
    this.nodeStart.set(node, this.codePoints.length);
    if (node.nodeType === 3 && !excluded) {
      const data = node.nodeValue ?? "";
      const rawStarts: number[] = [];
      const rawEnds: number[] = [];
      const start = this.codePoints.length;
      let raw = 0;
      for (const codePoint of Array.from(data)) {
        if (!WHITESPACE.test(codePoint)) {
          rawStarts.push(raw);
          rawEnds.push(raw + codePoint.length);
          this.codePoints.push(codePoint);
        }
        raw += codePoint.length;
      }
      if (rawStarts.length) this.texts.set(node, { start, rawStarts, rawEnds });
    } else if (isElement(node)) {
      const hidden = excluded || isStructurallyHiddenElement(node);
      for (const child of Array.from(node.childNodes)) this.visit(child, hidden);
    }
    this.nodeEnd.set(node, this.codePoints.length);
  }

  /** Canonical offset of a DOM point, or null when it lies outside the indexed body. */
  offsetAt(point: CfiDomPoint): number | null {
    const { node } = point;
    if (!this.nodeStart.has(node)) {
      // The document element and anything above the body map to its edges.
      if (this.root && node.contains?.(this.root)) return "edge" in point && point.edge === "after" ? this.totalChars : 0;
      return null;
    }
    if ("edge" in point) return point.edge === "before" ? this.nodeStart.get(node)! : this.nodeEnd.get(node)!;
    const text = this.texts.get(node);
    if (!text) return point.offset === 0 ? this.nodeStart.get(node)! : this.nodeEnd.get(node)!;
    const raw = Math.max(0, point.offset);
    for (let i = 0; i < text.rawStarts.length; i++) {
      if (raw <= text.rawStarts[i] || raw < text.rawEnds[i]) return text.start + i;
    }
    return text.start + text.rawStarts.length;
  }

  snippetAt(offset: number): string | null {
    if (offset < 0 || offset >= this.totalChars) return null;
    return this.codePoints.slice(offset, offset + MAX_ANCHOR_SNIPPET_CODE_POINTS).join("") || null;
  }

  snippetBefore(offset: number): string | null {
    if (offset <= 0 || offset > this.totalChars) return null;
    return this.codePoints.slice(Math.max(0, offset - MAX_ANCHOR_SNIPPET_CODE_POINTS), offset).join("") || null;
  }

  slice(start: number, end: number): string {
    return this.codePoints.slice(start, end).join("");
  }

  /** Every start offset where `needle` (already normalized) occurs. */
  occurrences(needle: string): number[] {
    const target = Array.from(needle);
    if (!target.length || target.length > this.totalChars) return [];
    const hits: number[] = [];
    outer: for (let start = 0; start <= this.totalChars - target.length; start++) {
      for (let i = 0; i < target.length; i++) if (this.codePoints[start + i] !== target[i]) continue outer;
      hits.push(start);
    }
    return hits;
  }
}
