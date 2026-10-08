import { normalizePath, resolvePath, splitHref } from './paths';

export interface ArchiveReference { path: string; anchor: string; }

/** A decoded ZIP identity, never an href or an operating-system path. */
export function validArchiveEntryKey(value: string): boolean {
  return !!value && !/[\0\\]/.test(value) && !value.startsWith('/')
    && !/^[A-Za-z]:\//.test(value)
    && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}

function decodeOnce(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Created only when actual ZIP names contain URI-significant characters. */
export class ArchiveReferences {
  private readonly entries: ReadonlySet<string>;

  constructor(entries: ReadonlyMap<string, unknown>) {
    // Retain names only: this index must never pin decompressed resource bytes.
    this.entries = new Set(entries.keys());
  }

  resolve(base: string, href: string): ArchiveReference {
    const missing = { path: '', anchor: '' };
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(href)) return missing;
    const hash = href.indexOf('#');
    const beforeFragment = hash < 0 ? href : href.slice(0, hash);
    const anchor = hash < 0 ? '' : decodeOnce(href.slice(hash + 1));
    const query = beforeFragment.indexOf('?');
    const encoded = query < 0 ? beforeFragment : beforeFragment.slice(0, query);
    if (!encoded) return this.entries.has(base) ? { path: base, anchor } : missing;
    const decoded = decodeOnce(encoded);
    const parts = decoded.startsWith('/') ? [] : base.split('/').slice(0, -1);
    for (const part of decoded.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return missing;
        parts.pop();
      } else parts.push(part);
    }
    const path = parts.join('/');
    // Resolution preserves the exact candidate key even when a resource is
    // missing; the archive/resource table reports absence, without aliases.
    return validArchiveEntryKey(path) ? { path, anchor } : missing;
  }

  /** Root-relative, encoded href for legacy UI/navigation string interfaces. */
  href(path: string, anchor = ''): string {
    return '/' + path.split('/').map(encodeURIComponent).join('/')
      + (anchor ? '#' + encodeURIComponent(anchor) : '');
  }
}

export function detectArchiveReferences(entries: ReadonlyMap<string, unknown>): ArchiveReferences | undefined {
  for (const name of entries.keys()) {
    if (/[?#%]/.test(name)) return new ArchiveReferences(entries);
  }
  return undefined;
}

/** Ordinary archives retain the existing reader's reference behavior. */
export function resolveArchiveHref(references: ArchiveReferences | undefined, base: string, href: string): ArchiveReference {
  if (references) return references.resolve(base, href);
  const { path, anchor } = splitHref(href);
  return { path: resolvePath(base, path), anchor };
}

export function archiveHref(references: ArchiveReferences | undefined, path: string, anchor = ''): string {
  return references ? references.href(path, anchor) : path + (anchor ? '#' + anchor : '');
}

/** container.xml full-path is a root-relative reference, not an OS filename. */
export function archiveRootPath(references: ArchiveReferences | undefined, path: string): string {
  return references ? references.resolve('', '/' + path.replace(/^\//, '')).path : normalizePath(path);
}
