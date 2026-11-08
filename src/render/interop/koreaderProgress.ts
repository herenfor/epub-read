/**
 * Read-only KOReader sidecar progress for one local EPUB.
 *
 * The Lua table is parsed as data. Nothing here executes Lua, and device
 * paths, percentages and page numbers never become a canonical locator.
 * XPointer child indexes follow crengine's classic/explicit toStringV2 shape.
 * The character offset is then mapped through the shared chapter text index,
 * so the stored locator uses visible-codepoints-no-whitespace-v1.
 */
import { hasStructurallyExcludedAncestor } from "../textAnchor";
import { ChapterTextIndex } from "./epubCfi";
import type { ModernLocator } from "../../core/portableState/portable-state-types";

export const KOR_SIDECAR_BYTE_LIMIT = 8 * 1024 * 1024;
/** The only cre_dom_version with an external engine landing (ER-0113). */
export const KOR_SUPPORTED_DOM_VERSION = 20240114;

const MAX_TABLE_DEPTH = 16;
const MAX_XPOINTER_LENGTH = 4096;
const WHITESPACE = /\p{White_Space}/u;
const COLLAPSIBLE_WS = /[ \t\r\n]{2,}|[\t\r\n]/;
const CRENGINE_BOX_TAGS = new Set(["autoboxing", "floatbox", "inlinebox", "tabularbox"]);
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
const FORBIDDEN_IDENTS = new Set([
  "function", "local", "require", "load", "loadstring", "loadfile", "dofile",
  "setmetatable", "getmetatable", "rawset", "rawget", "os", "io", "debug",
  "package", "coroutine", "while", "for", "repeat", "until", "if", "then",
  "else", "elseif", "end", "goto", "and", "or", "not",
]);
const PROGRESS_KEYS = new Set(["partial_md5_checksum", "cre_dom_version", "last_xpointer"]);

export type KoreaderParseError =
  | "too-large"
  | "not-lua-return-table"
  | "unsafe-lua-construct"
  | "syntax-error"
  | "max-depth-exceeded";

export interface KoreaderProgressSidecar {
  /** Candidate key only. This is not the book's SHA-256. */
  partialMd5Checksum: string | null;
  /** Candidate label only. A matching title is not the same book. */
  title: string | null;
  creDomVersion: number | null;
  lastXPointer: string | null;
  /** Root keys that were present and ignored. Their values are not copied. */
  discarded: readonly string[];
}

type LuaValue = string | number | boolean | null | { readonly [key: string]: LuaValue };
type LuaToken =
  | { type: "symbol"; value: "{" | "}" | "[" | "]" | "=" | "," | ";" }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "ident"; value: string };

export type KoreaderPointReason =
  | "bad-xpointer"
  | "paging-page-only"
  | "unsupported-format"
  | "crengine-autoboxing"
  | "chapter-missing"
  | "node-missing"
  | "offset-out-of-bounds"
  | "outside-text"
  | "crengine-dom-version-unsupported"
  | "crengine-whitespace-unverified"
  | "element-boundary";

export interface KoreaderChapterSource {
  readonly spinePaths: readonly string[];
  /** The sidecar's own cre_dom_version. Missing is unsupported, never a default. */
  readonly creDomVersion: number | null;
  chapterDocument(spineIndex: number): Document | null;
}

export type KoreaderPointResult =
  | { ok: true; grade: "exact"; locator: ModernLocator }
  | { ok: false; grade: "unresolved" | "unsupported" | "approximate"; reasons: readonly KoreaderPointReason[] };

interface XPointerStep {
  kind: "element" | "text";
  tag: string;
  index: number;
}

function utf8(bytes: number[]): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
}

function pushUtf8(bytes: number[], codePoint: number): void {
  for (const byte of new TextEncoder().encode(String.fromCodePoint(codePoint))) bytes.push(byte);
}

