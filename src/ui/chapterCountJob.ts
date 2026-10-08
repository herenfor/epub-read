import { resolveArchiveHref } from "../core/archiveReferences";
import { resolvePath } from "../core/paths";
import type { Book } from "../core/types";
import {
  hasStructurallyExcludedAncestor,
  isStructurallyHiddenElement,
  normalizeAnchorText,
} from "../render/textAnchor";
import { MEDIA_UNIT_CHAR_WEIGHT } from "./chapterCounts";

export interface IdleScheduler {
  request(callback: () => void, options?: { timeout?: number }): number;
  cancel(handle: number): void;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function createDefaultIdleScheduler(): IdleScheduler {
  const host = globalThis as unknown as IdleWindow;
  if (typeof host.requestIdleCallback === "function") {
    return {
      request(callback, options) {
        return host.requestIdleCallback!(callback, options ?? { timeout: 100 });
      },
      cancel(handle) {
        host.cancelIdleCallback?.(handle);
      },
    };
  }
  return {
    request(callback) {
      return globalThis.setTimeout(callback, 16) as unknown as number;
    },
    cancel(handle) {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
  };
}

export interface ChapterCountJobServer {
  textFor(path: string): string | undefined;
  /** On-demand read for lazily decompressed archives; preferred when present. */
  readTextFor?(path: string, signal?: AbortSignal): Promise<string>;
}

export interface ChapterCountJobOptions {
  book: Book;
  server: ChapterCountJobServer;
  generation: number;
  scheduler?: IdleScheduler;
  /** Must verify the active session generation and exact book/server identity. */
  isCurrent?: (generation: number, book: Book, server: ChapterCountJobServer) => boolean;
  /** Cached structural estimates; these indices are not scheduled again. */
  skipIndices?: ReadonlySet<number>;
  /** Bounded number of chapters handled by one scheduler callback. */
  maxPerSlice?: number;
  parse?: (text: string) => Document;
  onCount(index: number, value: number): void;
  onCounts?(counts: Array<[number, number]>): void;
  onError?(index: number): void;
  onIssue?(message: string): void;
}

function defaultParse(text: string): Document {
  if (typeof DOMParser === "undefined") throw new Error("DOMParser unavailable");
  const doc = new DOMParser().parseFromString(text, "text/html");
  if (!doc) throw new Error("DOMParser returned no document");
  return doc;
}

function countStructuralContent(doc: Document): { text: number; media: number } {
  const root = doc.body ?? doc.documentElement;
  if (!root) return { text: 0, media: 0 };
  const walker = doc.createTreeWalker(root, 4);
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (hasStructurallyExcludedAncestor(node)) continue;
    total += Array.from(normalizeAnchorText(node.textContent ?? "")).length;
  }
  const mediaTags = new Set(["img", "video", "audio", "canvas", "svg", "object", "embed"]);
  let media = 0;
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (!mediaTags.has(tag)) continue;
    if (isStructurallyHiddenElement(element) || hasStructurallyExcludedAncestor(element)) continue;
    // SVG is one media unit; its nested <image> must not be counted again.
    if (tag !== "svg" && element.closest("svg")) continue;
    media++;
  }
  const text = Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
  return { text, media };
}

export function countStructuralChapter(doc: Document): number {
  const result = countStructuralContent(doc);
  if (result.text > 0) return result.text;
  return result.media > 0 ? result.media * MEDIA_UNIT_CHAR_WEIGHT : 0;
}

export function createChapterCountJob(options: ChapterCountJobOptions): { cancel(): void } {
  const scheduler = options.scheduler ?? createDefaultIdleScheduler();
  const controller = new AbortController();
  const indices = options.book.spine
    .map((item, index) => (item.linear ? index : -1))
    .filter((index) => index >= 0 && !options.skipIndices?.has(index));
  let cursor = 0;
  let scheduled: number | null = null;
  // Async reads go one chapter per idle slice so foreground chapter loads keep priority.
  const asyncRead = typeof options.server.readTextFor === "function";
  const maxPerSlice = Math.max(1, Math.min(4, Math.floor(options.maxPerSlice ?? (asyncRead ? 1 : 4))));
  /** Exactly one slice runs at a time; a new idle callback is requested only after it settles. */
  let running = false;

  const current = (): boolean =>
    !controller.signal.aborted &&
    (options.isCurrent?.(options.generation, options.book, options.server) ?? true);

  const readText = (path: string): string | undefined | Promise<string> =>
    asyncRead ? options.server.readTextFor!(path, controller.signal) : options.server.textFor(path);

  /** Runs synchronously for a sync server; only a real async read yields. */
  const runSlice = async (): Promise<void> => {
    const counts: Array<[number, number]> = [];
    for (let processed = 0; processed < maxPerSlice && cursor < indices.length; processed++) {
      const index = indices[cursor++];
      let value: number | null = null;
      let issue: string | undefined;
      try {
        const item = options.book.spine[index];
        const manifest = options.book.manifest.get(item.idref);
        if (!manifest) {
          issue = `chapter ${index}: manifest item missing`;
        } else {
          const path = options.book.archiveReferences ? resolveArchiveHref(options.book.archiveReferences, options.book.opfPath, manifest.href).path : resolvePath(options.book.opfPath, manifest.href);
          const raw = readText(path);
          const text = typeof raw === "string" || raw === undefined ? raw : await raw;
          if (!current()) return;
          if (text === undefined) {
            issue = `chapter ${index}: text resource missing (${path})`;
          } else {
            value = countStructuralChapter((options.parse ?? defaultParse)(text));
          }
        }
      } catch (error) {
        if (!current()) return;
        issue = `chapter ${index}: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!current()) return;
      if (value === null) {
        // A failed read stays an error (incomplete weights), never a counted 0.
        options.onError?.(index);
        if (issue) options.onIssue?.(issue);
      } else {
        counts.push([index, value]);
        if (!options.onCounts) options.onCount(index, value);
      }
    }
    if (!current()) return;
    if (counts.length > 0 && options.onCounts) options.onCounts(counts);
  };

  const schedule = (): void => {
    if (!current() || cursor >= indices.length || scheduled !== null || running) return;
    scheduled = scheduler.request(() => {
      scheduled = null;
      if (!current() || running) return;
      running = true;
      const settle = (): void => {
        running = false;
        schedule();
      };
      if (!asyncRead) {
        // Sync source: the whole slice already ran inside runSlice's first tick.
        void runSlice().catch(() => undefined);
        settle();
        return;
      }
      void runSlice()
        .catch(() => { /* per-chapter errors are reported above; cancellation is silent */ })
        .finally(settle);
    }, { timeout: 100 });
  };

  const cancel = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (scheduled !== null) {
      scheduler.cancel(scheduled);
      scheduled = null;
    }
  };
  schedule();
  return { cancel };
}
