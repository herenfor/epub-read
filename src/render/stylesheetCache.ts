import type { ArchiveReferences } from "../core/archiveReferences";
import { OwnedBlobUrls } from "./blobOwnership";
import { rewriteCssUrls, type CssRewriteOptions } from "./cssRewrite";
import { TEXT_MEASURE } from "./settings";

export interface StylesheetLease {
  readonly url: string;
  readonly unresolvedResources: readonly string[];
  release(): void;
}

export type StylesheetInputs = Pick<CssRewriteOptions, "archiveReferences" | "getText" | "maxEm">;

interface Entry {
  path: string;
  url: string;
  references: ArchiveReferences | undefined;
  maxEm: number;
  texts: Map<string, string | undefined>;
  resources: Set<string>;
  unresolvedResources: string[];
  bytes: number;
  users: number;
  retired: boolean;
}

/** One book's external CSS only. Live leases cannot be evicted by another chapter. */
export class StylesheetCache {
  private entries = new Map<string, Entry>();
  private live = new Set<Entry>();
  private bytes = 0;
  private closed = false;

  constructor(
    private readonly readText: (path: string) => string | undefined,
    private readonly urlFor: (path: string) => string | undefined,
    private readonly budget = { maxBytes: 4 * 1024 * 1024, maxEntries: 32 },
  ) {}

  acquire(path: string, options: StylesheetInputs = {}): StylesheetLease | undefined {
    if (this.closed) return undefined;
    const getText = options.getText ?? this.readText;
    const maxEm = options.maxEm ?? TEXT_MEASURE.maxEm;
    const previous = this.entries.get(path);
    if (previous && previous.references === options.archiveReferences && previous.maxEm === maxEm &&
        [...previous.texts].every(([dependency, text]) => getText(dependency) === text)) {
      this.entries.delete(path);
      this.entries.set(path, previous);
      return this.lease(previous);
    }
    if (previous) this.retire(previous);
    const css = getText(path);
    if (css === undefined) return undefined;
    const texts = new Map<string, string | undefined>([[path, css]]);
    const resources = new Set<string>();
    const unresolvedResources: string[] = [];
    const text = rewriteCssUrls(css, path, (dependency) => {
      resources.add(dependency);
      const url = this.urlFor(dependency);
      if (!url && !unresolvedResources.includes(dependency)) unresolvedResources.push(dependency);
      return url;
    }, {
      archiveReferences: options.archiveReferences, maxEm,
      getText: (dependency) => {
        const value = getText(dependency);
        texts.set(dependency, value);
        return value;
      },
    });
    // Include retained source snapshots in the bound, not just rewritten text/blob.
    // Five bytes per UTF-16 unit bounds the result string plus its UTF-8 Blob.
    const bytes = text.length * 5 + [...texts.values()].reduce<number>((n, value) => n + (value?.length ?? 0) * 2, 0);
    if (bytes > this.budget.maxBytes || this.budget.maxEntries <= 0) return undefined;
    while (this.bytes + bytes > this.budget.maxBytes || this.live.size >= this.budget.maxEntries) {
      const oldest = [...this.entries.values()].find((entry) => entry.users === 0);
      if (!oldest) return undefined; // Caller retains its ordinary chapter-owned fallback.
      this.retire(oldest);
    }
    const entry: Entry = {
      path, url: URL.createObjectURL(new Blob([text], { type: "text/css" })),
      references: options.archiveReferences, maxEm, texts, resources, unresolvedResources,
      bytes, users: 0, retired: false,
    };
    this.entries.set(path, entry);
    this.live.add(entry);
    this.bytes += bytes;
    return this.lease(entry);
  }

  /** Called before a resource URL is revoked, or a deferred resource becomes available. */
  invalidateResource(path: string): void {
    for (const entry of this.entries.values()) {
      if (entry.texts.has(path) || entry.resources.has(path)) this.retire(entry);
    }
  }

  clear(): void {
    this.closed = true;
    for (const entry of this.live) this.destroy(entry);
    this.entries.clear();
  }

  get stats(): Readonly<{ bytes: number; entries: number }> {
    return { bytes: this.bytes, entries: this.live.size };
  }

  private lease(entry: Entry): StylesheetLease {
    entry.users++;
    let released = false;
    return {
      url: entry.url, unresolvedResources: entry.unresolvedResources,
      release: () => {
        if (released) return;
        released = true;
        entry.users--;
        if (entry.retired && entry.users === 0) this.destroy(entry);
      },
    };
  }

  private retire(entry: Entry): void {
    this.entries.delete(entry.path);
    entry.retired = true;
    if (entry.users === 0) this.destroy(entry);
  }

  private destroy(entry: Entry): void {
    if (!this.live.delete(entry)) return;
    URL.revokeObjectURL(entry.url);
    this.bytes -= entry.bytes;
    entry.texts.clear();
    entry.resources.clear();
  }
}

/** Paginator cleanup releases shared leases and revokes only its own fallback URLs. */
export class OwnedStylesheetUrls extends OwnedBlobUrls {
  private leases = new Set<StylesheetLease>();

  share(lease: StylesheetLease): StylesheetLease {
    this.leases.add(lease);
    return lease;
  }

  override revokeAll(): void {
    for (const lease of this.leases) lease.release();
    this.leases.clear();
    super.revokeAll();
  }
}
