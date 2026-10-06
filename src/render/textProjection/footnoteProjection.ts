import { projectText, type CompiledTextProjection } from "./compile";
import { createNodeProjection } from "./nodeProjection";
import { isProjectionExcludedTextNode } from "./session";

export interface FootnoteDisplaySource {
  text: string;
  html?: string;
  target?: HTMLElement;
}

function projectFootnoteHtml(
  html: string,
  compiled: CompiledTextProjection,
  doc: Document,
): FootnoteDisplaySource {
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
  return {
    text: (container.textContent ?? "").replace(/\s+/g, " ").trim(),
    html: container.innerHTML,
  };
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
  if (source.html !== undefined) {
    return projectFootnoteHtml(source.html, compiled, doc);
  }
  // Plain popovers still have source markup: retain code exclusions without
  // changing their presentation. Attribute-based fallback text has no such markup.
  const targetText = (source.target?.textContent ?? "").replace(/\s+/g, " ").trim();
  if (source.target && targetText === source.text) {
    const projected = projectFootnoteHtml(source.target.innerHTML, compiled, doc);
    return { text: projected.text };
  }
  return { text: projectText(source.text, compiled) };
}
