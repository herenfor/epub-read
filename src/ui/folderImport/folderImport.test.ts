import { describe, expect, it } from "vitest";
import { buildEpub } from "../../test/fixtures";
import {
  decidePlacement,
  directoryGroupKey,
  planDirectoryImport,
  resolveGroups,
  SuccessfulSources,
  type ImportOptions,
} from "../../core/folderImport/planner";
import type { DirectoryProgress, FolderTarget } from "../../core/folderImport/contract";
import { buildFolderTargets, DEFAULT_FOLDER_IMPORT_OPTIONS } from "./FolderImportPanel";
import { createWebDirectoryImportPort, scanWebDirectoryFiles, type WebDirectoryImportStore } from "./webDirectoryImport";
import {
  applyCommand,
  effectiveFolderId,
  emptyOrganization,
  type OrganizationCommand,
  type OrganizationEnvelope,
} from "../libraryOrganization";
import type { ShelfEntry, ShelfSaveInput } from "../shelf";
import { sha256Hex } from "../importBooks";

const root = { sourceRootKey: "local-root", name: "全部书籍" };
const auto: ImportOptions = DEFAULT_FOLDER_IMPORT_OPTIONS;

describe("folder import planner (migrated core)", () => {
  it("maps root-only, mixed root/categories and deep folders", () => {
    const flat = planDirectoryImport(root, [{ inputId: "r", relativeParentSegments: [], fileName: "a.epub" }], auto);
    expect(flat.groups.map((g) => g.suggestedName)).toEqual(["全部书籍"]);

    const mixed = planDirectoryImport(root, [
      { inputId: "loose", relativeParentSegments: [], fileName: "0.epub" },
      { inputId: "deep", relativeParentSegments: ["分类", "系列"], fileName: "z.epub" },
    ], auto);
    expect(mixed.flattened).toBe(true);
    // Categorized candidates precede loose-root duplicates.
    expect(mixed.inputs.map((i) => [i.inputId, i.groupKey === null])).toEqual([["deep", false], ["loose", true]]);
    expect(mixed.groups.map((g) => g.suggestedName)).toEqual(["分类 · 系列"]);
    expect(directoryGroupKey(root, ["a · b"])).not.toBe(directoryGroupKey(root, ["a", "b"]));
  });

  it("reserves bound folders first, reuses renamed bindings and suffixes collisions", () => {
    const named = [
      { groupKey: "a", sourceSegments: ["a"], suggestedName: "系列" },
      { groupKey: "b", sourceSegments: ["b"], suggestedName: "系列" },
    ];
    const resolved = resolveGroups(named, [{ folderId: "existing", name: "系列" }], [{ groupKey: "b", folderId: "existing" }]);
    expect(resolved.map((r) => r.kind)).toEqual(["create", "reuse"]);
    expect(resolved[0]).toMatchObject({ kind: "create", name: "系列 (2)" });
    expect(resolveGroups(named.slice(0, 1), [{ folderId: "existing", name: "改名后" }], [{ groupKey: "a", folderId: "existing" }])[0])
      .toMatchObject({ kind: "reuse", folderId: "existing" });
    expect(resolveGroups(named.slice(0, 1), [{ folderId: "x", name: "系列" }, { folderId: "y", name: "系列" }], [])[0].kind)
      .toBe("choose");
  });

  it("conditional placement and cross-batch winners", () => {
    const observed = { rawFolderId: "old", effectiveFolderId: "old", stamp: { deviceId: "device", counter: 1 } };
    expect(decidePlacement(observed, { ...observed, stamp: { deviceId: "device", counter: 2 } }, true, "new", true, "replace").kind).toBe("skipped");
    expect(decidePlacement(observed, { ...observed, effectiveFolderId: null }, true, "new", true, "fillUnclassified").kind).toBe("skipped");
    expect(decidePlacement(observed, observed, true, null, false, "replace").kind).toBe("keep");
    expect(decidePlacement(observed, observed, true, "new", true, "fillUnclassified").kind).toBe("keep");
    const successful = new SuccessfulSources();
    expect(successful.winner("hash")).toBeUndefined();
    successful.recordPublished("hash", 3);
    successful.recordPublished("hash", 8);
    expect(successful.winner("hash")).toBe(3);
  });

  it("builds start targets that cover every group and never pass an unresolved choice", () => {
    const groups = [
      { groupKey: "a", sourceSegments: ["a"], suggestedName: "A" },
      { groupKey: "b", sourceSegments: ["b"], suggestedName: "B" },
    ];
    const resolutions = [
      { groupKey: "a", kind: "create" as const, name: "A (2)" },
      { groupKey: "b", kind: "choose" as const, candidates: [{ folderId: "x", name: "B" }, { folderId: "y", name: "B" }] },
    ];
    expect(buildFolderTargets(groups, resolutions, {})).toBeNull();
    const targets = buildFolderTargets(groups, resolutions, { b: { kind: "reuse", folderId: "y" } }, () => "new-id");
    expect(targets).toEqual<FolderTarget[]>([
      { groupKey: "a", kind: "create", folderId: "new-id", name: "A (2)" },
      { groupKey: "b", kind: "reuse", folderId: "y" },
    ]);
  });
});

