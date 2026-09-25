import { describe, expect, it, vi } from "vitest";
import type { FontStore, UserFont } from "./fontStore";
import { createFontImportController } from "./fontImport";

function userFont(id: string): UserFont {
  return { id, fileName: `${id}.ttf`, family: id, size: 10, addedAtMs: 1 };
}

function storeWith(overrides: Partial<FontStore> = {}): FontStore {
  return {
    list: vi.fn(async () => []),
    importFont: vi.fn(async (input) => ({ id: input.id, fileName: input.fileName, family: input.family, size: 1, addedAtMs: 1 })),
    readFont: vi.fn(async () => new Uint8Array()),
    deleteFont: vi.fn(async () => undefined),
    ...overrides,
  };
}

function controllerFor(store: FontStore, importFile = vi.fn(async () => undefined)) {
  const busy: boolean[] = [];
  const controller = createFontImportController({ store: () => store, importFile, onBusyChange: (value) => busy.push(value) });
  return { controller, importFile, busy };
}

describe("font import controller", () => {
  it("imports supported files through the adapter and reports the count", async () => {
    const store = storeWith();
    const importFile = vi.fn(async () => undefined);
    const { controller, busy } = controllerFor(store, importFile);
    const result = await controller.importFiles([
      { name: "A.ttf" } as File,
      { name: "B.otf" } as File,
      { name: "notes.txt" } as File,
    ]);
    expect(result).toMatchObject({ kind: "ok", imported: 2, unsupported: 1 });
    expect(importFile).toHaveBeenCalledTimes(2);
    expect(busy).toEqual([true, false]);
  });

  it("calls fonts_import_paths once for a whole native drop", async () => {
    const importFontPaths = vi.fn(async (paths: string[]) => paths.map((path) => userFont(path)));
    const { controller } = controllerFor(storeWith({ importFontPaths }));
    const result = await controller.importPaths(["C:\\fonts\\A.ttf", "C:\\fonts\\B.woff2", "C:\\fonts\\cover.epub"]);
    expect(importFontPaths).toHaveBeenCalledTimes(1);
    expect(importFontPaths).toHaveBeenCalledWith(["C:\\fonts\\A.ttf", "C:\\fonts\\B.woff2"]);
    expect(result).toMatchObject({ kind: "ok", imported: 2, unsupported: 1 });
  });

  it("uses exactly one busy cycle for a native path batch", async () => {
    const importFontPaths = vi.fn(async (paths: string[]) => paths.map((path) => userFont(path)));
    const { controller, busy } = controllerFor(storeWith({ importFontPaths }));
    await controller.importPaths(["a.ttf", "b.ttf"]);
    expect(busy).toEqual([true, false]);
  });

  it("does not let a second drop bypass the in-flight native batch", async () => {
    let release: (entries: UserFont[]) => void = () => undefined;
    const pending = new Promise<UserFont[]>((resolve) => { release = resolve; });
    const importFontPaths = vi.fn(() => pending);
    const { controller, busy } = controllerFor(storeWith({ importFontPaths }));
    const first = controller.importPaths(["a.ttf"]);
    expect(busy).toEqual([true]);
    expect(await controller.importPaths(["b.ttf"])).toEqual({ kind: "busy" });
    expect(importFontPaths).toHaveBeenCalledTimes(1);
    release([userFont("a")]);
    await expect(first).resolves.toMatchObject({ kind: "ok", imported: 1 });
    expect(busy).toEqual([true, false]);
  });

  it("reports unsupported-only native drops instead of failing silently", async () => {
    const importFontPaths = vi.fn(async () => [userFont("a")]);
    const { controller, busy } = controllerFor(storeWith({ importFontPaths }));
    const result = await controller.importPaths(["C:\\fonts\\A.ttc"]);
    expect(result).toMatchObject({ kind: "ok", imported: 0, unsupported: 1 });
    expect(result.kind === "ok" && result.message).toContain("仅支持");
    expect(importFontPaths).not.toHaveBeenCalled();
    expect(busy).toEqual([]);
  });

  it("reports an empty native result and unlocks for the next import", async () => {
    const emptyStore = storeWith({ importFontPaths: vi.fn(async () => [] as UserFont[]) });
    const { controller, busy } = controllerFor(emptyStore);
    const result = await controller.importPaths(["a.ttf"]);
    expect(result).toMatchObject({ kind: "error" });
    expect(busy).toEqual([true, false]);
    const nextStore = storeWith({ importFontPaths: async (paths) => paths.map((path) => userFont(path)) });
    const next = controllerFor(nextStore);
    await expect(next.controller.importPaths(["b.ttf"])).resolves.toMatchObject({ kind: "ok", imported: 1 });
  });

  it("surfaces adapter failures and still releases busy", async () => {
    const importFontPaths = vi.fn(async () => { throw new Error("native boom"); });
    const { controller, busy } = controllerFor(storeWith({ importFontPaths }));
    const result = await controller.importPaths(["a.ttf"]);
    expect(result).toMatchObject({ kind: "error" });
    expect(result.kind === "error" && result.message).toContain("native boom");
    expect(busy).toEqual([true, false]);
  });

  it("refuses native paths when the active adapter has no path API", async () => {
    const { controller, busy } = controllerFor(storeWith());
    const result = await controller.importPaths(["a.ttf"]);
    expect(result).toMatchObject({ kind: "error" });
    expect(busy).toEqual([]);
  });
});
