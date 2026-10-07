import { describe, expect, it, vi } from "vitest";
import { buildEpub } from "../../test/fixtures";
import {
  decidePlacement,
  directoryGroupKey,
  planDirectoryImport,
  resolveGroups,
  SuccessfulSources,
  type ImportOptions,
} from "../../core/folderImport/planner";
import type { DirectoryImportPort, DirectoryProgress, FolderTarget } from "../../core/folderImport/contract";
import { applyDirectoryPlacementBatch, placementSnapshotOf } from "./placementBatch";
import { FolderImportJobOwner } from "./jobOwner";
import { createNativeDirectoryImportPort } from "../../platform/directoryImportBridge";
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

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: nativeInvoke,
  Channel: class {
    onmessage: ((event: DirectoryProgress) => void) | null = null;
  },
}));

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
  const commits: number[] = [];
  /** Runs before the atomic commit begins: the last point another writer can interleave. */
  const hooks: { beforeCommit?: (call: number) => void } = {};
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
    async getOrganization() { return envelope.state; },
    // Same semantics FI-I gives IndexedDB: read, decide, create+move, write in one step.
    async commitDirectoryPlacementBatch(batch) {
      commits.push(batch.items.length);
      hooks.beforeCommit?.(commits.length);
      const applied = applyDirectoryPlacementBatch(envelope, batch, known());
      envelope = applied.envelope;
      return applied.result;
    },
  };
  const userCommand = (command: OrganizationCommand) => { envelope = applyCommand(envelope, command, known()); };
  return { store, saves, commits, hooks, userCommand, state: () => envelope.state };
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
    // The user moves D after it was observed, right before the batch commits.
    memory.hooks.beforeCommit = () => {
      memory.userCommand({ type: "moveBooks", contentHashes: [hashes.hashD], folderId: OTHER_FOLDER });
    };
    const { result } = await importAll(port, memory.state);
    expect(result.counts.placementSkipped).toBe(1);
    expect(effectiveFolderId(memory.state(), hashes.hashD)).toBe(OTHER_FOLDER);
    const issues = await port.issues(result.jobId);
    expect(issues.items.map((i) => i.kind)).toContain("placement-changed");
  });

  it("commits a placement batch atomically: a failing move leaves no folder behind", async () => {
    const [a] = await Promise.all([epub("A")]);
    const hashA = await sha256Hex(a);
    const unknown = "f".repeat(64);
    const envelope: OrganizationEnvelope = { deviceId: "00000000-0000-4000-8000-000000000001", counter: 0, state: emptyOrganization() };
    const target: FolderTarget = { groupKey: "g", kind: "create", folderId: OTHER_FOLDER, name: "新夹" };
    const item = (contentHash: string, inputId: string) => ({
      inputId, contentHash, isExisting: false, target, observed: placementSnapshotOf(envelope.state, contentHash),
    });
    // The unknown hash makes the move throw after the folder create was planned:
    // the caller's transaction aborts and the envelope it holds is untouched.
    expect(() => applyDirectoryPlacementBatch(envelope, { policy: "fillUnclassified", items: [item(hashA, "a"), item(unknown, "x")] }, new Set([hashA])))
      .toThrow();
    expect(envelope.state.folders).toEqual({});
    const ok = applyDirectoryPlacementBatch(envelope, { policy: "fillUnclassified", items: [item(hashA, "a")] }, new Set([hashA]));
    expect(ok.result.createdFolderIds).toEqual([OTHER_FOLDER]);
    expect(effectiveFolderId(ok.envelope.state, hashA)).toBe(OTHER_FOLDER);
  });

  it("a cancel during a read accepts nothing more and opens no new placement batch", async () => {
    const [x, y] = await Promise.all([epub("X"), epub("Y")]);
    const memory = memoryStore();
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => { releaseRead = resolve; });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const slow = fakeFile("根/小说/y.epub", y);
    (slow as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => {
      readStarted();
      await reading;
      return y.slice().buffer;
    };
    const port = createWebDirectoryImportPort({
      store: memory.store,
      pickDirectory: async () => [fakeFile("根/小说/x.epub", x), slow],
      progressIntervalMs: 0,
    });
    const scan = (await port.scan(() => undefined))!;
    const page = await port.page(scan.jobId);
    const plan = planDirectoryImport(scan.root, page.items, auto);
    const targets = buildFolderTargets(plan.groups, resolveGroups(plan.groups, [], []), {}, () => OTHER_FOLDER)!;
    const running = port.start({ jobId: scan.jobId, options: auto, targets, onProgress: () => undefined });
    await started;
    expect(await port.cancel(scan.jobId)).toBe("requested");
    releaseRead();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(memory.saves).toEqual([await sha256Hex(x)]); // y was mid-read: never saved
    expect(memory.commits).toEqual([]); // no batch opened after the cancel
    expect(result.counts).toMatchObject({ completed: 1, imported: 1, placementSkipped: 1 });
    expect(memory.state().folders).toEqual({});
  });
});

