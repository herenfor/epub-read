import type { AndroidImportPhase } from "../platform/androidNativeBridge";
import "./nativeImportPanel.css";

export type NativeImportCancelState = "idle" | "requesting" | "too_late";

export interface NativeImportPanelProps {
  phase: "starting" | AndroidImportPhase;
  completed: number;
  total: number;
  fileNameSummary: string;
  cancelState: NativeImportCancelState;
  collapsed: boolean;
  onToggleCollapsed(): void;
  onCancel(): void;
}

function phaseText(phase: NativeImportPanelProps["phase"], completed: number, total: number): string {
  if (phase === "starting") return "正在开始导入…";
  if (phase === "committing") return "正在保存到书库…";
  return total > 0 ? `已处理 ${completed}/${total}` : "正在准备…";
}

export function NativeImportPanel(props: NativeImportPanelProps) {
  const status = phaseText(props.phase, props.completed, props.total);
  const cancelDisabled = props.phase !== "preparing" || props.cancelState !== "idle";

  if (props.collapsed) {
    return (
      <button
        type="button"
        className="native-import-pill"
        onClick={props.onToggleCollapsed}
        aria-label={`展开导入进度：${status}`}
        aria-expanded={false}
      >
        <span className="native-import-pill-dot" aria-hidden="true" />
        <span>{status}</span>
      </button>
    );
  }

  return (
    <section className="native-import-panel" role="status" aria-live="polite" aria-label="导入进度">
      <div className="native-import-head">
        <div className="native-import-title">
          <span>正在导入</span>
          {props.fileNameSummary && <span className="native-import-file">{props.fileNameSummary}</span>}
        </div>
        <button
          type="button"
          className="native-import-collapse"
          onClick={props.onToggleCollapsed}
          aria-label="收起导入进度"
          aria-expanded
        >
          −
        </button>
      </div>
      <div className="native-import-body">
        <span>{status}</span>
        {props.cancelState === "requesting" && <span className="native-import-cancel-state">已请求取消，等待任务结束…</span>}
        {props.cancelState === "too_late" && <span className="native-import-cancel-state">提交已开始，继续等待结果…</span>}
      </div>
      <div className="native-import-actions">
        <button
          type="button"
          className="native-import-cancel"
          onClick={props.onCancel}
          disabled={cancelDisabled}
        >
          {props.cancelState === "idle" ? "取消" : "取消中…"}
        </button>
      </div>
    </section>
  );
}
