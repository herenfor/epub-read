import { resolveArchiveHref, type ArchiveReferences } from "../core/archiveReferences";
import { resolvePath, isExternalUrl, isFragmentOnly, splitHref } from "../core/paths";

export const MEDIA_PATH = "data-reader-media-path";
export const MEDIA_FRAGMENT = "data-reader-media-fragment";

/** Media bytes are deliberately not part of a chapter's preload closure. */
export function isPlaybackSource(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentNode as Element | null;
  return tag === "audio" || tag === "video" ||
    ((tag === "source" || tag === "track") && /^(audio|video)$/i.test(parent?.tagName ?? ""));
}

export function deferPlaybackSource(
  element: Element,
  href: string,
  basePath: string,
  references?: ArchiveReferences,
): void {
  element.removeAttribute("src");
  element.removeAttribute(MEDIA_PATH);
  element.removeAttribute(MEDIA_FRAGMENT);
  const value = href.trim();
  // Only book-owned media. Never turn remote/file/data URLs into fetches.
  if (!value || isFragmentOnly(value) || isExternalUrl(value) || value.startsWith("//") || /^(javascript|vbscript):/i.test(value)) return;
  const legacy = splitHref(value);
  const ref = references ? resolveArchiveHref(references, basePath, value)
    : { path: resolvePath(basePath, legacy.path), anchor: legacy.anchor };
  element.setAttribute(MEDIA_PATH, ref.path);
  if (ref.anchor) element.setAttribute(MEDIA_FRAGMENT, ref.anchor);
}

export const MEDIA_PLAYER_CSS = `
[data-reader-media-player] {
  display: inline-block; position: relative; max-width: 100%;
  vertical-align: middle; break-inside: avoid; writing-mode: horizontal-tb;
}
[data-reader-media-player] > :is(audio, video) {
  display: block; max-width: 100% !important; box-sizing: border-box;
}
[data-reader-media-player] > [data-reader-media-start] {
  position: absolute; inset: 0; margin: 0; padding: 8px;
  border: 1px solid #888; border-radius: 4px; cursor: pointer;
  background: #252525; color: #fff; font: 14px/1.5 system-ui;
  text-shadow: none; white-space: normal;
}
[data-reader-media-player] > [data-reader-media-start]::after { content: attr(aria-label); }
[data-reader-media-player] > [data-reader-media-start][hidden] { display: none !important; }
`;
