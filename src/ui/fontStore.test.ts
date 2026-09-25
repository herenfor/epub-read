import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { fontFamilyFromFileName, fontIdFromHash, getFontStore, resetFontStoreForTest } from "./fontStore";

const tauriWindow = globalThis as { window?: unknown };
let originalWindow: unknown;

afterEach(() => {
  if (originalWindow === undefined) delete tauriWindow.window;
  else tauriWindow.window = originalWindow;
  invokeMock.mockClear();
  resetFontStoreForTest();
});

function installTauriWindow(): void {
  originalWindow = tauriWindow.window;
  tauriWindow.window = { __TAURI_INTERNALS__: {} };
}

describe("fontStore helpers", () => {
  it("fontFamilyFromFileName 去除扩展名并压缩连续空白", () => {
    expect(fontFamilyFromFileName("My Font.ttf")).toBe("My Font");
    expect(fontFamilyFromFileName("NotoSansSC-Bold.otf")).toBe("NotoSansSC-Bold");
    expect(fontFamilyFromFileName("  two   spaces .woff2 ")).toBe("two spaces");
    expect(fontFamilyFromFileName("noext")).toBe("noext");
  });

  it("fontIdFromHash 小写化", () => {
    expect(fontIdFromHash("ABCDEF")).toBe("abcdef");
  });
});

describe("font store adapters", () => {
  it("Tauri adapter routes native font paths through fonts_import_paths once", async () => {
    installTauriWindow();
    const store = getFontStore();
    await store.importFontPaths?.(["C:\\fonts\\A.ttf", "C:\\fonts\\B.woff2"]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("fonts_import_paths", { paths: ["C:\\fonts\\A.ttf", "C:\\fonts\\B.woff2"] });
  });

  it("browser adapter does not expose the native path API", () => {
    const store = getFontStore();
    expect(store.importFontPaths).toBeUndefined();
  });
});
