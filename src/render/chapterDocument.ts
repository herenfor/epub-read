import { hasParserError, parseXmlText } from "../core/parseXml";

export const STRIPPED_CHAPTER_TAGS = new Set([
  "script", "object", "embed", "iframe", "frame", "frameset", "base",
  "form", "button", "select", "textarea",
]);

/**
 * The sanitizer's XHTML self-closing normalization. An HTML parse otherwise
 * lets script/span swallow the remainder of the document. Pure and
 * synchronous so every reader of chapter markup (rendering, resource
 * discovery, structural counts) sees the same tree.
 */
export function normalizeChapterMarkup(html: string): string {
  html = html.replace(/<script\b([^>]*?)\/\s*>/gi, "<script$1></script>");
  return html.replace(/<([A-Za-z][\w:.-]*)\b([^>]*?)\/\s*>/g,
    (match, tag: string, attrs: string) =>
      /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag)
        ? match : `<${tag}${attrs}></${tag}>`);
}

/** Resource discovery and rendering must read the same normalized document. */
export async function parseChapterDocument(html: string, strictXml: boolean): Promise<{
  doc: Document;
  downgraded: boolean;
}> {
  html = normalizeChapterMarkup(html);
  let doc = await parseXmlText(html, strictXml ? "application/xml" : "text/html");
  const downgraded = strictXml && hasParserError(doc);
  if (downgraded) doc = await parseXmlText(html, "text/html");
  return { doc, downgraded };
}
