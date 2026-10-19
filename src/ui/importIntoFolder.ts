import { effectiveFolderId, type LibraryOrganization } from "./libraryOrganization";

/** One book an import accepted, with whether the library already had it. */
export interface ImportedBookRef {
  readonly contentHash: string;
  readonly isExisting: boolean;
}

export interface ImportIntoFolderPlan {
  /** Hashes to move into the target folder with one moveBooks command. */
  readonly move: readonly string[];
  readonly alreadyHere: number;
  /** Existing books another folder already holds: left where they are. */
  readonly keptElsewhere: number;
  /** The target folder is gone (dissolved, or synced away): nothing moves. */
  readonly targetMissing: boolean;
}

/** Name of a live folder, or null when it does not exist or was dissolved. */
export function liveFolderName(state: LibraryOrganization, folderId: string): string | null {
  const folder = state.folders[folderId];
  return folder && !folder.deleted ? folder.name.value : null;
}

/**
 * "Import into this folder" placement: new books and unclassified existing
 * books go in; an existing book already filed elsewhere is never pulled out
 * by a re-import (same rule as directory import's fillUnclassified).
 */
export function planImportIntoFolder(
  state: LibraryOrganization,
  folderId: string,
  books: readonly ImportedBookRef[],
): ImportIntoFolderPlan {
  if (liveFolderName(state, folderId) === null) {
    return { move: [], alreadyHere: 0, keptElsewhere: 0, targetMissing: true };
  }
  const seen = new Set<string>();
  const move: string[] = [];
  let alreadyHere = 0;
  let keptElsewhere = 0;
  for (const book of books) {
    if (seen.has(book.contentHash)) continue;
    seen.add(book.contentHash);
    const current = effectiveFolderId(state, book.contentHash);
    if (current === folderId) alreadyHere++;
    else if (!book.isExisting || current === null) move.push(book.contentHash);
    else keptElsewhere++;
  }
  return { move, alreadyHere, keptElsewhere, targetMissing: false };
}
