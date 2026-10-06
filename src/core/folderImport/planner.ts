/** Pure folder-import planning core (FI): grouping, naming, binding reuse, conditional placement. */
export type PlacementPolicy = "fillUnclassified" | "preserveAll" | "replace";
export interface ImportOptions {
  readonly grouping: "auto" | "singleFolder" | "none";
  readonly looseRootBooks: "root" | "namedFolder";
  readonly existingPlacement: PlacementPolicy;
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
  readonly sourceSegments: readonly string[];
  readonly suggestedName: string;
}
export interface PlannedInput {
  readonly inputId: string;
  readonly ordinal: number;
  readonly groupKey: string | null;
}
export interface ImportPlan {
  readonly groups: readonly PlannedGroup[];
  readonly inputs: readonly PlannedInput[];
  readonly flattened: boolean;
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
export function directoryGroupKey(root: ImportRoot, segments: readonly string[]): string {
  // JSON array prevents separator/name collisions; never decode display names.
  return JSON.stringify([root.sourceRootKey, segments]);
}
export function proposedFolderName(root: ImportRoot, segments: readonly string[]): string {
  const names = segments.length ? segments : [root.name];
  const leaf = names[names.length - 1].trim() || "导入书籍";
  let result = Array.from(leaf).slice(0, 40).join("");
  for (let i = names.length - 2; i >= 0; i--) {
    const candidate = `${names[i].trim()} · ${result}`;
    if (Array.from(candidate).length > 40) break;
    result = candidate;
  }
  return result;
}

export function planDirectoryImport(
  root: ImportRoot,
  entries: readonly ScannedEpub[],
  options: ImportOptions,
): ImportPlan {
  const hasChildren = entries.some(e => e.relativeParentSegments.length > 0);
  const groups = new Map<string, PlannedGroup>();
  const mapped = entries.map(entry => {
    let segments: readonly string[] | null;
    if (options.grouping === "none") segments = null;
    else if (options.grouping === "singleFolder") segments = [];
    else if (entry.relativeParentSegments.length) segments = entry.relativeParentSegments;
    else segments = !hasChildren || options.looseRootBooks === "namedFolder" ? [] : null;
    const groupKey = segments === null ? null : directoryGroupKey(root, segments);
    if (groupKey !== null && !groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey, sourceSegments: [...segments!],
        suggestedName: proposedFolderName(root, segments!),
      });
    }
    return { entry, groupKey };
  });
  mapped.sort((a, b) => {
    // Categorized candidates must precede loose-root duplicates even across batches.
    const targetOrder = Number(a.groupKey === null) - Number(b.groupKey === null);
    return targetOrder
      || compareSegments(
        [...a.entry.relativeParentSegments, a.entry.fileName],
        [...b.entry.relativeParentSegments, b.entry.fileName],
      )
      || compareCodePoints(a.entry.inputId, b.entry.inputId);
  });
  return {
    groups: [...groups.values()].sort((a, b) =>
      compareSegments(a.sourceSegments, b.sourceSegments)),
    inputs: mapped.map(({ entry, groupKey }, ordinal) => ({
      inputId: entry.inputId, ordinal, groupKey,
    })),
    flattened: options.grouping === "auto"
      && entries.some(e => e.relativeParentSegments.length > 1),
  };
}

export interface ActiveFolder { readonly folderId: string; readonly name: string }
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
export function resolveGroups(
  groups: readonly PlannedGroup[],
  activeFolders: readonly ActiveFolder[],
  bindings: readonly DirectoryBinding[],
): readonly GroupResolution[] {
  const byId = new Map(activeFolders.map(f => [f.folderId, f]));
  const byGroup = new Map(bindings.map(b => [b.groupKey, b.folderId]));
  const byName = new Map<string, ActiveFolder[]>();
  for (const folder of activeFolders) {
    const list = byName.get(folder.name) ?? [];
    list.push(folder);
    byName.set(folder.name, list);
  }
  const usedNames = new Set(activeFolders.map(f => f.name));
  // Reserve all valid source bindings first, including groups visited later.
  const claimedNames = new Set(groups.flatMap(group => {
    const bound = byGroup.get(group.groupKey);
    const folder = bound ? byId.get(bound) : undefined;
    return folder ? [folder.name] : [];
  }));
  return groups.map(group => {
    const bound = byGroup.get(group.groupKey);
    if (bound && byId.has(bound)) {
      claimedNames.add(byId.get(bound)!.name);
      return { groupKey: group.groupKey, kind: "reuse", folderId: bound };
    }
    const matches = byName.get(group.suggestedName) ?? [];
    if (!claimedNames.has(group.suggestedName) && matches.length) {
      claimedNames.add(group.suggestedName);
      if (matches.length === 1) {
        return { groupKey: group.groupKey, kind: "reuse", folderId: matches[0].folderId };
      }
      return { groupKey: group.groupKey, kind: "choose", candidates: matches };
    }
    const name = uniqueName(group.suggestedName, usedNames);
    usedNames.add(name);
    claimedNames.add(group.suggestedName);
    return { groupKey: group.groupKey, kind: "create", name };
  });
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
