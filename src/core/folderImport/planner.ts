/** Pure folder-import planning core (FI): grouping, naming, binding reuse, conditional placement. */
import { MAX_FOLDER_DEPTH } from "../../ui/libraryOrganization";

export type PlacementPolicy = "fillUnclassified" | "preserveAll" | "replace";
export interface ImportOptions {
  readonly grouping: "auto" | "singleFolder" | "none";
  readonly looseRootBooks: "root" | "namedFolder";
  readonly existingPlacement: PlacementPolicy;
}
export interface ImportAnchor {
  /** Current shelf folder; null means the root shelf. */
  readonly folderId: string | null;
  /** Current folder depth, 0 = root shelf, 1..5 = existing folder depth. */
  readonly depth: number;
}
export interface ScannedEpub {
  readonly inputId: string;
  readonly relativeParentSegments: readonly string[];
  readonly fileName: string;
  readonly sizeHint?: number;
}
export interface ImportRoot {
  /** Stable local identity of the selected physical tree; never exported. */
  readonly sourceRootKey: string;
  readonly name: string;
}
export interface PlannedGroup {
  readonly groupKey: string;
  /** Source path prefix represented by this folder (never the display path). */
  readonly sourceSegments: readonly string[];
  readonly parentGroupKey: string | null;
  /** Absolute shelf depth, 1..MAX_FOLDER_DEPTH. */
  readonly depth: number;
  readonly suggestedName: string;
}
export interface PlannedInput {
  readonly inputId: string;
  readonly ordinal: number;
  readonly groupKey: string | null;
  /** Set only when the current folder is the deepest allowed target (no new level). */
  readonly directFolderId?: string;
}
export interface ImportPlan {
  readonly groups: readonly PlannedGroup[];
  readonly inputs: readonly PlannedInput[];
  /** True when at least one source path was merged into the fifth-level target. */
  readonly flattened: boolean;
  readonly anchorFolderId: string | null;
  readonly anchorDepth: number;
}

/** Matches Rust str.chars() order; no platform locale or UTF-16 ordering. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, c => c.codePointAt(0)!);
  const right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}
function compareSegments(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const compared = compareCodePoints(a[i], b[i]);
    if (compared) return compared;
  }
  return Math.sign(a.length - b.length);
}
/**
 * Local directory binding key. A non-root anchor adds the current folder to
 * the key so the same source tree under different shelf parents cannot reuse
 * or overwrite one another's mapping. The legacy two-element key stays for
 * root imports, preserving existing root bindings.
 */
export function directoryGroupKey(
  root: ImportRoot,
  segments: readonly string[],
  anchorFolderId: string | null = null,
): string {
  const tuple: unknown[] = [root.sourceRootKey, segments];
  if (anchorFolderId !== null) tuple.push(anchorFolderId);
  return JSON.stringify(tuple);
}
/** A tree folder uses the leaf name only; package 3 shows the path separately. */
export function proposedFolderName(root: ImportRoot, segments: readonly string[]): string {
  const raw = segments.length ? segments[segments.length - 1] : root.name;
  return Array.from(raw.trim() || "导入书籍").slice(0, 40).join("");
}

function normalizedAnchor(anchor?: ImportAnchor): ImportAnchor {
  const folderId = anchor?.folderId ?? null;
  if (folderId === null) return { folderId: null, depth: 0 };
  const rawDepth = anchor?.depth ?? 0;
  const depth = Number.isFinite(rawDepth) ? Math.trunc(rawDepth) : 0;
  return {
    folderId,
    depth: Math.max(0, Math.min(MAX_FOLDER_DEPTH, depth)),
  };
}