function tokenize(input: string): { ok: true; tokens: LuaToken[] } | { ok: false; errorCode: KoreaderParseError; detail: string } {
  const tokens: LuaToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "-" && input[i + 1] === "-") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "=" || ch === "," || ch === ";") {
      tokens.push({ type: "symbol", value: ch });
      i += 1;
      continue;
    }
    if ("().:+*/%#".includes(ch)) {
      return { ok: false, errorCode: "unsafe-lua-construct", detail: `Forbidden operator or call token '${ch}' at offset ${i}` };
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      const bytes: number[] = [];
      let closed = false;
      while (i < input.length) {
        const current = input[i];
        i += 1;
        if (current === quote) {
          closed = true;
          break;
        }
        if (current === "\n" || current === "\r") {
          return { ok: false, errorCode: "syntax-error", detail: `Unescaped newline in string at offset ${i}` };
        }
        if (current === "\\") {
          if (i >= input.length) return { ok: false, errorCode: "syntax-error", detail: "Trailing backslash in string" };
          const esc = input[i];
          i += 1;
          if (esc === "n") bytes.push(10);
          else if (esc === "r") bytes.push(13);
          else if (esc === "t") bytes.push(9);
          else if (esc === "\\") bytes.push(92);
          else if (esc === '"') bytes.push(34);
          else if (esc === "'") bytes.push(39);
          else if (esc === "a") bytes.push(7);
          else if (esc === "b") bytes.push(8);
          else if (esc === "f") bytes.push(12);
          else if (esc === "v") bytes.push(11);
          else if (esc >= "0" && esc <= "9") {
            let digits = esc;
            if (i < input.length && input[i] >= "0" && input[i] <= "9") digits += input[i++];
            if (i < input.length && input[i] >= "0" && input[i] <= "9") digits += input[i++];
            const code = Number(digits);
            if (code > 255) return { ok: false, errorCode: "syntax-error", detail: `Invalid decimal escape \\${digits}` };
            bytes.push(code);
          } else pushUtf8(bytes, esc.codePointAt(0)!);
        } else {
          const codePoint = input.codePointAt(i - 1)!;
          if (codePoint > 0xffff) i += 1;
          pushUtf8(bytes, codePoint);
        }
      }
      if (!closed) return { ok: false, errorCode: "syntax-error", detail: "Unterminated string literal" };
      tokens.push({ type: "string", value: utf8(bytes) });
      continue;
    }
    if ((ch >= "0" && ch <= "9") || (ch === "-" && input[i + 1] >= "0" && input[i + 1] <= "9")) {
      const start = i;
      if (ch === "-") i += 1;
      while (i < input.length && input[i] >= "0" && input[i] <= "9") i += 1;
      if (input[i] === ".") {
        i += 1;
        while (i < input.length && input[i] >= "0" && input[i] <= "9") i += 1;
      }
      if (input[i] === "e" || input[i] === "E") {
        i += 1;
        if (input[i] === "+" || input[i] === "-") i += 1;
        while (i < input.length && input[i] >= "0" && input[i] <= "9") i += 1;
      }
      const raw = input.slice(start, i);
      const num = Number(raw);
      if (!Number.isFinite(num)) return { ok: false, errorCode: "syntax-error", detail: `Non-finite number '${raw}'` };
      tokens.push({ type: "number", value: num });
      continue;
    }
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      const start = i;
      i += 1;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i += 1;
      const ident = input.slice(start, i);
      if (FORBIDDEN_IDENTS.has(ident)) {
        return { ok: false, errorCode: "unsafe-lua-construct", detail: `Forbidden Lua keyword/identifier '${ident}'` };
      }
      tokens.push({ type: "ident", value: ident });
      continue;
    }
    return { ok: false, errorCode: "unsafe-lua-construct", detail: `Unexpected character '${ch}' at offset ${i}` };
  }
  return { ok: true, tokens };
}

