import { CloseIcon } from "./readerIcons";
import { useUiText } from "./localization/UiLanguageProvider";

export interface LogItem {
  kind: string;
  source: string;
  message: string;
  resolved?: boolean;
}

export interface LogPanelProps {
  items: LogItem[];
  /** 渲染诊断文本（可选） */
  diagText?: string | null;
  onRefresh?(): void;
  onClose(): void;
}

export function LogPanel(props: LogPanelProps) {
  const { t, tn } = useUiText();
  const issueCount = props.items.filter((item) => !item.resolved).length;
  return (
    <>
      <div className="log-backdrop" onClick={props.onClose} aria-hidden="true" />
      <div className="log-panel" role="dialog" aria-modal="true" aria-label={t("log.title")}>
        <div className="drawer-drag-handle" aria-hidden="true" />
        <div className="log-head">
          <div className="drawer-title-wrap">
            <span>{t("log.title")}</span>
            <span className={`log-badge${issueCount > 0 ? " has-issues" : ""}`}>
              {issueCount > 0 ? tn("log.issues", issueCount, { count: issueCount }) : t("log.ok")}
            </span>
            {props.onRefresh && <button type="button" className="tb-btn" onClick={props.onRefresh}>{t("log.refresh")}</button>}
          </div>
          <button className="tb-btn tb-close" onClick={props.onClose} aria-label={t("log.close")} title={t("common.close")}>
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="log-body">
          <div className="log-section-title">{t("log.records")}</div>
          {props.items.length === 0 ? (
            <div className="log-empty">{t("log.empty")}</div>
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
          <div className="log-section-title">{t("log.diagnostics")}</div>
          <pre className="log-diag-pre">
            {props.diagText ?? t("log.diagnostics.pending")}
          </pre>
        </div>
      </div>
    </>
  );
}