export function planDirectoryImport(
  root: ImportRoot,
  entries: readonly ScannedEpub[],
  options: ImportOptions,
  anchorInput?: ImportAnchor,
): ImportPlan {
  const anchor = normalizedAnchor(anchorInput);
  const maxNewDepth = MAX_FOLDER_DEPTH - anchor.depth;
  const hasChildren = entries.some(e => e.relativeParentSegments.length > 0);
  const groups = new Map<string, PlannedGroup>();

  const ensureGroup = (segments: readonly string[]): string => {
    const key = directoryGroupKey(root, segments, anchor.folderId);
    if (groups.has(key)) return key;
    const parentGroupKey = segments.length === 0 ? null : ensureGroup(segments.slice(0, -1));
    groups.set(key, {
      groupKey: key,
      sourceSegments: [...segments],
      parentGroupKey,
      depth: anchor.depth + segments.length + 1,
      suggestedName: proposedFolderName(root, segments),
    });
    return key;
  };

  const mapped = entries.map(entry => {
    if (options.grouping === "none") {
      return { entry, groupKey: null as string | null, directFolderId: anchor.folderId ?? undefined };
    }
    if (maxNewDepth <= 0) {
      // The current folder itself is the deepest target; no sixth level is made.
      return { entry, groupKey: null as string | null, directFolderId: anchor.folderId ?? undefined };
    }
    if (options.grouping === "singleFolder") {
      return { entry, groupKey: ensureGroup([]), directFolderId: undefined };
    }
    if (entry.relativeParentSegments.length === 0) {
      // Root-direct books: keep the existing named-folder option. When children
      // exist, their ancestor chain still creates the selected-root folder.
      const rootKey = options.looseRootBooks === "namedFolder" || !hasChildren
        ? ensureGroup([])
        : null;
      return { entry, groupKey: rootKey, directFolderId: undefined };
    }
    const prefix = entry.relativeParentSegments.slice(0, Math.max(0, maxNewDepth - 1));
    return { entry, groupKey: ensureGroup(prefix), directFolderId: undefined };
  });

  const flattened = options.grouping === "auto" && entries.some(entry =>
    entry.relativeParentSegments.length > Math.max(0, maxNewDepth - 1));

  mapped.sort((a, b) => {
    const targetOrder = Number(a.groupKey === null && a.directFolderId === undefined)
      - Number(b.groupKey === null && b.directFolderId === undefined);
    return targetOrder
      || compareSegments(
        [...a.entry.relativeParentSegments, a.entry.fileName],
        [...b.entry.relativeParentSegments, b.entry.fileName],
      )
      || compareCodePoints(a.entry.inputId, b.entry.inputId);
  });
  return {
    groups: [...groups.values()].sort((a, b) => compareSegments(a.sourceSegments, b.sourceSegments)),
    inputs: mapped.map(({ entry, groupKey, directFolderId }, ordinal) => ({
      inputId: entry.inputId,
      ordinal,
      groupKey,
      ...(directFolderId === undefined ? {} : { directFolderId }),
    })),
    flattened,
    anchorFolderId: anchor.folderId,
    anchorDepth: anchor.depth,
  };
}

export interface ActiveFolder {
  readonly folderId: string;
  readonly name: string;
  /** Effective parent; omitted means root for backward-compatible flat callers. */
  readonly parentId?: string | null;
}
export interface DirectoryBinding { readonly groupKey: string; readonly folderId: string }
export type GroupResolution =
  | { readonly groupKey: string; readonly kind: "reuse"; readonly folderId: string }
  | { readonly groupKey: string; readonly kind: "create"; readonly name: string }
  | { readonly groupKey: string; readonly kind: "choose"; readonly candidates: readonly ActiveFolder[] };

function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const tail = ` (${suffix})`;
    const candidate = Array.from(base).slice(0, 40 - Array.from(tail).length).join("") + tail;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Resolve one planned group to an existing or new folder. Name reuse is
 * scoped to the same parent; bindings win first. Existing callers that omit
 * parentId are treated as root siblings until package 3 supplies tree data.
 */
