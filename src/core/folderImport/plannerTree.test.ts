import { describe, expect, it } from "vitest";
import {
  directoryGroupKey,
  planDirectoryImport,
  resolveGroups,
  type ImportOptions,
  type PlannedGroup,
} from "./planner";

const root = { sourceRootKey: "local-root", name: "全部书籍" };
const auto: ImportOptions = {
  grouping: "auto",
  looseRootBooks: "root",
  existingPlacement: "fillUnclassified",
};
const entry = (inputId: string, segments: string[], fileName = "a.epub") => ({
  inputId, relativeParentSegments: segments, fileName,
});

describe("tree directory planner", () => {
  it("creates root and intermediate groups and merges deeper books into level five", () => {
    const plan = planDirectoryImport(root, [
      entry("deep", ["A", "B", "C", "D", "E", "F"], "book.epub"),
      entry("loose", [], "loose.epub"),
    ], auto, { folderId: null, depth: 0 });
    expect(plan.groups.map(g => [g.suggestedName, g.depth, g.parentGroupKey === null]))
      .toEqual([
        ["全部书籍", 1, true],
        ["A", 2, false],
        ["B", 3, false],
        ["C", 4, false],
        ["D", 5, false],
      ]);
    expect(plan.groups.map(g => g.suggestedName)).not.toContain("E");
    expect(plan.flattened).toBe(true);
    const deep = plan.inputs.find(i => i.inputId === "deep")!;
    expect(deep.groupKey).toBe(plan.groups.find(g => g.suggestedName === "D")!.groupKey);
    expect(plan.inputs.find(i => i.inputId === "loose")!.groupKey).toBeNull();
  });

  it("counts the current shelf folder in the five-level budget", () => {
    const plan = planDirectoryImport(root, [
      entry("a", ["A"], "a.epub"),
      entry("b", ["A", "B"], "b.epub"),
    ], auto, { folderId: "current", depth: 3 });
    expect(plan.anchorFolderId).toBe("current");
    expect(plan.anchorDepth).toBe(3);
    expect(plan.groups.map(g => [g.suggestedName, g.depth])).toEqual([
      ["全部书籍", 4],
      ["A", 5],
    ]);
    expect(plan.inputs.find(i => i.inputId === "b")!.groupKey)
      .toBe(plan.groups.find(g => g.suggestedName === "A")!.groupKey);
    expect(plan.flattened).toBe(true);

    const deepest = planDirectoryImport(root, [entry("one", ["A"], "a.epub")], auto, { folderId: "current", depth: 5 });
    expect(deepest.groups).toEqual([]);
    expect(deepest.inputs[0].groupKey).toBeNull();
    expect(deepest.inputs[0].directFolderId).toBe("current");
  });

  it("scopes binding keys to the current folder while preserving legacy root keys", () => {
    const legacy = directoryGroupKey(root, ["A"]);
    expect(legacy).toBe(JSON.stringify([root.sourceRootKey, ["A"]]));
    expect(directoryGroupKey(root, ["A"], "current")).not.toBe(legacy);
  });

  it("reserves a bound sibling and reuses names only under the same parent", () => {
    const groups: PlannedGroup[] = [
      { groupKey: "a", sourceSegments: ["a"], parentGroupKey: null, depth: 1, suggestedName: "系列" },
      { groupKey: "b", sourceSegments: ["b"], parentGroupKey: null, depth: 1, suggestedName: "系列" },
    ];
    const resolved = resolveGroups(groups, [
      { folderId: "existing", name: "系列" },
    ], [{ groupKey: "b", folderId: "existing" }]);
    expect(resolved.map(r => r.kind)).toEqual(["create", "reuse"]);
    expect(resolved[0]).toMatchObject({ kind: "create", name: "系列 (2)" });

    const parent: PlannedGroup = { groupKey: "p", sourceSegments: [], parentGroupKey: null, depth: 1, suggestedName: "父" };
    const child: PlannedGroup = { groupKey: "c", sourceSegments: ["c"], parentGroupKey: "p", depth: 2, suggestedName: "同名" };
    const scoped = resolveGroups([parent, child], [
      { folderId: "p", name: "父", parentId: null },
      { folderId: "c", name: "同名", parentId: "p" },
      { folderId: "other", name: "同名", parentId: "elsewhere" },
    ], []);
    expect(scoped[0]).toMatchObject({ kind: "reuse", folderId: "p" });
    expect(scoped[1]).toMatchObject({ kind: "reuse", folderId: "c" });
  });
});
