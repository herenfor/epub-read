import { useState } from "react";
import type {
  SaveFilePrepareResult,
  SaveFileProgress,
} from "../platform/saveFileNativeBridge";
import type { SaveFileJobState } from "./useSaveFileJob";
import "./saveFileDialogs.css";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "preparing": return "正在准备";
    case "reading": return "正在读取资料";
    case "extracting": return "正在解析存档";
    case "writing": return "正在写入";
    case "finalizing": return "正在收尾";
    case "copying": return "正在写入目标";
    case "committing": return "正在提交到书库";
    default: return phase || "进行中";
  }
}

function progressText(progress: SaveFileProgress): string {
  const label = phaseLabel(progress.phase);
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    const pct = Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100));
    return `${label} ${pct}% · ${formatBytes(progress.processedBytes)} / ${formatBytes(progress.totalBytes)}`;
  }
  if (progress.processedBytes > 0) return `${label} · 已处理 ${formatBytes(progress.processedBytes)}`;
  return `${label}…`;
}

export interface SaveFileExportDialogProps {
  selectedCount: number;
  onCancel(): void;
  onConfirm(scope: "all" | "selected", includeBooks: boolean): void;
}

export function SaveFileExportDialog(props: SaveFileExportDialogProps) {
  const [scope, setScope] = useState<"all" | "selected">(props.selectedCount > 0 ? "selected" : "all");
  const [includeBooks, setIncludeBooks] = useState(false);
  return (
    <div className="save-file-backdrop" role="presentation">
      <section className="save-file-dialog" role="dialog" aria-modal="true" aria-label="导出存档">
        <header className="save-file-dialog-head">
          <h2>导出存档</h2>
          <p>新格式为 .epubsave，包含可移植资料与所选书籍文件。</p>
        </header>
        <div className="save-file-dialog-body">
          <fieldset className="save-file-fieldset">
            <legend>导出范围</legend>
            <label className="save-file-radio">
              <input
                type="radio"
                name="save-file-export-scope"
                checked={scope === "all"}
                onChange={() => setScope("all")}
              />
              <span>全库</span>
            </label>
            <label className={`save-file-radio${props.selectedCount === 0 ? " disabled" : ""}`}>
              <input
                type="radio"
                name="save-file-export-scope"
                disabled={props.selectedCount === 0}
                checked={scope === "selected"}
                onChange={() => setScope("selected")}
              />
              <span>当前选中的书{props.selectedCount > 0 ? `（${props.selectedCount} 本）` : "（无选中）"}</span>
            </label>
          </fieldset>
          <p className="save-file-muted">
            阅读资料包含进度、书签、笔记、收藏及文件夹；全库包含空文件夹，选中的书只带相关文件夹。附带书籍文件与资料范围是两个独立选择。
          </p>
          <label className="save-file-check">
            <input
              type="checkbox"
              checked={includeBooks}
              onChange={(event) => setIncludeBooks(event.target.checked)}
            />
            <span>附带书籍文件（默认关；开启后可在另一设备直接阅读）</span>
          </label>
        </div>
        <footer className="save-file-dialog-actions">
          <button type="button" onClick={props.onCancel}>取消</button>
          <button
            type="button"
            className="primary"
            disabled={scope === "selected" && props.selectedCount === 0}
            onClick={() => props.onConfirm(scope, includeBooks)}
          >
            选择保存位置并导出
          </button>
        </footer>
      </section>
    </div>
  );
}

export interface SaveFileImportPreviewProps {
  preview: SaveFilePrepareResult;
  sourceLabel: string;
  canceling: boolean;
  onCancel(): void;
  onConfirm(applyPreferences: boolean): void;
}

export function SaveFileImportPreview(props: SaveFileImportPreviewProps) {
  const [applyPreferences, setApplyPreferences] = useState(false);
  const visibleMissing = props.preview.missingBooks.slice(0, 3);
  return (
    <div className="save-file-backdrop" role="presentation">
      <section className="save-file-dialog save-file-import-preview" role="dialog" aria-modal="true" aria-label="导入存档预览">
        <header className="save-file-dialog-head">
          <h2>导入存档预览</h2>
          <p>{props.sourceLabel || "已选择存档"}；预览不会写入书库。</p>
        </header>
        <div className="save-file-dialog-body">
          <dl className="save-file-summary">
            <div><dt>存档资料书数</dt><dd>{props.preview.bookCount}</dd></div>
            <div><dt>新资料数</dt><dd>{props.preview.newBookCount}</dd></div>
            <div><dt>实际附带书籍</dt><dd>{props.preview.attachedBooks.length}</dd></div>
            <div><dt>待补书籍</dt><dd>{props.preview.missingBooks.length}</dd></div>
            <div><dt>进度分歧</dt><dd>{props.preview.progressConflictCount}</dd></div>
          </dl>
          {visibleMissing.length > 0 && (
            <p className="save-file-muted">
              待补：{visibleMissing.map((book) => book.title || book.contentHash.slice(0, 8)).join("、")}
              {props.preview.missingBooks.length > visibleMissing.length ? ` 等 ${props.preview.missingBooks.length} 本` : ""}
            </p>
          )}
          {props.preview.hasPreferences && (
            <label className="save-file-check">
              <input
                type="checkbox"
                checked={applyPreferences}
                onChange={(event) => setApplyPreferences(event.target.checked)}
              />
              <span>采用存档中的外观设置（只应用主题、字号、行距等白名单字段）</span>
            </label>
          )}
          <p className="save-file-muted">
            确认后会把资料并入当前书库；未附带文件的书保留原进度/笔记并显示为待补充书籍。
          </p>
        </div>
        <footer className="save-file-dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={props.canceling}>
            {props.canceling ? "正在取消…" : "取消"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={props.canceling}
            onClick={() => props.onConfirm(props.preview.hasPreferences && applyPreferences)}
          >
            确认导入
          </button>
        </footer>
      </section>
    </div>
  );
}

export interface SaveFileProgressPanelProps {
  state: SaveFileJobState;
  onCancel(): void;
}

export function SaveFileProgressPanel(props: SaveFileProgressPanelProps) {
  const { state } = props;
  if (state.kind === "idle" || state.kind === "prepared") return null;
  let title = "正在导出存档";
  let cancellable = true;
  let cancelText = "取消";
  let cancelDisabled = false;
  if (state.kind === "preparing") {
    title = "正在读取存档";
    cancelText = state.canceling ? "取消中…" : "取消";
    cancelDisabled = state.canceling || state.cancelTooLate;
  } else if (state.kind === "committing") {
    title = "正在提交到书库";
    cancelText = "提交中不可取消";
    cancellable = false;
    cancelDisabled = true;
  } else if (state.kind === "exporting") {
    cancelText = state.canceling ? "取消中…" : "取消";
    cancelDisabled = state.canceling || state.cancelTooLate;
  }
  const tooLate = state.kind !== "committing" && state.cancelTooLate;
  return (
    <section className="save-file-progress" role="status" aria-live="polite" aria-label={title}>
      <div className="save-file-progress-title">{title}</div>
      <div className="save-file-progress-text">{progressText(state.progress)}</div>
      {tooLate && <div className="save-file-progress-note">已进入不可回退阶段，等待真实结果。</div>}
      {state.kind === "committing" && <div className="save-file-progress-note">提交已开始，关闭窗口也不会回滚。</div>}
      {cancellable && (
        <button type="button" onClick={props.onCancel} disabled={cancelDisabled}>
          {cancelText}
        </button>
      )}
    </section>
  );
}
