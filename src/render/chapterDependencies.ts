import { isExternalUrl, isFragmentOnly, resolvePath, splitHref } from "../core/paths";
import type { Book } from "../core/types";
import { childElements, localNameOf, type XmlElementLike } from "../core/xml";
import { parseChapterDocument, STRIPPED_CHAPTER_TAGS } from "./chapterDocument";
import { cssResourceReferences } from "./cssRewrite";

type ResourceReference = { href: string; stylesheet: boolean };

/** One book session's reference metadata. No DOM, source text or media bytes are retained. */
export class ChapterDependencies {
  private references = new Map<string, Promise<ResourceReference[]>>();

  constructor(private book: Book, private getText: (path: string) => string | undefined) {}

  private async documentReferences(html: string): Promise<ResourceReference[]> {
    const { doc } = await parseChapterDocument(html, this.book.version === 2);
    const refs: ResourceReference[] = [];
    const add = (href: string | null, stylesheet = false) => {
      if (href) refs.push({ href, stylesheet });
    };
    const walk = (element: XmlElementLike): void => {
      const tag = localNameOf(element).toLowerCase();
      if (STRIPPED_CHAPTER_TAGS.has(tag)) return;
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
      if (style) refs.push(...cssResourceReferences(style));
      for (const child of childElements(element)) walk(child);
    };
    if (!doc.documentElement) throw new Error("章节内容为空，无法渲染");
    walk(doc.documentElement);
    return refs;
  }

  private async referencesFor(path: string, stylesheet: boolean): Promise<ResourceReference[]> {
    const cached = this.references.get(path);
    if (cached) return cached;
    const text = this.getText(path);
    // Not yet loaded is not an empty source. A later closure pass must retry it.
    if (text === undefined) return [];
    const pending = !text.trim() ? Promise.resolve([])
      : stylesheet ? Promise.resolve(cssResourceReferences(text)) : this.documentReferences(text);
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
        const path = resolvePath(base, splitHref(href).path);
        if (!this.book.resources.has(path)) continue;
        deps.add(path);
        if (ref.stylesheet && !seenCss.has(path)) {
          seenCss.add(path);
          await visit(path, await this.referencesFor(path, true));
        }
      }
    };
    await visit(chapterPath, await this.referencesFor(chapterPath, false));
    return deps;
  }
}
