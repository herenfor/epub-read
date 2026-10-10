import { fontFamilyFromFileName, type FontStore, type UserFont } from "./fontStore";
import { partitionFontItems, runFontImportBatch } from "./fontDrop";
import { uiPlural, uiText } from "./localization/UiLanguageProvider";

/** 字体导入结果：提示文案由调用方渲染，控制器本身不持有 UI 状态。 */
export type FontImportResult =
  | { kind: "ok"; imported: number; entry?: UserFont; unsupported: number; message?: string }
  | { kind: "busy" }
  | { kind: "error"; imported: number; message: string };

export interface FontImportController {
  /** 本地文件入口：逐文件哈希并写入当前适配器。 */
  importFiles(files: readonly File[]): Promise<FontImportResult>;
  /** 原生路径入口：一次 `fonts_import_paths` 调用导入整批，不重入 busy。 */
  importPaths(paths: readonly string[]): Promise<FontImportResult>;
}

export interface FontImportControllerOptions {
  store: () => FontStore;
  /** 单文件落库（哈希、写 store、更新选中字体），由调用方注入以免重复实现。 */
  importFile: (file: File) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}

export function createFontImportController(options: FontImportControllerOptions): FontImportController {
  // 单一在途批次标记：嵌套调用只会得到 busy，不会绕过外层锁再次提交同一批 drop。
  let busy = false;

  const runBatch = async <T>(
    items: readonly T[],
    nameOf: (item: T) => string,
    importOne: (item: T) => Promise<void>,
    describe: (supported: readonly T[], imported: number) => string | undefined,
  ): Promise<FontImportResult> => {
    if (busy) return { kind: "busy" };
    if (items.length === 0) return { kind: "ok", imported: 0, unsupported: 0 };
    busy = true;
    options.onBusyChange(true);
    const { supported, unsupported } = partitionFontItems(items, nameOf);
    let imported = 0;
    try {
      await runFontImportBatch(supported, importOne);
      imported = supported.length;
    } catch (error) {
      return { kind: "error", imported, message: uiText("notice.font.failed", { error: String(error) }) };
    } finally {
      busy = false;
      options.onBusyChange(false);
    }
    return { kind: "ok", imported, unsupported: unsupported.length, message: describe(supported, imported) };
  };

  const importFiles = (files: readonly File[]): Promise<FontImportResult> =>
    runBatch(
      files,
      (file) => file.name,
      async (file) => { await options.importFile(file); },
      (supported, imported) => {
        if (imported === 0) return undefined;
        if (imported === 1 && supported.length === 1) return uiText("notice.font.importedOne", { family: fontFamilyFromFileName(supported[0].name) });
        return uiPlural("notice.font.imported", imported, { count: imported });
      },
    );

  const importPaths = async (paths: readonly string[]): Promise<FontImportResult> => {
    if (busy) return { kind: "busy" };
    if (paths.length === 0) return { kind: "ok", imported: 0, unsupported: 0 };
    const { supported, unsupported } = partitionFontItems(paths, (path) => path);
    if (supported.length === 0) {
      return {
        kind: "ok",
        imported: 0,
        unsupported: unsupported.length,
        message: uiText("notice.font.ignoredOnly", { ignored: unsupported.length }),
      };
    }
    const store = options.store();
    if (!store.importFontPaths) {
      return { kind: "error", imported: 0, message: uiText("notice.font.nativeUnsupported") };
    }
    busy = true;
    options.onBusyChange(true);
    try {
      const entries = await store.importFontPaths(supported);
      if (entries.length === 0) {
        return { kind: "error", imported: 0, message: uiText("notice.font.noneSupported") };
      }
      return {
        kind: "ok",
        imported: entries.length,
        entry: entries[0],
        unsupported: unsupported.length,
        message: entries.length === 1 ? uiText("notice.font.importedOne", { family: entries[0].family }) : uiPlural("notice.font.imported", entries.length, { count: entries.length }),
      };
    } catch (error) {
      return { kind: "error", imported: 0, message: uiText("notice.font.failed", { error: String(error) }) };
    } finally {
      busy = false;
      options.onBusyChange(false);
    }
  };

  return { importFiles, importPaths };
}
