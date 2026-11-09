import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { CloudBookUploadItem, CloudBookUploadPreviewBook, CloudBookUploadResult } from "../../platform/cloudBookUploadNative";
import { useUiText } from "../localization/UiLanguageProvider";
import { useScrollEdgeFade } from "../scrollEdgeFade";
import { cloudSyncFailureText } from "./CloudSyncPanel";
import {
  cancelCloudBookUpload,
  cloudBookUploadCanStart,
  cloudBookUploadOtherTarget,
  closeCloudBookUpload,
  collapseCloudBookUpload,
  confirmCloudBookUpload,
  expandCloudBookUpload,
  failedHashes,
  readyHashes,
  recoverCloudBookUpload,
  refreshDetached,
  rereadCloudBookUpload,
  retryFailedCloudBookUpload,
  useCloudBookUpload,
  type CloudBookUploadPanel as PanelState,
} from "./cloudBookUploadStore";
import { formatUploadBytes, uploadFailureText, uploadPhaseText, uploadReasonText, uploadResultTitle } from "./cloudBookUploadText";
import { refreshCloudSyncStatus, useCloudSync } from "./cloudSyncStore";
import "./cloudBookUpload.css";

/** Rows drawn at once; a ten-thousand-book batch ends with "N more". */
export const UPLOAD_LIST_LIMIT = 200;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Bar({ value, total }: { value: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  return <div className="cloud-upload-bar" role="presentation"><span style={{ width: `${(ratio * 100).toFixed(1)}%` }} /></div>;
}

function Spinner() {
  return <span className="cloud-upload-spinner" aria-hidden="true" />;
}

/** A book list that scrolls inside the panel with the app's edge fade instead of a scrollbar. */
function BookList({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  useScrollEdgeFade(ref as RefObject<HTMLElement>);
  return <ul ref={ref} className="cloud-upload-list scrollbar-hidden">{children}</ul>;
}

function MoreRow({ count }: { count: number }) {
  const { tn } = useUiText();
  if (count <= 0) return null;
  return <li className="cloud-upload-more">{tn("cloudSync.upload.more", count, { count })}</li>;
}

function PreviewRow({ book }: { book: CloudBookUploadPreviewBook }) {
  const { t } = useUiText();
  const name = book.title || book.fileName || book.contentHash.slice(0, 12);
  return <li className={book.ready ? "" : "is-off"}>
    <span className="cloud-upload-name">{book.ready ? name : `${name}（${uploadReasonText(t, book.code)}）`}</span>
    <span className="cloud-upload-meta">{book.ready ? formatUploadBytes(book.bytes) : t("cloudSync.upload.notReady")}</span>
  </li>;
}

function ResultRow({ book }: { book: CloudBookUploadItem }) {
  const { t } = useUiText();
  return <li className={book.outcome === "failed" ? "is-bad" : ""}>
    <span className="cloud-upload-name">{book.title || book.contentHash.slice(0, 12)}</span>
    <span className="cloud-upload-meta">{book.outcome === "cancelled" ? t("cloudSync.upload.reason.cancelled") : uploadReasonText(t, book.code)}</span>
  </li>;
}

function Confirm({ panel, onOpenSync }: { panel: Extract<PanelState, { kind: "confirm" }>; onOpenSync(): void }) {
  const { t, tn } = useUiText();
  const { status } = useCloudSync();
  const upload = useCloudBookUpload();
  const connection = status?.connection ?? null;
  const preview = panel.preview;
  const ready = preview ? readyHashes(preview).length : 0;
  // Ready books first, then the ones that cannot go, each in shelf order.
  const books = preview ? [...preview.books.filter((book) => book.ready), ...preview.books.filter((book) => !book.ready)] : [];

  if (status && !connection) {
    return <>
      <p className="cloud-upload-text">{t("cloudSync.upload.notConnected")}</p>
      <div className="cloud-upload-actions">
        <button type="button" className="ui-btn" onClick={closeCloudBookUpload}>{t("cloudSync.upload.cancel")}</button>
        <button type="button" className="ui-btn is-primary" onClick={() => { closeCloudBookUpload(); onOpenSync(); }}>{t("cloudSync.upload.connect")}</button>
      </div>
    </>;
  }
  return <>
    {panel.failure && <p className="cloud-upload-error" role="alert">{uploadFailureText(t, panel.failure, (failure) => cloudSyncFailureText(t, failure))}</p>}
    {!preview && !panel.failure && <p className="cloud-upload-text is-muted"><Spinner />{t("cloudSync.upload.loading")}</p>}
    {preview && <>
      <div className="cloud-upload-card">
        <div className="cloud-upload-kv">
          <span>{t("cloudSync.upload.willUpload")}</span>
          <b>{tn("cloudSync.upload.summary", ready, { count: ready, size: formatUploadBytes(preview.totalBytes) })}</b>
        </div>
        {connection && <div className="cloud-upload-kv">
          <span>{t("cloudSync.upload.target")}</span>
          <span className="cloud-upload-target">{`${hostOf(connection.baseUrl)} · ${connection.remoteRoot}`}</span>
        </div>}
      </div>
      <BookList>
        {books.slice(0, UPLOAD_LIST_LIMIT).map((book) => <PreviewRow key={book.contentHash} book={book} />)}
        <MoreRow count={books.length - UPLOAD_LIST_LIMIT} />
      </BookList>
      {ready === 0 && <p className="cloud-upload-text is-muted">{t("cloudSync.upload.noneReady")}</p>}
      {panel.targetChanged && <p className="cloud-upload-error" role="alert">{t("cloudSync.upload.targetChanged")}</p>}
    </>}
    {upload.current === "reading" && <p className="cloud-upload-text is-muted"><Spinner />{t("cloudSync.upload.current.reading")}</p>}
    {upload.current === "unknown" && <p className="cloud-upload-error" role="alert">{t("cloudSync.upload.current.unknown")}</p>}
    <div className="cloud-upload-actions">
      <button type="button" className="ui-btn" onClick={closeCloudBookUpload}>{t("cloudSync.upload.cancel")}</button>
      {upload.current === "unknown" && <button type="button" className="ui-btn" onClick={() => void rereadCloudBookUpload()}>
        {t("cloudSync.upload.current.reread")}
      </button>}
      <button type="button" className="ui-btn is-primary" disabled={!preview || ready === 0 || !connection || !cloudBookUploadCanStart(upload)}
        onClick={confirmCloudBookUpload}>
        {t("cloudSync.upload.start")}
      </button>
    </div>
  </>;
}

function Running({ panel }: { panel: Extract<PanelState, { kind: "running" }> }) {
  const { t } = useUiText();
  const progress = panel.progress;
  const name = progress ? panel.titles.get(progress.contentHash) ?? "" : "";
  return <>
    <div className="cloud-upload-card">
      <div className="cloud-upload-kv">
        <span className="cloud-upload-name">{name}</span>
        <span className="cloud-upload-phase"><Spinner />{uploadPhaseText(t, progress?.phase ?? null)}</span>
      </div>
      <Bar value={progress?.bookSent ?? 0} total={progress?.bookTotal ?? 0} />
      <div className="cloud-upload-kv is-small">
        <span>{t("cloudSync.upload.thisBook")}</span>
        <span className="cloud-upload-num">{`${formatUploadBytes(progress?.bookSent ?? 0)} / ${formatUploadBytes(progress?.bookTotal ?? 0)}`}</span>
      </div>
    </div>
    <div className="cloud-upload-card">
      <div className="cloud-upload-kv is-small">
        <span>{t("cloudSync.upload.batch")}</span>
        <span className="cloud-upload-num">{`${formatUploadBytes(progress?.batchSent ?? 0)} / ${formatUploadBytes(progress?.batchTotal ?? 0)}`}</span>
      </div>
      <Bar value={progress?.batchSent ?? 0} total={progress?.batchTotal ?? 0} />
    </div>
    <p className="cloud-upload-text is-muted">{panel.canceling ? t("cloudSync.upload.cancelingNote") : t("cloudSync.upload.foreground")}</p>
    <div className="cloud-upload-actions">
      <button type="button" className="ui-btn" onClick={collapseCloudBookUpload}>{t("cloudSync.upload.collapse")}</button>
      <button type="button" className="ui-btn" disabled={panel.canceling} onClick={cancelCloudBookUpload}>
        {panel.canceling ? t("cloudSync.upload.canceling") : t("cloudSync.upload.stop")}
      </button>
    </div>
  </>;
}

function Detached({ panel }: { panel: Extract<PanelState, { kind: "detached" }> }) {
  const { t } = useUiText();
  return <>
    <p className="cloud-upload-text">{panel.ended ? t("cloudSync.upload.detachedEnded") : t("cloudSync.upload.detached")}</p>
    {!panel.ended && panel.progress && <Bar value={panel.progress.batchSent} total={panel.progress.batchTotal} />}
    <div className="cloud-upload-actions">
      {panel.ended
        ? <button type="button" className="ui-btn is-primary" onClick={closeCloudBookUpload}>{t("cloudSync.upload.done")}</button>
        : <>
          <button type="button" className="ui-btn" onClick={() => void refreshDetached()}>{t("cloudSync.upload.refresh")}</button>
          <button type="button" className="ui-btn" disabled={panel.canceling} onClick={cancelCloudBookUpload}>
            {panel.canceling ? t("cloudSync.upload.canceling") : t("cloudSync.upload.stop")}
          </button>
        </>}
    </div>
  </>;
}

const COUNTS = [
  ["uploaded", "cloudSync.upload.count.uploaded", "is-ok"],
  ["alreadyPresent", "cloudSync.upload.count.alreadyPresent", ""],
  ["failed", "cloudSync.upload.count.failed", "is-bad"],
  ["cancelled", "cloudSync.upload.count.cancelled", ""],
  ["notAttempted", "cloudSync.upload.count.notAttempted", ""],
] as const;

function Result({ result }: { result: CloudBookUploadResult }) {
  const { t, tn } = useUiText();
  const missed = result.books.filter((book) => book.outcome === "failed" || book.outcome === "cancelled" || book.outcome === "not-attempted");
  // Not-started books are counted, not listed, once a whole batch stopped.
  const listed = result.status === "stopped" || result.status === "cancelled"
    ? missed.filter((book) => book.outcome === "failed")
    : missed;
  const retry = result.status === "partial" || result.status === "completed" ? failedHashes(result).length : 0;
  // Subscribed so the note follows a connection change while the panel is open.
  useCloudSync();
  const otherTarget = cloudBookUploadOtherTarget(result);
  return <>
    <div className="cloud-upload-counts">
      {COUNTS.filter(([field]) => result[field] > 0).map(([field, label, tone]) => <div key={field} className={`cloud-upload-count ${tone}`}>
        <b>{result[field]}</b><span>{t(label)}</span>
      </div>)}
    </div>
    {listed.length > 0 && <BookList>
      {listed.slice(0, UPLOAD_LIST_LIMIT).map((book) => <ResultRow key={book.contentHash} book={book} />)}
      <MoreRow count={listed.length - UPLOAD_LIST_LIMIT} />
    </BookList>}
    {result.status === "stopped" && result.notAttempted > 0 &&
      <p className="cloud-upload-error">{tn("cloudSync.upload.notAttemptedLine", result.notAttempted, { count: result.notAttempted })}</p>}
    {(result.status === "stopped" || result.status === "cancelled") && result.uploaded > 0 &&
      <p className="cloud-upload-text is-muted">{tn("cloudSync.upload.keptLine", result.uploaded, { count: result.uploaded })}</p>}
    {result.cleanupPending && <p className="cloud-upload-text is-muted">{t("cloudSync.upload.cleanupPending")}</p>}
    {otherTarget && <p className="cloud-upload-text is-muted">{t("cloudSync.upload.otherTarget")}</p>}
    <div className="cloud-upload-actions">
      {retry > 0 && <button type="button" className="ui-btn" onClick={retryFailedCloudBookUpload}>{tn("cloudSync.upload.retry", retry, { count: retry })}</button>}
      <button type="button" className="ui-btn is-primary" onClick={closeCloudBookUpload}>{t("cloudSync.upload.done")}</button>
    </div>
  </>;
}

function panelTitle(ui: ReturnType<typeof useUiText>, panel: PanelState): string {
  const { t } = ui;
  switch (panel.kind) {
    case "running": {
      if (panel.canceling) return t("cloudSync.upload.canceling");
      const done = panel.progress ? Math.min(panel.progress.index + 1, panel.count) : 1;
      return t("cloudSync.upload.running", { done, count: panel.count });
    }
    case "result": return uploadResultTitle(ui, panel.result);
    case "detached": return t("cloudSync.upload.row.detached");
    default: return t("cloudSync.upload.title");
  }
}

/** The collapsed card: running progress, or a finished batch waiting to be seen. */
function FloatCard() {
  const ui = useUiText();
  const { t } = ui;
  const { panel } = useCloudBookUpload();
  const progress = panel.kind === "running" || panel.kind === "detached" ? panel.progress : null;
  const live = panel.kind === "running" || (panel.kind === "detached" && !panel.ended);
  const canceling = (panel.kind === "running" || panel.kind === "detached") && panel.canceling;
  return <section className="cloud-upload-float" role="status" aria-live="polite">
    <div className="cloud-upload-kv">
      <span className="cloud-upload-name">{panelTitle(ui, panel)}</span>
      {live && <span className="cloud-upload-phase"><Spinner />{uploadPhaseText(t, progress?.phase ?? null)}</span>}
    </div>
    {live && <Bar value={progress?.batchSent ?? 0} total={progress?.batchTotal ?? 0} />}
    <div className="cloud-upload-actions">
      {live
        ? <button type="button" className="ui-btn" disabled={canceling} onClick={cancelCloudBookUpload}>
          {t("cloudSync.upload.cancel")}
        </button>
        : <button type="button" className="ui-btn" onClick={closeCloudBookUpload}>{t("cloudSync.upload.close")}</button>}
      <button type="button" className="ui-btn" onClick={expandCloudBookUpload}>{t("cloudSync.upload.view")}</button>
    </div>
  </section>;
}

/**
 * ER-0151 upload layer, mounted once on the shelf: the confirm / progress /
 * result panel (centered dialog on desktop, bottom sheet on phones) and its
 * collapsed card. `onOpenSync` opens Settings → Sync for a missing connection.
 */
export function CloudBookUploadLayer({ onOpenSync }: { onOpenSync(): void }) {
  const ui = useUiText();
  const { panel, collapsed } = useCloudBookUpload();
  useEffect(() => { void recoverCloudBookUpload(); }, []);
  useEffect(() => {
    if (panel.kind === "confirm") void refreshCloudSyncStatus();
  }, [panel.kind]);
  useEffect(() => {
    if (panel.kind === "closed" || collapsed || typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeCloudBookUpload();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [panel.kind, collapsed]);

  if (panel.kind === "closed") return null;
  if (collapsed) return <FloatCard />;
  const title = panelTitle(ui, panel);
  return <div className="cloud-upload-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closeCloudBookUpload(); }}>
    <section className="cloud-upload-panel" role="dialog" aria-modal="true" aria-label={title}>
      <h2 className={panel.kind === "result" && panel.result.status === "stopped" ? "is-bad" : ""}>{title}</h2>
      {panel.kind === "confirm" && <Confirm panel={panel} onOpenSync={onOpenSync} />}
      {panel.kind === "running" && <Running panel={panel} />}
      {panel.kind === "detached" && <Detached panel={panel} />}
      {panel.kind === "result" && <Result result={panel.result} />}
      {panel.kind === "failed" && <>
        <p className="cloud-upload-error" role="alert">{uploadFailureText(ui.t, panel.failure, (failure) => cloudSyncFailureText(ui.t, failure))}</p>
        <div className="cloud-upload-actions">
          <button type="button" className="ui-btn is-primary" onClick={closeCloudBookUpload}>{ui.t("cloudSync.upload.close")}</button>
        </div>
      </>}
    </section>
  </div>;
}
