import { projectText, type CompiledTextProjection } from "./compile";
import { createNodeProjection } from "./nodeProjection";
import { isProjectionExcludedTextNode } from "./session";

export interface FootnoteDisplaySource {
  text: string;
  html?: string;
}

function projectFootnoteHtml(
  html: string,
  compiled: CompiledTextProjection,
  doc: Document,
): string {
  const container = doc.createElement("div");
  container.innerHTML = html;
  const walker = doc.createTreeWalker(container, 4);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  for (const node of nodes) {
    if (isProjectionExcludedTextNode(node)) continue;
    const projection = createNodeProjection(node.data, compiled);
    if (node.data !== projection.display) node.data = projection.display;
  }
  return container.innerHTML;
}

/**
 * Display-only footnote projection. The original FootnoteInfo/target and any
 * canonical link/anchor data stay untouched; only the popover copy changes.
 */
export function projectFootnoteDisplay(
  source: FootnoteDisplaySource,
  compiled: CompiledTextProjection,
  doc: Document,
): FootnoteDisplaySource {
  const text = projectText(source.text, compiled);
  const html = source.html === undefined
    ? undefined
    : projectFootnoteHtml(source.html, compiled, doc);
  return { text, html };
}