export function resolveGroups(
  groups: readonly PlannedGroup[],
  activeFolders: readonly ActiveFolder[],
  bindings: readonly DirectoryBinding[],
  anchorFolderId: string | null = null,
): readonly GroupResolution[] {
  const byId = new Map(activeFolders.map(f => [f.folderId, f]));
  const byGroup = new Map(bindings.map(b => [b.groupKey, b.folderId]));
  const byParentName = new Map<string, ActiveFolder[]>();
  const usedNames = new Map<string, Set<string>>();
  /** Names already claimed by a source binding or an earlier group in this preview. */
  const claimedNames = new Map<string, Set<string>>();
  const rootKey = (parent: string | null | undefined): string => parent ?? "";
  const namespaceNames = (map: Map<string, Set<string>>, parent: string): Set<string> => {
    let names = map.get(parent);
    if (!names) {
      names = new Set<string>();
      map.set(parent, names);
    }
    return names;
  };
  const addActive = (folder: ActiveFolder): void => {
    const parent = rootKey(folder.parentId);
    const list = byParentName.get(parent) ?? [];
    list.push(folder);
    byParentName.set(parent, list);
    namespaceNames(usedNames, parent).add(folder.name);
  };
  for (const folder of activeFolders) addActive(folder);
  // Reserve folders already bound to another source group. An unbound group
  // may not silently reuse one of those siblings.
  for (const binding of bindings) {
    const folder = byId.get(binding.folderId);
    if (folder) namespaceNames(claimedNames, rootKey(folder.parentId)).add(folder.name);
  }
  const resolvedById = new Map<string, string>();
  const result: GroupResolution[] = [];
  for (const group of [...groups].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0)
    || compareSegments(a.sourceSegments, b.sourceSegments))) {
    const parentNamespace = group.parentGroupKey === null
      ? rootKey(anchorFolderId)
      : resolvedById.get(group.parentGroupKey) ?? `pending:${group.parentGroupKey}`;
    const bound = byGroup.get(group.groupKey);
    if (bound && byId.has(bound)) {
      resolvedById.set(group.groupKey, bound);
      result.push({ groupKey: group.groupKey, kind: "reuse", folderId: bound });
      continue;
    }
    const claimed = namespaceNames(claimedNames, parentNamespace);
    const matches = claimed.has(group.suggestedName)
      ? []
      : (byParentName.get(parentNamespace) ?? [])
        .filter(folder => folder.name === group.suggestedName);
    if (matches.length === 1) {
      claimed.add(group.suggestedName);
      resolvedById.set(group.groupKey, matches[0].folderId);
      result.push({ groupKey: group.groupKey, kind: "reuse", folderId: matches[0].folderId });
      continue;
    }
    if (matches.length > 1) {
      claimed.add(group.suggestedName);
      result.push({ groupKey: group.groupKey, kind: "choose", candidates: matches });
      continue;
    }
    const names = namespaceNames(usedNames, parentNamespace);
    const name = uniqueName(group.suggestedName, names);
    names.add(name);
    claimed.add(group.suggestedName);
    result.push({ groupKey: group.groupKey, kind: "create", name });
  }
  return result;
}

export interface Stamp { readonly deviceId: string; readonly counter: number }
export interface PlacementSnapshot {
  readonly rawFolderId: string | null;
  readonly stamp: Stamp | null; // absent register differs from explicit null+stamp
  readonly effectiveFolderId: string | null;
}
export type PlacementDecision =
  | { readonly kind: "keep"; readonly reason: "unclassified-target" | "existing-policy" | "same-folder" | "already-classified" }
  | { readonly kind: "move"; readonly folderId: string }
  | { readonly kind: "skipped"; readonly reason: "placement-changed" | "target-deleted" };
export function decidePlacement(
  observed: PlacementSnapshot,
  current: PlacementSnapshot,
  isExistingBook: boolean,
  targetFolderId: string | null,
  targetIsAlive: boolean,
  policy: PlacementPolicy,
): PlacementDecision {
  if (targetFolderId === null) return { kind: "keep", reason: "unclassified-target" };
  if (isExistingBook && policy === "preserveAll") return { kind: "keep", reason: "existing-policy" };
  const sameStamp = observed.stamp === null
    ? current.stamp === null
    : current.stamp !== null && observed.stamp.deviceId === current.stamp.deviceId
      && observed.stamp.counter === current.stamp.counter;
  if (!sameStamp || observed.rawFolderId !== current.rawFolderId
    || observed.effectiveFolderId !== current.effectiveFolderId) {
    return { kind: "skipped", reason: "placement-changed" };
  }
  if (!targetIsAlive) return { kind: "skipped", reason: "target-deleted" };
  if (current.effectiveFolderId === targetFolderId) return { kind: "keep", reason: "same-folder" };
  if (isExistingBook && policy === "fillUnclassified" && current.effectiveFolderId !== null) {
    return { kind: "keep", reason: "already-classified" };
  }
  return { kind: "move", folderId: targetFolderId };
}

/** One instance per job, called only in ordinal order after a successful publish. */
export class SuccessfulSources {
  private readonly chosen = new Map<string, number>();
  winner(contentHash: string): number | undefined { return this.chosen.get(contentHash); }
  recordPublished(contentHash: string, ordinal: number): void {
    if (!this.chosen.has(contentHash)) this.chosen.set(contentHash, ordinal);
  }
  // Failed prepare/publish never records a winner; the next source may succeed.
}