function parseReturnTable(source: string): { ok: true; root: Record<string, LuaValue> } | { ok: false; errorCode: KoreaderParseError; detail: string } {
  if (new TextEncoder().encode(source).length > KOR_SIDECAR_BYTE_LIMIT) {
    return { ok: false, errorCode: "too-large", detail: "Sidecar exceeds 8 MiB limit" };
  }
  const lexed = tokenize(source);
  if (!lexed.ok) return lexed;
  const { tokens } = lexed;
  if (tokens.length < 3 || tokens[0].type !== "ident" || tokens[0].value !== "return" || tokens[1].type !== "symbol" || tokens[1].value !== "{") {
    return { ok: false, errorCode: "not-lua-return-table", detail: "Sidecar must start with 'return {...}'" };
  }
  let pos = 1;
  function fail(detail: string): never {
    throw new Error(detail);
  }
  const parseValue = (depth: number): LuaValue => {
    if (depth > MAX_TABLE_DEPTH) fail("MAX_DEPTH");
    const token = tokens[pos];
    if (!token) fail("Unexpected EOF");
    if (token.type === "string" || token.type === "number") {
      pos += 1;
      return token.value;
    }
    if (token.type === "ident") {
      pos += 1;
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "nil") return null;
      fail(`UNSAFE_IDENT:${token.value}`);
    }
    if (token.type === "symbol" && token.value === "{") return parseTable(depth + 1);
    fail(`Unexpected token ${JSON.stringify(token)}`);
  };
  const parseTable = (depth: number): Record<string, LuaValue> => {
    if (depth > MAX_TABLE_DEPTH) fail("MAX_DEPTH");
    const open = tokens[pos++];
    if (!open || open.type !== "symbol" || open.value !== "{") fail("Expected '{'");
    const out: Record<string, LuaValue> = Object.create(null);
    let implicit = 1;
    while (pos < tokens.length) {
      const next = tokens[pos];
      if (next.type === "symbol" && next.value === "}") {
        pos += 1;
        return out;
      }
      if (next.type === "symbol" && next.value === "[") {
        pos += 1;
        const keyToken = tokens[pos++];
        if (!keyToken || (keyToken.type !== "string" && keyToken.type !== "number")) fail("Table bracket key must be string or number literal");
        const close = tokens[pos++];
        const eq = tokens[pos++];
        if (!close || close.type !== "symbol" || close.value !== "]" || !eq || eq.type !== "symbol" || eq.value !== "=") {
          fail("Expected '] =' after table key");
        }
        out[String(keyToken.value)] = parseValue(depth);
      } else if (next.type === "ident" && tokens[pos + 1]?.type === "symbol" && tokens[pos + 1]?.value === "=") {
        pos += 2;
        out[next.value] = parseValue(depth);
      } else {
        out[String(implicit)] = parseValue(depth);
        implicit += 1;
      }
      const sep = tokens[pos];
      if (sep?.type === "symbol" && (sep.value === "," || sep.value === ";")) pos += 1;
      else if (!(sep?.type === "symbol" && sep.value === "}")) fail("Expected ',', ';' or '}' in table");
    }
    fail("Unterminated table literal");
  };
  try {
    const root = parseTable(1);
    if (pos < tokens.length) return { ok: false, errorCode: "syntax-error", detail: "Unexpected trailing tokens after root table" };
    return { ok: true, root };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "MAX_DEPTH") return { ok: false, errorCode: "max-depth-exceeded", detail: `Table nesting exceeds ${MAX_TABLE_DEPTH}` };
    if (message.startsWith("UNSAFE_IDENT:")) return { ok: false, errorCode: "unsafe-lua-construct", detail: message };
    return { ok: false, errorCode: "syntax-error", detail: message };
  }
}

