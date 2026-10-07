import type { FolderTarget } from "../../core/folderImport/contract";
import {
  decidePlacement,
  type ImportOptions,
  type PlacementDecision,
  type PlacementSnapshot,
} from "../../core/folderImport/planner";
import {
  applyCommand,
  effectiveFolderId,
  type LibraryOrganization,
  type OrganizationEnvelope,
} from "../libraryOrganization";

/** One successfully imported book waiting for its directory placement. */
export interface DirectoryPlacementItem {
  readonly inputId: string;
  readonly contentHash: string;
  /** The book existed before this import observed it. */
  readonly isExisting: boolean;
  readonly target: FolderTarget;
  /** Placement register seen when the import first learned this hash. */
  readonly observed: PlacementSnapshot;
}

export interface DirectoryPlacementBatch {
  readonly policy: ImportOptions["existingPlacement"];
  readonly items: readonly DirectoryPlacementItem[];
}

export interface DirectoryPlacementOutcome {
  readonly inputId: string;
  readonly contentHash: string;
  readonly decision: PlacementDecision;
}

export interface DirectoryPlacementBatchResult {
  /** One outcome per batch item, in batch order. */
  readonly outcomes: readonly DirectoryPlacementOutcome[];
  /** Folders this commit really created (only when a book went in). */
  readonly createdFolderIds: readonly string[];
  /** Organization after the commit. */
  readonly organization: LibraryOrganization;
}

/**
 * Required store capability for the Web directory import: ONE storage
 * transaction re-reads the organization, applies the conditional rule to every
 * item, creates the needed folders and moves the books, then commits — or
 * commits nothing when it throws. A second read before separate writes is not
 * a substitute: the user can change a register between them.
 */
export interface DirectoryPlacementCommitter {
  commitDirectoryPlacementBatch(batch: DirectoryPlacementBatch): Promise<DirectoryPlacementBatchResult>;
}

export function placementSnapshotOf(state: LibraryOrganization, contentHash: string): PlacementSnapshot {
  const register = state.books[contentHash]?.folderId;
  return {
    rawFolderId: register ? register.value : null,
    stamp: register ? { deviceId: register.stamp.deviceId, counter: register.stamp.counter } : null,
    effectiveFolderId: effectiveFolderId(state, contentHash),
  };
}

/**
 * Pure body of the atomic commit. The store runs it on the envelope it read
 * inside its transaction and writes the returned envelope in that same
 * transaction; any throw means the transaction is aborted and nothing lands.
 */
export function applyDirectoryPlacementBatch(
  envelope: OrganizationEnvelope,
  batch: DirectoryPlacementBatch,
  knownContentHashes: ReadonlySet<string>,
): { envelope: OrganizationEnvelope; result: DirectoryPlacementBatchResult } {
  const state = envelope.state;
  const creates = new Map<string, Extract<FolderTarget, { kind: "create" }>>();
  const moves = new Map<string, string[]>();
  const outcomes = batch.items.map((item): DirectoryPlacementOutcome => {
    const target = item.target;
    const folder = state.folders[target.folderId];
    // A planned new folder is alive until someone deletes it; a reused one must exist.
    const alive = target.kind === "create" ? !folder?.deleted : folder !== undefined && !folder.deleted;
    const decision = decidePlacement(
      item.observed,
      placementSnapshotOf(state, item.contentHash),
      item.isExisting,
      target.folderId,
      alive,
      batch.policy,
    );
    if (decision.kind === "move") {
      if (target.kind === "create" && !folder) creates.set(target.folderId, target);
      const list = moves.get(decision.folderId) ?? [];
      list.push(item.contentHash);
      moves.set(decision.folderId, list);
    }
    return { inputId: item.inputId, contentHash: item.contentHash, decision };
  });
  let next = envelope;
  for (const target of creates.values()) {
    next = applyCommand(next, { type: "createFolder", folderId: target.folderId, name: target.name }, knownContentHashes);
  }
  for (const [folderId, contentHashes] of moves) {
    next = applyCommand(next, { type: "moveBooks", contentHashes, folderId }, knownContentHashes);
  }
  return {
    envelope: next,
    result: { outcomes, createdFolderIds: [...creates.keys()], organization: next.state },
  };
}
