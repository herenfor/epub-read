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
  effectiveFolderAncestors,
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
  /**
   * Every target in the preview. A Web batch may need a planned parent folder
   * that has no direct book of its own; creating it in this same transaction
   * keeps a child from being committed under a missing ancestor.
   */
  readonly targets?: readonly FolderTarget[];
  readonly targetSnapshots?: readonly DirectoryTargetSnapshot[];
}

export interface DirectoryTargetSnapshot {
  readonly folderId: string;
  readonly ancestorIds: readonly string[];
}

/** Source-selection baseline; capture new targets from an atomic commit's result. */
export function directoryTargetSnapshotsOf(state: LibraryOrganization): Map<string, DirectoryTargetSnapshot> {
  return new Map(Object.entries(state.folders).filter(([, folder]) => !folder.deleted).map(([folderId]) => [
    folderId, { folderId, ancestorIds: effectiveFolderAncestors(state, folderId) },
  ]));
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
  for (const expected of batch.targetSnapshots ?? []) {
    const folder = state.folders[expected.folderId];
    const ancestors = effectiveFolderAncestors(state, expected.folderId);
    if (!folder || folder.deleted || ancestors.length !== expected.ancestorIds.length
      || ancestors.some((id, index) => id !== expected.ancestorIds[index])) {
      throw new Error("导入目标文件夹位置已变化，请重新预览");
    }
  }
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
      // Keep every planned target, existing or new: an existing one created by
      // an earlier batch still has to match the parent the preview promised.
      if (target.kind === "create") creates.set(target.folderId, target);
      const list = moves.get(decision.folderId) ?? [];
      list.push(item.contentHash);
      moves.set(decision.folderId, list);
    }
    return { inputId: item.inputId, contentHash: item.contentHash, decision };
  });
  const allTargets = batch.targets ?? [...creates.values()];
  const createByFolder = new Map<string, Extract<FolderTarget, { kind: "create" }>>();
  for (const target of allTargets) {
    if (target.kind === "create") createByFolder.set(target.folderId, target);
  }
  // The batch may have to create a planned ancestor that carries no book of
  // its own: walk up from every newly created target and keep the create chain.
  const needed = new Map<string, Extract<FolderTarget, { kind: "create" }>>();
  const requireAncestors = (target: Extract<FolderTarget, { kind: "create" }>): void => {
    if (needed.has(target.folderId)) return;
    needed.set(target.folderId, target);
    const parentId = target.parentFolderId ?? null;
    const parentTarget = parentId === null ? undefined : createByFolder.get(parentId);
    if (parentTarget) requireAncestors(parentTarget);
  };
  for (const target of creates.values()) requireAncestors(target);

  let next = envelope;
  const createdFolderIds = new Set<string>();
  const creating = new Set<string>();
  const createTarget = (target: Extract<FolderTarget, { kind: "create" }>): void => {
    if (createdFolderIds.has(target.folderId)) return;
    const existing = next.state.folders[target.folderId];
    const expectedParent = target.parentFolderId ?? null;
    if (existing) {
      if (existing.deleted) throw new Error("导入目标文件夹已解散，请重新预览");
      const currentParent = existing.parentId?.value ?? null;
      // A folder created by an earlier batch moved since the preview: do not
      // silently commit the rest of the tree under a changed ancestor.
      if (currentParent !== expectedParent) throw new Error("导入目标文件夹位置已变化，请重新预览");
      createdFolderIds.add(target.folderId);
      return;
    }
    if (creating.has(target.folderId)) throw new Error("导入目标文件夹层级存在环");
    creating.add(target.folderId);
    const parentId = target.parentFolderId ?? null;
    if (parentId !== null) {
      const parentTarget = createByFolder.get(parentId) ?? needed.get(parentId);
      if (parentTarget) {
        createTarget(parentTarget);
      } else {
        const parent = next.state.folders[parentId];
        if (!parent || parent.deleted) throw new Error("导入目标祖先文件夹不存在或已解散，请重新预览");
      }
    }
    next = applyCommand(next, { type: "createFolder", folderId: target.folderId, name: target.name, parentId }, knownContentHashes);
    creating.delete(target.folderId);
    createdFolderIds.add(target.folderId);
  };
  for (const target of needed.values()) createTarget(target);

  for (const [folderId, contentHashes] of moves) {
    next = applyCommand(next, { type: "moveBooks", contentHashes, folderId }, knownContentHashes);
  }
  return {
    envelope: next,
    result: { outcomes, createdFolderIds: [...createdFolderIds], organization: next.state },
  };
}
