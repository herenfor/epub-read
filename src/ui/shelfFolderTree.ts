import {
  MAX_FOLDER_DEPTH,
  effectiveFolderAncestors,
  effectiveFolderChildren,
  effectiveFolderDepth,
  effectiveFolderParent,
  projectFolderTree,
  type LibraryOrganization,
} from "./libraryOrganization";

/** A live folder with its effective parent/depth in the shared five-level projection. */
export interface ShelfFolderNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly depth: number;
}

export interface ShelfFolderIndex {
  readonly byId: ReadonlyMap<string, ShelfFolderNode>;
  readonly childrenByParent: ReadonlyMap<string | null, readonly ShelfFolderNode[]>;
}

function compareNames(a: ShelfFolderNode, b: ShelfFolderNode): number {
  return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }) || a.id.localeCompare(b.id);
}

/**
 * One tree projection for navigation, dropdowns and the move picker. Parents,
 * depths and children all come from projectFolderTree so a synced deeper or
 * partially deleted tree is presented exactly like the data layer does.
 */
export function shelfFolderIndex(state: LibraryOrganization): ShelfFolderIndex {
  const projection = projectFolderTree(state);
  const byId = new Map<string, ShelfFolderNode>();
  for (const id of projection.depthById.keys()) {
    const folder = state.folders[id];
    if (!folder || folder.deleted) continue;
    byId.set(id, {
      id,
      name: folder.name.value,
      parentId: projection.parentById.get(id) ?? null,
      depth: projection.depthById.get(id) ?? 1,
    });
  }
  const childrenByParent = new Map<string | null, ShelfFolderNode[]>();
  for (const node of byId.values()) {
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }
  for (const siblings of childrenByParent.values()) siblings.sort(compareNames);
  return { byId, childrenByParent };
}

/** Root-first path to the folder, including the folder itself. */
export function shelfFolderPath(state: LibraryOrganization, folderId: string): ShelfFolderNode[] {
  const index = shelfFolderIndex(state);
  const current = index.byId.get(folderId);
  if (!current) return [];
  return [...effectiveFolderAncestors(state, folderId)]
    .flatMap((id) => index.byId.get(id) ?? [])
    .concat(current);
}

/** Display path used in the import preview and the move picker: 书架 › A › B. */
export function shelfFolderPathLabel(state: LibraryOrganization, folderId: string | null): string {
  const names = folderId === null
    ? []
    : shelfFolderPath(state, folderId).map((node) => node.name);
  return ["书架", ...names].join(" › ");
}

/** All live descendants of a folder (excluding itself). */
export function shelfFolderDescendants(state: LibraryOrganization, folderId: string): ShelfFolderNode[] {
  const index = shelfFolderIndex(state);
  const result: ShelfFolderNode[] = [];
  const seen = new Set<string>();
  const pending = [...(index.childrenByParent.get(folderId) ?? [])];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
    pending.push(...(index.childrenByParent.get(node.id) ?? []));
  }
  return result;
}

/** 1 for a leaf, up to MAX_FOLDER_DEPTH for a chain that already reaches the cap. */
export function shelfFolderSubtreeHeight(state: LibraryOrganization, folderId: string): number {
  const index = shelfFolderIndex(state);
  const walk = (id: string, seen: ReadonlySet<string>): number => {
    const children = index.childrenByParent.get(id) ?? [];
    let deepest = 0;
    for (const child of children) {
      if (seen.has(child.id)) continue;
      deepest = Math.max(deepest, walk(child.id, new Set(seen).add(child.id)));
    }
    return 1 + deepest;
  };
  return index.byId.has(folderId) ? walk(folderId, new Set([folderId])) : 0;
}

export type FolderMoveBlock = "self" | "inside" | "too-deep" | "same-name";

/**
 * Why a folder cannot be moved under `targetParentId` (null = shelf root).
 * Returns null when the move is allowed. Moving beside the current parent is
 * allowed by this pure check; the dialog labels it as "already here" and
 * disables it separately.
 */
export function folderMoveBlockReason(
  state: LibraryOrganization,
  folderId: string,
  targetParentId: string | null,
): FolderMoveBlock | null {
  const folder = state.folders[folderId];
  if (!folder || folder.deleted) return "self";
  if (targetParentId === folderId) return "self";
  if (targetParentId !== null) {
    const target = state.folders[targetParentId];
    if (!target || target.deleted) return "self";
    if (effectiveFolderAncestors(state, targetParentId).includes(folderId)) return "inside";
  }
  const targetDepth = targetParentId === null ? 0 : (effectiveFolderDepth(state, targetParentId) ?? 0);
  if (targetDepth + shelfFolderSubtreeHeight(state, folderId) > MAX_FOLDER_DEPTH) return "too-deep";
  const name = folder.name.value;
  const siblings = effectiveFolderChildren(state, targetParentId)
    .filter((id) => id !== folderId && state.folders[id]?.name.value === name);
  if (siblings.length > 0) return "same-name";
  return null;
}

/** True when `targetParentId` is exactly where the folder already lives. */
export function folderAlreadyAt(state: LibraryOrganization, folderId: string, targetParentId: string | null): boolean {
  return effectiveFolderParent(state, folderId) === targetParentId;
}
