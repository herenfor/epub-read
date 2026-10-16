import { sortShelfEntries, type ShelfEntry, type ShelfSort } from "./shelf";

/**
 * Batch selection of folders is derived from the one selected-book set: a
 * folder is checked when all its books are, mixed when some are. Nothing
 * stores a separate "folder selected" flag.
 */
export type FolderSelectionState = "empty" | "none" | "mixed" | "all";

export function folderSelectionState(books: readonly ShelfEntry[], selected: ReadonlySet<string>): FolderSelectionState {
  if (books.length === 0) return "empty";
  let count = 0;
  for (const book of books) if (selected.has(book.id)) count++;
  return count === 0 ? "none" : count === books.length ? "all" : "mixed";
}

/** Tapping a folder: all selected → clear them all; otherwise complete the folder. */
export function toggleFolderSelection(books: readonly ShelfEntry[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (folderSelectionState(books, selected) === "all") for (const book of books) next.delete(book.id);
  else for (const book of books) next.add(book.id);
  return next;
}

/**
 * Books a selection may hold right now: the visible books plus every book of
 * the visible folders (whole folders, regardless of the book filters).
 */
export function selectableBookIds(
  visible: readonly ShelfEntry[],
  folderBooks: Iterable<readonly ShelfEntry[]>,
): Set<string> {
  const ids = new Set(visible.map((entry) => entry.id));
  for (const books of folderBooks) for (const book of books) ids.add(book.id);
  return ids;
}

/**
 * Folder order for the shelf: by name when sorting by title, otherwise by each
 * folder's representative (its first book under the same sort). Empty folders
 * go last; ties keep name, then id. `books` must already be in shelf sort order.
 */
export function sortShelfFolders<F extends { id: string; name: string }>(
  folders: readonly F[],
  books: ReadonlyMap<string, readonly ShelfEntry[]>,
  sort: ShelfSort,
): F[] {
  const byName = [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }) || a.id.localeCompare(b.id));
  if (sort === "title") return byName;
  const filled = byName.filter((folder) => (books.get(folder.id)?.length ?? 0) > 0);
  const empty = byName.filter((folder) => (books.get(folder.id)?.length ?? 0) === 0);
  // sortShelfEntries is a stable sort, so equal representatives keep the name order.
  const representatives = filled.map((folder) => books.get(folder.id)![0]);
  const order = sortShelfEntries(representatives, sort);
  const folderOf = new Map(filled.map((folder, i) => [representatives[i], folder] as const));
  return [...order.map((entry) => folderOf.get(entry)!), ...empty];
}