function textValue(value: LuaValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function integerValue(value: LuaValue | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function tableValue(value: LuaValue | undefined): Record<string, LuaValue> | null {
  return value !== null && typeof value === "object" ? value : null;
}

/** Static whitelist read. Annotations, appearance, paths and percents are dropped. */
export function readKoreaderProgressSidecar(source: string):
  | { ok: true; sidecar: KoreaderProgressSidecar }
  | { ok: false; errorCode: KoreaderParseError; detail: string } {
  const parsed = parseReturnTable(source);
  if (!parsed.ok) return parsed;
  const root = parsed.root;
  const props = tableValue(root.doc_props);
  const sidecar: KoreaderProgressSidecar = {
    partialMd5Checksum: textValue(root.partial_md5_checksum),
    title: textValue(props?.title),
    creDomVersion: integerValue(root.cre_dom_version),
    lastXPointer: textValue(root.last_xpointer),
    discarded: Object.keys(root).filter((key) => !PROGRESS_KEYS.has(key)).sort(),
  };
  return { ok: true, sidecar };
}

function tagName(el: Element): string {
  return (el.localName ?? el.tagName).toLowerCase();
}

function isElement(node: Node | null | undefined): node is Element {
  return node?.nodeType === 1;
}

function isText(node: Node | null | undefined): node is Text {
  return node?.nodeType === 3 || node?.nodeType === 4;
}

function hasAutoBoxingHazard(el: Element): boolean {
  const children = Array.from(el.childNodes);
  const block = children.some((child) => isElement(child) && BLOCK_TAGS.has(tagName(child)));
  const directText = children.some((child) => isText(child) && Array.from(child.nodeValue ?? "").some((cp) => !WHITESPACE.test(cp)));
  return block && directText;
}

function chapterBody(doc: Document): Element | null {
  const html = doc.documentElement;
  if (!html) return null;
  return Array.from(html.childNodes).find((node): node is Element => isElement(node) && tagName(node) === "body") ?? null;
}

function parseXPointer(input: string | number | null | undefined):
  | { ok: true; fragment: number; steps: XPointerStep[]; offset: number | null }
  | { ok: false; reason: KoreaderPointReason } {
  if (typeof input === "number" || (typeof input === "string" && /^\d+$/.test(input.trim()))) {
    return { ok: false, reason: "paging-page-only" };
  }
  if (typeof input !== "string" || !input.trim() || input.trim().length > MAX_XPOINTER_LENGTH || !input.trim().startsWith("/")) {
    return { ok: false, reason: "bad-xpointer" };
  }
  const trimmed = input.trim();
  let path = trimmed;
  let offset: number | null = null;
  const dotted = /^(.*)\.(\d+)$/.exec(trimmed);
  if (dotted) {
    path = dotted[1];
    offset = Number(dotted[2]);
    if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, reason: "bad-xpointer" };
  }
  const steps: XPointerStep[] = [];
  for (const segment of path.slice(1).split("/")) {
    if (!segment) return { ok: false, reason: "bad-xpointer" };
    const text = /^text\(\)(?:\[(\d+)\])?$/.exec(segment);
    if (text) {
      const index = text[1] ? Number(text[1]) : 1;
      if (!Number.isSafeInteger(index) || index < 1) return { ok: false, reason: "bad-xpointer" };
      steps.push({ kind: "text", tag: "text()", index });
      continue;
    }
    const element = /^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\[(\d+)\])?$/.exec(segment);
    if (!element) return { ok: false, reason: "bad-xpointer" };
    const tag = element[1].toLowerCase();
    if (CRENGINE_BOX_TAGS.has(tag)) return { ok: false, reason: "crengine-autoboxing" };
    const index = element[2] ? Number(element[2]) : 1;
    if (!Number.isSafeInteger(index) || index < 1) return { ok: false, reason: "bad-xpointer" };
    steps.push({ kind: "element", tag, index });
  }
  if (steps.length < 2 || steps[0].tag !== "body") return { ok: false, reason: "unsupported-format" };
  if (steps[1].tag !== "docfragment") return { ok: false, reason: "unsupported-format" };
  // EPUB has one package body and one chapter body. An omitted index means [1];
  // any other index is a path that does not exist, not a nearby landing.
  if (steps[0].index !== 1) return { ok: false, reason: "node-missing" };
  const innerBody = steps[2]?.kind === "element" && steps[2].tag === "body" ? steps[2] : null;
  if (innerBody && innerBody.index !== 1) return { ok: false, reason: "node-missing" };
  const bodyAt = innerBody ? 3 : 2;
  return { ok: true, fragment: steps[1].index, steps: steps.slice(bodyAt), offset };
}

function walk(body: Element, steps: readonly XPointerStep[]):
  | { ok: true; node: Node; autobox: boolean }
  | { ok: false; reason: KoreaderPointReason } {
  let current: Node = body;
  let autobox = hasAutoBoxingHazard(body);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!isElement(current)) return { ok: false, reason: "node-missing" };
    if (hasAutoBoxingHazard(current)) autobox = true;
    if (step.kind === "text") {
      if (i !== steps.length - 1) return { ok: false, reason: "bad-xpointer" };
      const children = Array.from(current.childNodes);
      const hasElements = children.some((child) => isElement(child));
      const texts = children.filter((child): child is Text => {
        if (!isText(child)) return false;
        return !(hasElements && (child.nodeValue ?? "").trim() === "");
      });
      const target = texts[step.index - 1];
      if (!target) return { ok: false, reason: "node-missing" };
      return { ok: true, node: target, autobox };
    }
    const matches = Array.from(current.childNodes).filter((child): child is Element => isElement(child) && tagName(child) === step.tag);
    const target = matches[step.index - 1];
    if (!target) return { ok: false, reason: "node-missing" };
    current = target;
  }
  return { ok: true, node: current, autobox };
}

