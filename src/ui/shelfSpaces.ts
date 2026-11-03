import { useSyncExternalStore } from "react";
import { setScopedShelfStore, type ShelfStore } from "./shelf";

/**
 * Shelves the title switcher offers. The library is always there; any other
 * shelf brings its own store while it is open and a policy for what it may
 * reach outside that store. Only the private shelf (ER-0044) exists today;
 * another shelf registers a new kind here and a store factory where it opens.
 */
export type ShelfSpaceKind = "library" | "private";

export interface ShelfSpacePolicy {
  /**
   * Library-wide services: body search and the AI corpus, cloud sync, LAN
   * transfer, archives, the import folder and external open.
   */
  readonly libraryServices: boolean;
  /** Browser storage may keep this shelf's ids, titles or text (reader tabs, progress checkpoints). */
  readonly persistsBrowserState: boolean;
  /** Entering needs an unlock; the shelf locks again when it is left or the app closes. */
  readonly locked: boolean;
}

export interface ShelfSpace {
  readonly kind: ShelfSpaceKind;
  readonly policy: ShelfSpacePolicy;
}

export const SHELF_SPACES: Readonly<Record<ShelfSpaceKind, ShelfSpace>> = {
  library: { kind: "library", policy: { libraryServices: true, persistsBrowserState: true, locked: false } },
  private: { kind: "private", policy: { libraryServices: false, persistsBrowserState: false, locked: true } },
};

/** An open non-library shelf: its store, and what to release when it closes. */
export interface OpenShelfSpace {
  readonly space: ShelfSpace;
  readonly store: ShelfStore;
  /** Identifies this opening; a late callback from an earlier one compares it and stops. */
  readonly token: string;
  close(): Promise<void>;
}

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let open: OpenShelfSpace | null = null;
/** What the UI renders from: replaced, never mutated, on every switch. */
export interface ShelfSpaceSnapshot {
  readonly space: ShelfSpace;
  /** Null on the library. */
  readonly token: string | null;
}
const LIBRARY_SNAPSHOT: ShelfSpaceSnapshot = { space: SHELF_SPACES.library, token: null };
let snapshot = LIBRARY_SNAPSHOT;
const listeners = new Set<() => void>();
/** Browser-storage stand-in for a shelf that must not persist; dropped when it closes. */
let memory = new Map<string, string>();

function emit(): void {
  snapshot = open ? { space: open.space, token: open.token } : LIBRARY_SNAPSHOT;
  for (const listener of [...listeners]) listener();
}

export function activeShelfSpace(): ShelfSpace {
  return open?.space ?? SHELF_SPACES.library;
}

/** The token of the open non-library shelf, or null on the library. */
export function activeShelfSpaceToken(): string | null {
  return open?.token ?? null;
}

export function subscribeShelfSpace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentSnapshot(): ShelfSpaceSnapshot {
  return snapshot;
}

export function useActiveShelfSpace(): ShelfSpaceSnapshot {
  return useSyncExternalStore(subscribeShelfSpace, currentSnapshot, currentSnapshot);
}

/** Switches the shelf store to an opened shelf. The caller has already closed any previous one. */
export function enterShelfSpace(next: OpenShelfSpace): void {
  if (open) throw new Error("另一个书架仍处于打开状态");
  open = next;
  memory = new Map();
  setScopedShelfStore(next.store);
  emit();
}

/**
 * Returns to the library. The shelf's store is detached first, so nothing can
 * read it while it closes; its in-memory state is dropped either way.
 */
export async function leaveShelfSpace(): Promise<void> {
  const current = open;
  if (!current) return;
  open = null;
  memory = new Map();
  setScopedShelfStore(null);
  emit();
  await current.close();
}

/**
 * Local storage for state keyed by book (progress checkpoints): the browser's
 * on the library, process memory on a shelf whose policy forbids persisting.
 */
export const shelfSpaceStorage: StoragePort = {
  getItem(key) {
    if (!activeShelfSpace().policy.persistsBrowserState) return memory.get(key) ?? null;
    return localStorage.getItem(key);
  },
  setItem(key, value) {
    if (!activeShelfSpace().policy.persistsBrowserState) memory.set(key, value);
    else localStorage.setItem(key, value);
  },
  removeItem(key) {
    if (!activeShelfSpace().policy.persistsBrowserState) memory.delete(key);
    else localStorage.removeItem(key);
  },
};
