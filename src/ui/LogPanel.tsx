import { CloseIcon } from "./readerIcons";

export interface LogItem {
  kind: string;
  source: string;
  message: string;
}

export interface LogPanelProps {
  items: LogItem[];
  /** 渲染诊断文本（可选） */
  diagText?: string | null;
  onClose(): void;
}

export function LogPanel(props: LogPanelProps) {
  return (
    <>
      <div className="log-backdrop" onClick={props.onClose} aria-hidden="true" />
      <div className="log-panel" role="dialog" aria-modal="true" aria-label="日志与诊断">
        <div className="drawer-drag-handle" aria-hidden="true" />
        <div className="log-head">
          <div className="drawer-title-wrap">
            <span>日志与诊断</span>
            <span className={`log-badge${props.items.length > 0 ? " has-issues" : ""}`}>
              {props.items.length > 0 ? `${props.items.length} 个问题` : "正常"}
            </span>
          </div>
          <button className="tb-btn tb-close" onClick={props.onClose} aria-label="关闭日志与诊断" title="关闭">
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="log-body">
          <div className="log-section-title">问题记录</div>
          {props.items.length === 0 ? (
            <div className="log-empty">没有记录到异常问题。</div>
          ) : (
            <div className="log-list">
              {props.items.map((item, i) => (
                <div key={i} className={`log-item ${item.kind === "book_error" ? "error" : ""}`}>
                  <span className="src">[{item.source}]</span>
                  <span className="msg">{item.message}</span>
                </div>
              ))}
            </div>
          )}
          <div className="log-section-title">渲染状态诊断</div>
          <pre className="log-diag-pre">
            {props.diagText ?? "（打开面板时自动采集）"}
          </pre>
        </div>
      </div>
    </>
  );
}
