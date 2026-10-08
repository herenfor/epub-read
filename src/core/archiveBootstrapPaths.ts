import { resolveArchiveHref, type ArchiveReferences } from "./archiveReferences";
import type { ManifestItem } from "./types";
import { resolvePath } from "./paths";

/** Minimal native loader bootstrap: only the first nav/NCX file buildToc uses. */
export function archiveBootstrapPaths(
  opfPath: string,
  manifest: ReadonlyMap<string, ManifestItem>,
  directory: ReadonlyMap<string, unknown>,
  parseToc: boolean,
  references?: ArchiveReferences,
): string[] {
  if (!parseToc) return [];
  const paths = new Set<string>();
  // buildToc uses the first nav/NCX candidates, then its existing spine fallback.
  let navChosen = false;
  let ncxChosen = false;
  for (const item of manifest.values()) {
    const isNav = !navChosen && item.properties.includes("nav");
    const isNcx = !ncxChosen && item.mediaType === "application/x-dtbncx+xml";
    if (isNav) navChosen = true;
    if (isNcx) ncxChosen = true;
    if (!isNav && !isNcx) continue;
    const path = references ? resolveArchiveHref(references, opfPath, item.href).path : resolvePath(opfPath, item.href);
    if (directory.has(path)) paths.add(path);
  }
  return [...paths];
}
