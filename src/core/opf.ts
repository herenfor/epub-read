import type { XmlElementLike, XmlNodeLike } from "./xml";
import { childElements, findElements, localNameOf } from "./xml";
import type {
  BookIssue,
  BookMetadata,
  GuideRef,
  ManifestItem,
  SpineItem,
} from "./types";

export interface ParsedOpf {
  version: 2 | 3;
  metadata: BookMetadata;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  /** spine@page-progression-direction; "default" and absent mean the book does not say. */
  pageProgression?: "ltr" | "rtl";
  guide: GuideRef[];
  /** meta 元素的 name/content 与 property/content（epub3）原始列表 */
  metaPairs: Array<{ name: string; content: string }>;
  issues: BookIssue[];
}

const DC_FIELDS = [
  "title",
  "identifier",
  "language",
  "creator",
  "publisher",
  "contributor",
  "date",
  "description",
  "subject",
  "rights",
  "source",
  "type",
  "format",
  "relation",
  "coverage",
] as const;

function attr(el: XmlElementLike, name: string): string {
  return el.getAttribute(name) ?? "";
}

/** 解析 OPF 包文档。doc 为已解析的 XML Document。 */
export function parseOpf(root: XmlNodeLike): ParsedOpf {
  const issues: BookIssue[] = [];
  const packageEl = findElements(root, "package")[0];
  if (!packageEl) throw new Error("OPF 中找不到 <package> 元素");

  const versionAttr = attr(packageEl, "version");
  const version: 2 | 3 = versionAttr.startsWith("2") ? 2 : 3;

  const metadata: BookMetadata = {
    title: "未命名书籍",
    identifier: "",
    language: "",
  };
  const metaPairs: Array<{ name: string; content: string }> = [];

  // ---- metadata ----
  const metaEl = findElements(packageEl, "metadata")[0];
  if (metaEl) {
    for (const child of childElements(metaEl)) {
      const name = localNameOf(child);
      if (name === "meta") {
        const prop = attr(child, "property");
        const content = (child.textContent ?? "").trim();
        if (prop) {
          // EPUB 3：property/refines
          if (prop === "dcterms:modified") metadata.modified = content;
          metaPairs.push({ name: prop, content });
        } else {
          const n = attr(child, "name");
          const c = attr(child, "content");
          metaPairs.push({ name: n || name, content: c || content });
        }
        continue;
      }
      if ((DC_FIELDS as readonly string[]).includes(name)) {
        const text = (child.textContent ?? "").trim();
        if (text) {
          if (name === "title") metadata.title = text;
          else if (name === "identifier") metadata.identifier = text;
          // Keep browser and native linked-import metadata deterministic when
          // an OPF contains more than one dc:language: both use the first
          // non-empty declaration.
          else if (name === "language" && !metadata.language) metadata.language = text;
          else metadata[name] = text;
        }
      }
    }
    if (!metadata.identifier) {
      const uid = attr(packageEl, "unique-identifier");
      if (uid) {
        const idEl = findElements(metaEl, "identifier").find(
          (el) => attr(el, "id") === uid
        );
        if (idEl) metadata.identifier = (idEl.textContent ?? "").trim();
      }
    }
  }

  // ---- manifest ----
  const manifest = new Map<string, ManifestItem>();
  const manifestEl = findElements(packageEl, "manifest")[0];
  if (manifestEl) {
    for (const item of findElements(manifestEl, "item")) {
      const id = attr(item, "id");
      if (!id) {
        issues.push({
          kind: "book_error",
          source: "opf:manifest",
          message: "manifest item 缺少 id，已跳过",
        });
        continue;
      }
      const mediaType = attr(item, "media-type");
      if (!mediaType) {
        issues.push({
          kind: "book_error",
          source: "opf:manifest",
          message: `manifest item "${id}" 缺少 media-type`,
        });
      }
      const properties = attr(item, "properties")
        .split(/\s+/)
        .filter(Boolean);
      const fallback = attr(item, "fallback") || undefined;
      manifest.set(id, {
        id,
        href: attr(item, "href"),
        mediaType,
        properties,
        fallback,
      });
    }
  }

  // ---- spine ----
  const spine: SpineItem[] = [];
  const spineEl = findElements(packageEl, "spine")[0];
  const progression = spineEl ? attr(spineEl, "page-progression-direction").trim().toLowerCase() : "";
  const pageProgression = progression === "rtl" || progression === "ltr" ? progression : undefined;
  if (spineEl) {
    for (const ref of findElements(spineEl, "itemref")) {
      const idref = attr(ref, "idref");
      if (!idref || !manifest.has(idref)) {
        issues.push({
          kind: "book_error",
          source: "opf:spine",
          message: `spine 引用了不存在的 item "${idref}"`,
        });
        continue;
      }
      spine.push({
        idref,
        linear: attr(ref, "linear") !== "no",
      });
    }
  }

  // ---- guide ----
  const guide: GuideRef[] = [];
  const guideEl = findElements(packageEl, "guide")[0];
  if (guideEl) {
    for (const ref of findElements(guideEl, "reference")) {
      guide.push({
        type: attr(ref, "type"),
        title: attr(ref, "title") || undefined,
        href: attr(ref, "href"),
      });
    }
  }

  return { version, metadata, manifest, spine, pageProgression, guide, metaPairs, issues };
}

/** 从 metaPairs 里取 EPUB3 rendition 信息。 */
export function renditionInfo(
  metaPairs: Array<{ name: string; content: string }>,
  manifest: Map<string, ManifestItem>
): { fixedLayout: boolean; viewport?: string } {
  let fixedLayout = false;
  let viewport: string | undefined;
  let coverId: string | undefined;
  for (const { name, content } of metaPairs) {
    if (name === "rendition:layout" && content === "pre-paginated") {
      fixedLayout = true;
    } else if (name === "rendition:viewport") {
      viewport = content;
    } else if (name === "cover" && content) {
      coverId = content;
    }
  }
  void manifest;
  void coverId;
  return { fixedLayout, viewport };
}
