import { describe, expect, it } from "vitest";
import {
  emptyOrganization,
  MAX_FOLDER_DEPTH,
  type FolderState,
  type LibraryOrganization,
} from "./libraryOrganization";
import {
  folderAlreadyAt,
  folderMoveBlockReason,
  shelfFolderIndex,
  shelfFolderPath,
  shelfFolderPathLabel,
  shelfFolderSubtreeHeight,
} from "./shelfFolderTree";

const DEVICE = "00000000-0000-4000-8000-00000000000a";
const stamp = (counter: number) => ({ counter, deviceId: DEVICE });
const id = (n: number) => `1111111${n}-1111-4111-8111-11111111111${n}`.slice(0, 36);

function folder(name: string, parentId: string | null = null, counter = 1): FolderState {
  return {
    name: { value: name, stamp: stamp(counter) },
    parentId: { value: parentId, stamp: stamp(counter + 1) },
  };
}

function organization(): LibraryOrganization {
  const base = emptyOrganization();
  const [a, b, c, d, e, x, y] = [1, 2, 3, 4, 5, 6, 7].map(id);
  return {
    ...base,
    folders: {
      [a]: folder("系列"),
      [b]: folder("2024", a),
      [c]: folder("二月", b),
      [d]: folder("上旬", c),
      [e]: folder("第一周", d),
      [x]: folder("技术书"),
      [y]: folder("系列"),
    },
  };
}

describe("shelf folder tree projection", () => {
  it("builds root-first paths and effective depths from the shared projection", () => {
    const state = organization();
    const [a, , c, , e] = [1, 2, 3, 4, 5].map(id);
    const index = shelfFolderIndex(state);
    expect(index.byId.get(e)?.depth).toBe(5);
    expect(shelfFolderPath(state, e).map((node) => node.name)).toEqual(["系列", "2024", "二月", "上旬", "第一周"]);
    expect(shelfFolderPathLabel(state, c)).toBe("书架 › 系列 › 2024 › 二月");
    expect(shelfFolderPathLabel(state, null)).toBe("书架");
    expect(index.childrenByParent.get(null)?.map((node) => node.name)).toEqual(["技术书", "系列", "系列"]);
    expect(shelfFolderSubtreeHeight(state, a)).toBe(5);
    expect(shelfFolderSubtreeHeight(state, e)).toBe(1);
  });

  it("explains every folder move restriction and allows a legal move", () => {
    const state = organization();
    const [a, b, , d, , x, y] = [1, 2, 3, 4, 5, 6, 7].map(id);
    expect(folderMoveBlockReason(state, a, a)).toBe("self");
    expect(folderMoveBlockReason(state, a, d)).toBe("inside");
    expect(folderMoveBlockReason(state, a, x)).toBe("too-deep");
    expect(folderMoveBlockReason(state, y, null)).toBe("same-name");
    expect(folderMoveBlockReason(state, b, x)).toBeNull();
    expect(folderAlreadyAt(state, b, a)).toBe(true);
    expect(folderAlreadyAt(state, b, x)).toBe(false);
    expect(MAX_FOLDER_DEPTH).toBe(5);
    // Creating under the fifth level is rejected by the data layer; the UI
    // uses the same height check for the folder itself.
    expect(shelfFolderSubtreeHeight(state, a)).toBe(MAX_FOLDER_DEPTH);
  });
});