/** In-memory active data source with the real organization reducer. */
function memoryStore(initial: { entries?: ShelfEntry[]; envelope?: OrganizationEnvelope } = {}) {
  const entries = new Map<string, ShelfEntry>((initial.entries ?? []).map((e) => [e.id, e]));
  const bytes = new Map<string, Uint8Array>();
  let envelope: OrganizationEnvelope = initial.envelope ?? { deviceId: "00000000-0000-4000-8000-000000000001", counter: 0, state: emptyOrganization() };
  const saves: string[] = [];
  const commands: OrganizationCommand[] = [];
  const hooks: { beforeOrganizationRead?: (call: number) => void } = {};
  let reads = 0;
  const known = () => new Set([...entries.values()].map((e) => e.contentHash!).filter(Boolean));
  const store: WebDirectoryImportStore = {
    async list() { return [...entries.values()]; },
    async save(input: ShelfSaveInput) {
      saves.push(input.entry.id);
      const existing = entries.get(input.entry.id);
      if (existing) return { status: "duplicate", entry: existing };
      const entry = { progressPct: 0, lastReadAtMs: 0, spineIndex: 0, page: 0, anchorIndex: null, anchorRatio: null,
        anchorTextOffset: null, anchorTextSnippet: null, isNew: true, ...input.entry } as ShelfEntry;
      entries.set(entry.id, entry);
      bytes.set(entry.id, input.bytes);
      return { status: "saved", entry };
    },
    async readBook(id) { return bytes.get(id)!; },
    async setContentHash(id) { return entries.get(id)!; },
    async getOrganization() {
      hooks.beforeOrganizationRead?.(++reads);
      return envelope.state;
    },
    async applyOrganization(command) {
      commands.push(command);
      envelope = applyCommand(envelope, command, known());
      return envelope.state;
    },
  };
  const userCommand = (command: OrganizationCommand) => { envelope = applyCommand(envelope, command, known()); };
  return { store, saves, commands, hooks, userCommand, state: () => envelope.state };
}

function existingEntry(hash: string, title: string): ShelfEntry {
  return {
    id: hash, title, creator: "", fileName: `${title}.epub`, fileSize: 1, coverMime: "", addedAtMs: 1,
    lastReadAtMs: 5, spineIndex: 2, page: 3, progressPct: 42, anchorIndex: null, anchorRatio: null,
    anchorTextOffset: null, anchorTextSnippet: null, isNew: false, contentHash: hash,
  } as ShelfEntry;
}

function fakeFile(path: string, data: Uint8Array): File {
  const name = path.split("/").at(-1)!;
  return {
    name,
    size: data.byteLength,
    webkitRelativePath: path,
    arrayBuffer: async () => data.slice().buffer,
  } as unknown as File;
}

const epub = (title: string) => buildEpub({
  version: 3, title, identifier: `urn:uuid:${title}`,
  chapters: [{ id: "c1", href: "c1.xhtml", content: `<p>${title}</p>` }],
});

const OLD_FOLDER = "11111111-1111-4111-8111-111111111111";
const HISTORY_FOLDER = "22222222-2222-4222-8222-222222222222";
const OTHER_FOLDER = "33333333-3333-4333-8333-333333333333";