function fakePort(overrides: Partial<DirectoryImportPort> = {}) {
  const calls: string[] = [];
  const port: DirectoryImportPort = {
    scan: async () => null,
    page: async () => ({ items: [], bindings: [], nextCursor: null }),
    start: async () => { throw new Error("unused"); },
    issues: async () => ({ items: [], nextCursor: null }),
    cancel: async (jobId) => { calls.push(`cancel:${jobId}`); return "requested"; },
    dispose: async (jobId) => { calls.push(`dispose:${jobId}`); },
    ...overrides,
  };
  return { port, calls };
}

const zeroCounts = { completed: 0, imported: 0, duplicates: 0, failed: 0, placementSkipped: 0, createdFolders: 0 };
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("folder import job ownership", () => {
  it("closing mid-scan cancels the job from its first event; the late result only cleans up", async () => {
    let finish!: (value: { jobId: string; root: { sourceRootKey: string; name: string }; inputCount: number; skippedDirectoryCount: number; unreadableDirectoryCount: number }) => void;
    const { port, calls } = fakePort({
      scan: (onProgress) => {
        onProgress({ jobId: "j1", phase: "scanning", scannedInputs: 0, totalInputs: null, counts: zeroCounts });
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    const owner = new FolderImportJobOwner(port);
    const token = owner.beginScan();
    const scanning = port.scan((event) => owner.adopt(token, event.jobId));
    expect(owner.currentJobId).toBe("j1");
    owner.close();
    await flushAsync();
    expect(calls).toEqual(["cancel:j1", "dispose:j1"]);
    finish({ jobId: "j1", root: { sourceRootKey: "k", name: "根" }, inputCount: 3, skippedDirectoryCount: 0, unreadableDirectoryCount: 0 });
    const result = (await scanning)!;
    expect(owner.adopt(token, result.jobId)).toBe(false);
    await flushAsync();
    expect(calls).toEqual(["cancel:j1", "dispose:j1"]); // released once, no UI update
  });

  it("a failed start after partial imports still settles once; unmount cancels and releases after it", async () => {
    let fail!: (error: Error) => void;
    const { port, calls } = fakePort({
      scan: async (onProgress) => {
        onProgress({ jobId: "j2", phase: "scanning", scannedInputs: 1, totalInputs: 1, counts: zeroCounts });
        return { jobId: "j2", root: { sourceRootKey: "k", name: "根" }, inputCount: 1, skippedDirectoryCount: 0, unreadableDirectoryCount: 0 };
      },
      start: () => new Promise((_, reject) => { fail = reject; }),
    });
    const owner = new FolderImportJobOwner(port);
    const token = owner.beginScan();
    await port.scan((event) => owner.adopt(token, event.jobId));
    const handlers = { onProgress: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onSettled: vi.fn() };
    expect(owner.run({ options: auto, targets: [] }, handlers)).toBe(true);
    owner.close(); // panel unmounted mid-import
    await flushAsync();
    expect(calls).toEqual(["cancel:j2"]); // ownership kept until the run settles
    fail(new Error("second batch failed"));
    await flushAsync();
    expect(handlers.onResult).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onSettled).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["cancel:j2", "cancel:j2", "dispose:j2"]);
  });
});


describe("native directory registration ownership", () => {
  it("closing during the picker releases only after native registration", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }
    const pick = deferred<{ kind: "path"; path: string }>();
    const invoked = deferred<void>();
    const registered = deferred<void>();
    const disposed = deferred<void>();
    let exists = false;
    let cancelled = false;
    const calls: string[] = [];
    nativeInvoke.mockReset();
    nativeInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      if (command === "directory_import_pick") return pick.promise;
      if (command === "directory_import_scan") {
        invoked.resolve();
        await registered.promise;
        exists = true;
        const jobId = args!.jobId as string;
        (args!.onProgress as { onmessage(event: DirectoryProgress): void }).onmessage({
          jobId, phase: "scanning", scannedInputs: 0, totalInputs: null,
          counts: { completed: 0, imported: 0, duplicates: 0, failed: 0, placementSkipped: 0, createdFolders: 0 },
        });
        await disposed.promise;
        return { jobId, inputCount: 0 };
      }
      if (command === "directory_import_cancel") {
        cancelled = exists;
        return { status: exists ? "requested" : "already-finished" };
      }
      if (command === "directory_import_dispose") {
        exists = false;
        disposed.resolve();
      }
    });
    const port = createNativeDirectoryImportPort();
    const owner = new FolderImportJobOwner(port);
    const token = owner.beginScan();
    const updateUI = vi.fn();
    const scan = port.scan((event) => {
      if (owner.adopt(token, event.jobId)) updateUI(event);
    });
    owner.close();
    pick.resolve({ kind: "path", path: "/anonymous" });
    await invoked.promise;
    expect(calls).toEqual(["directory_import_pick", "directory_import_scan"]);
    registered.resolve();
    const result = await scan;
    if (result) expect(owner.adopt(token, result.jobId)).toBe(false);
    expect(cancelled).toBe(true);
    expect(exists).toBe(false);
    expect(calls).toEqual([
      "directory_import_pick", "directory_import_scan", "directory_import_cancel", "directory_import_dispose",
    ]);
    expect(updateUI).not.toHaveBeenCalled();
  });
});
