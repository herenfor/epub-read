import { resolveArchiveHref } from "../core/archiveReferences";
import { isExternalUrl, isFragmentOnly } from "../core/paths";
import type { Book } from "../core/types";
import { childElements, localNameOf, type XmlElementLike } from "../core/xml";
import { parseChapterDocument, STRIPPED_CHAPTER_TAGS } from "./chapterDocument";
import { cssFontUsage, cssInlineFontFamilies, cssResourceReferences } from "./cssRewrite";

type ResourceReference = { href: string; stylesheet: boolean };
type ChapterTokens = { tags: Set<string>; classes: Set<string>; ids: Set<string>; families: Set<string> };

/**
 * Whether a selector's subject could match an element of this chapter. Only
 * tag, class and id are checked; anything unusual counts as a match.
 */
function selectorMayMatch(selector: string, tokens: ChapterTokens): boolean {
  return selector.split(",").some((part) => {
    if (/[\\|]/.test(part)) return true;
    const plain = part.replace(/\[[^\]]*\]/g, "").replace(/::?[\w-]+(\([^)]*\))?/g, "").trim();
    const subject = plain.split(/[\s>+~]+/).filter(Boolean).pop() ?? "";
    const tag = /^[a-z][\w-]*/i.exec(subject)?.[0].toLowerCase();
    if (tag && !tokens.tags.has(tag)) return false;
    for (const [, name] of subject.matchAll(/\.([\w-]+)/g)) if (!tokens.classes.has(name)) return false;
    for (const [, name] of subject.matchAll(/#([\w-]+)/g)) if (!tokens.ids.has(name)) return false;
    return true;
  });
}

/** One book session's reference metadata. No DOM, source text or media bytes are retained. */
export class ChapterDependencies {
  private references = new Map<string, Promise<ResourceReference[]>>();
  private tokens = new Map<string, ChapterTokens>();

  constructor(private book: Book, private getText: (path: string) => string | undefined) {}

  private async documentReferences(path: string, html: string): Promise<ResourceReference[]> {
    const { doc } = await parseChapterDocument(html, this.book.version === 2);
    const refs: ResourceReference[] = [];
    const tokens: ChapterTokens = { tags: new Set(), classes: new Set(), ids: new Set(), families: new Set() };
    const add = (href: string | null, stylesheet = false) => {
      if (href) refs.push({ href, stylesheet });
    };
    const walk = (element: XmlElementLike): void => {
      const tag = localNameOf(element).toLowerCase();
      if (STRIPPED_CHAPTER_TAGS.has(tag)) return;
      tokens.tags.add(tag);
      for (const name of (element.getAttribute("class") ?? "").split(/\s+/)) if (name) tokens.classes.add(name);
      const id = element.getAttribute("id");
      if (id) tokens.ids.add(id);
      if (tag === "link" && /(?:^|\s)stylesheet(?:\s|$)/i.test(element.getAttribute("rel") ?? "")) {
        add(element.getAttribute("href"), true);
      }
      if (tag === "img") add(element.getAttribute("src"));
      if (tag === "image" || tag === "use") {
        add(element.getAttribute("xlink:href") || element.getAttribute("href"));
      }
      if (tag === "img" || tag === "source") {
        for (const candidate of (element.getAttribute("srcset") ?? "").split(",")) {
          add(candidate.trim().split(/\s+/)[0]);
        }
      }
      if (tag === "video") add(element.getAttribute("poster"));
      if (tag === "style") refs.push(...cssResourceReferences(element.textContent ?? ""));
      const style = element.getAttribute("style");
      if (style) {
        refs.push(...cssResourceReferences(style));
        for (const family of cssInlineFontFamilies(style)) tokens.families.add(family);
      }
      for (const child of childElements(element)) walk(child);
    };
    if (!doc.documentElement) throw new Error("章节内容为空，无法渲染");
    walk(doc.documentElement);
    this.tokens.set(path, tokens);
    return refs;
  }

  private async referencesFor(path: string, stylesheet: boolean): Promise<ResourceReference[]> {
    const cached = this.references.get(path);
    if (cached) return cached;
    const text = this.getText(path);
    // Not yet loaded is not an empty source. A later closure pass must retry it.
    if (text === undefined) return [];
    const pending = !text.trim() ? Promise.resolve([])
      : stylesheet ? Promise.resolve(cssResourceReferences(text)) : this.documentReferences(path, text);
    this.references.set(path, pending);
    try {
      return await pending;
    } catch (error) {
      this.references.delete(path);
      throw error;
    }
  }

  /** Revisit unloaded CSS edges as acquisition loads each batch, until the closure is complete. */
  async collect(chapterPath: string): Promise<Set<string>> {
    const deps = new Set<string>([chapterPath]);
    const seenCss = new Set<string>();
    const visit = async (base: string, refs: ResourceReference[]): Promise<void> => {
      for (const ref of refs) {
        const href = ref.href.trim();
        if (!href || isExternalUrl(href) || isFragmentOnly(href) || href.startsWith("//")) continue;
        const path = resolveArchiveHref(this.book.archiveReferences, base, href).path;
        if (!this.book.resources.has(path)) continue;
        deps.add(path);
        if (ref.stylesheet && !seenCss.has(path)) {
          seenCss.add(path);
          await visit(path, await this.referencesFor(path, true));
        }
      }
    };
    await visit(chapterPath, await this.referencesFor(chapterPath, false));
    this.dropUnusedFonts(chapterPath, deps, seenCss);
    return deps;
  }

  /**
   * E10: a stylesheet may declare many large fonts that this chapter never
   * uses. Keep a @font-face file only when a rule that may match this chapter,
   * or an inline style, asks for its family; keep it when unsure.
   */
  private dropUnusedFonts(chapterPath: string, deps: Set<string>, stylesheets: Set<string>): void {
    const tokens = this.tokens.get(chapterPath);
    if (!tokens) return;
    const used = new Set(tokens.families);
    const faces: Array<{ families: string[]; paths: string[] }> = [];
    for (const sheet of stylesheets) {
      const text = this.getText(sheet);
      if (!text) continue;
      const usage = cssFontUsage(text);
      for (const rule of usage.rules) {
        if (selectorMayMatch(rule.selector, tokens)) for (const family of rule.families) used.add(family);
      }
      for (const face of usage.faces) {
        faces.push({
          families: face.families,
          paths: face.hrefs.map((href) => resolveArchiveHref(this.book.archiveReferences, sheet, href.trim()).path),
        });
      }
    }
    for (const face of faces) {
      if (face.families.length === 0 || face.families.some((family) => used.has(family))) continue;
      for (const path of face.paths) deps.delete(path);
    }
    // A file shared with a kept face stays.
    for (const face of faces) {
      if (face.families.length === 0 || face.families.some((family) => used.has(family))) {
        for (const path of face.paths) if (this.book.resources.has(path)) deps.add(path);
      }
    }
  }
}
