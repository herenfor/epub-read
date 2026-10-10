import { CloseIcon } from "./readerIcons";
import { useUiText } from "./localization/UiLanguageProvider";

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
  const { t, tn } = useUiText();
  return (
    <>
      <div className="log-backdrop" onClick={props.onClose} aria-hidden="true" />
      <div className="log-panel" role="dialog" aria-modal="true" aria-label={t("log.title")}>
        <div className="drawer-drag-handle" aria-hidden="true" />
        <div className="log-head">
          <div className="drawer-title-wrap">
            <span>{t("log.title")}</span>
            <span className={`log-badge${props.items.length > 0 ? " has-issues" : ""}`}>
              {props.items.length > 0 ? tn("log.issues", props.items.length, { count: props.items.length }) : t("log.ok")}
            </span>
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