async function scenario() {
  const [a, b, c, d] = await Promise.all([epub("A"), epub("B"), epub("C"), epub("D")]);
  const [hashA, hashB, hashC, hashD] = await Promise.all([a, b, c, d].map(sha256Hex));
  const memory = memoryStore({ entries: [existingEntry(hashC, "C"), existingEntry(hashD, "D")] });
  for (const command of [
    { type: "createFolder", folderId: OLD_FOLDER, name: "旧夹" },
    { type: "createFolder", folderId: HISTORY_FOLDER, name: "历史" },
    { type: "createFolder", folderId: OTHER_FOLDER, name: "别处" },
    { type: "moveBooks", contentHashes: [hashC], folderId: OLD_FOLDER },
  ] as const) memory.userCommand(command);
  const files = [
    fakeFile("全部书籍/散书.epub", a), // duplicate of A, loose root: must not win over the category copy
    fakeFile("全部书籍/小说/科幻/b.epub", b),
    fakeFile("全部书籍/小说/a.epub", a),
    fakeFile("全部书籍/历史/c.epub", c),
    fakeFile("全部书籍/历史/d.epub", d),
    fakeFile("全部书籍/历史/封面.jpg", new Uint8Array([1])),
  ];
  let id = 0;
  const port = createWebDirectoryImportPort({
    store: memory.store,
    pickDirectory: async () => files,
    newId: () => `44444444-4444-4444-8444-${String(++id).padStart(12, "0")}`,
    progressIntervalMs: 0,
  });
  return { memory, port, hashes: { hashA, hashB, hashC, hashD } };
}

async function importAll(port: ReturnType<typeof createWebDirectoryImportPort>, state: () => ReturnType<ReturnType<typeof memoryStore>["state"]>) {
  const scan = (await port.scan(() => undefined))!;
  const page = await port.page(scan.jobId);
  const plan = planDirectoryImport(scan.root, page.items, auto);
  const active = Object.entries(state().folders).filter(([, f]) => !f.deleted).map(([folderId, f]) => ({ folderId, name: f.name.value }));
  const resolutions = resolveGroups(plan.groups, active, page.bindings);
  let folderSeq = 0;
  const targets = buildFolderTargets(plan.groups, resolutions, {},
    () => `55555555-5555-4555-8555-${String(++folderSeq).padStart(12, "0")}`)!;
  const events: DirectoryProgress[] = [];
  const result = await port.start({ jobId: scan.jobId, options: auto, targets, onProgress: (e) => events.push(e) });
  return { scan, page, plan, result, events };
}

describe("Web directory import port", () => {
  it("scans webkitRelativePath segments, keeps only EPUB candidates and claims no binding", () => {
    const scanned = scanWebDirectoryFiles([
      fakeFile("根/a.epub", new Uint8Array()),
      fakeFile("根/x/y/b.EPUB", new Uint8Array()),
      fakeFile("根/x/note.txt", new Uint8Array()),
    ], "web:key");
    expect(scanned.root).toEqual({ sourceRootKey: "web:key", name: "根" });
    expect(scanned.items.map((i) => i.relativeParentSegments)).toEqual([[], ["x", "y"]]);
  });

  it("imports in planner order, keeps classified books, creates folders only when used", async () => {
    const { memory, port, hashes } = await scenario();
    const { result, page } = await importAll(port, memory.state);
    expect(page.bindings).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.counts).toMatchObject({ completed: 5, imported: 2, duplicates: 3, failed: 0, placementSkipped: 0, createdFolders: 2 });
    const state = memory.state();
    const nameOf = (hash: string) => {
      const id = effectiveFolderId(state, hash);
      return id ? state.folders[id].name.value : null;
    };
    expect(nameOf(hashes.hashA)).toBe("小说"); // category copy wins over the loose-root duplicate
    expect(nameOf(hashes.hashB)).toBe("小说 · 科幻");
    expect(nameOf(hashes.hashC)).toBe("旧夹"); // already classified: kept
    expect(nameOf(hashes.hashD)).toBe("历史"); // unclassified existing book: reuses the unique same-name folder
    // Existing canonical rows are never re-saved (no fabricated 0% progress).
    expect([...memory.saves].sort()).toEqual([hashes.hashA, hashes.hashB].sort());
  });

  it("does not overwrite a placement the user changed during the import", async () => {
    const { memory, port, hashes } = await scenario();
    // Second organization read is the commit-time re-check: the user moved D meanwhile.
    memory.hooks.beforeOrganizationRead = (call) => {
      if (call === 2) memory.userCommand({ type: "moveBooks", contentHashes: [hashes.hashD], folderId: OTHER_FOLDER });
    };
    const { result } = await importAll(port, memory.state);
    expect(result.counts.placementSkipped).toBe(1);
    expect(effectiveFolderId(memory.state(), hashes.hashD)).toBe(OTHER_FOLDER);
    const issues = await port.issues(result.jobId);
    expect(issues.items.map((i) => i.kind)).toContain("placement-changed");
  });
});