function stableTextPoint(data: string, cpOffset: number):
  | { ok: true; utf16: number }
  | { ok: false; reason: "offset-out-of-bounds" | "crengine-whitespace-unverified" } {
  const chars = Array.from(data);
  if (cpOffset < 0 || cpOffset >= chars.length) return { ok: false, reason: "offset-out-of-bounds" };
  const raw: number[] = [];
  const collapsed: number[] = [];
  let collapsedPos = 0;
  let previousAscii = false;
  for (let index = 0; index < chars.length; index += 1) {
    const cp = chars[index];
    const ascii = cp === " " || cp === "\t" || cp === "\r" || cp === "\n";
    if (!WHITESPACE.test(cp)) {
      raw.push(index);
      collapsed.push(collapsedPos);
    }
    if (ascii) {
      if (!previousAscii) collapsedPos += 1;
      previousAscii = true;
    } else {
      collapsedPos += 1;
      previousAscii = false;
    }
  }
  const mapped = (table: number[]): number => {
    for (let index = 0; index < table.length; index += 1) if (cpOffset <= table[index]) return index;
    return table.length;
  };
  if (COLLAPSIBLE_WS.test(chars.slice(0, cpOffset).join("")) || mapped(raw) !== mapped(collapsed) || WHITESPACE.test(chars[cpOffset])) {
    return { ok: false, reason: "crengine-whitespace-unverified" };
  }
  let utf16 = 0;
  for (let index = 0; index < cpOffset; index += 1) utf16 += chars[index].length;
  return { ok: true, utf16 };
}

function failed(grade: "unresolved" | "unsupported" | "approximate", reason: KoreaderPointReason): KoreaderPointResult {
  return { ok: false, grade, reasons: [reason] };
}

/**
 * Convert one supported XPointer into an exact canonical locator.
 * Percentage, page number, unknown DOM version, missing chapter, autoboxing,
 * whitespace that the raw XHTML cannot prove, and element boundaries do not
 * produce a locator.
 */
export function resolveKoreaderProgressPoint(
  xpointer: string | number | null | undefined,
  source: KoreaderChapterSource,
): KoreaderPointResult {
  const parsed = parseXPointer(xpointer);
  if (!parsed.ok) {
    const grade = parsed.reason === "unsupported-format" ? "unsupported" : "unresolved";
    return failed(grade, parsed.reason);
  }
  if (source.creDomVersion !== KOR_SUPPORTED_DOM_VERSION) {
    return failed("unsupported", "crengine-dom-version-unsupported");
  }
  const spineIndex = parsed.fragment - 1;
  const chapterPath = source.spinePaths[spineIndex];
  const doc = chapterPath ? source.chapterDocument(spineIndex) : null;
  const body = doc ? chapterBody(doc) : null;
  if (!chapterPath || !body) return failed("unresolved", "chapter-missing");
  const walked = walk(body, parsed.steps);
  if (!walked.ok) return failed(walked.reason === "crengine-autoboxing" ? "unsupported" : "unresolved", walked.reason);
  if (walked.autobox) return failed("unresolved", "crengine-autoboxing");
  if (isElement(walked.node)) return failed("approximate", "element-boundary");
  if (!isText(walked.node) || hasStructurallyExcludedAncestor(walked.node)) return failed("unresolved", "outside-text");
  const point = stableTextPoint(walked.node.nodeValue ?? "", parsed.offset ?? 0);
  if (!point.ok) return failed("unresolved", point.reason);
  const index = new ChapterTextIndex(doc!);
  const offset = index.offsetAt({ node: walked.node, offset: point.utf16 });
  if (offset === null || offset < 0 || offset >= index.totalChars) return failed("unresolved", "offset-out-of-bounds");
  const snippet = index.snippetAt(offset);
  if (!snippet) return failed("unresolved", "offset-out-of-bounds");
  return {
    ok: true,
    grade: "exact",
    locator: {
      locatorVersion: 1,
      chapterPath,
      spineIndexHint: spineIndex,
      target: { kind: "text", textProfile: "visible-codepoints-no-whitespace-v1", offset, snippet },
    },
  };
}
