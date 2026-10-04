import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import {
  clearFullTextIndex,
  getCacheStorageStatus,
  setCacheStorageDirectory,
  type AiCacheStatus,
  type CacheStorageStatus,
} from "../platform/cacheStorage";
import "./cacheStoragePanel.css";

interface CacheStoragePanelProps {
  open: boolean;
  onClose(): void;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "—";
  }
}

function cacheStateLabel(state: string): string {
  switch (state) {
    case "building":
      return "正在建立";
    case "ready":
      return "可用";
    case "partial":
      return "部分可用";
    case "error":
      return "异常";
    case "empty":
      return "空";
    default:
      return state;
  }
}

function FullTextCacheRow({ cache }: { cache: AiCacheStatus }) {
  return (
    <>
      <div>已索引书籍 <strong>{cache.itemCount}</strong></div>
      <div>状态 <strong>{cacheStateLabel(cache.state)}</strong></div>
      <div>最近更新 <strong>{formatTimestamp(cache.updatedAt)}</strong></div>
      <div>分类占用 <strong>{formatBytes(cache.sizeBytes)}</strong></div>
    </>
  );
}

export function CacheStoragePanel(props: CacheStoragePanelProps) {
  const capabilities = getRuntimeCapabilities();
  const [status, setStatus] = useState<CacheStorageStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"choose" | "default" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getCacheStorageStatus());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.open) {
      void refresh();
    } else {
      setStatus(null);
      setError(null);
      setNotice(null);
      setBusy(null);
    }
  }, [props.open, refresh]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  const chooseDirectory = useCallback(async (): Promise<void> => {
    if (!capabilities.supportsCustomCacheDirectory || busy) return;
    setBusy("choose");
    setError(null);
    setNotice(null);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择缓存目录",
      });
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (!selectedPath) return;
      setStatus(await setCacheStorageDirectory(selectedPath));
      setNotice("已保存；本次仍使用原目录，下次启动生效。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }, [busy, capabilities.supportsCustomCacheDirectory]);

  const restoreDefault = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy("default");
    setError(null);
    setNotice(null);
    try {
      setStatus(await setCacheStorageDirectory(null));
      setNotice("已恢复默认；本次仍使用原目录，下次启动生效。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const clearIndex = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy("clear");
    setError(null);
    setNotice(null);
    try {
      await clearFullTextIndex();
      await refresh();
      setNotice("全文索引已清除；全文搜索需要重新准备。");
    } catch (reason) {
      await refresh();
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }, [busy, refresh]);

  if (!props.open) return null;

  const fullText = status?.caches.find((cache) => cache.kind === "full-text-index") ?? null;
  const clearDisabled = busy !== null || loading || fullText?.state === "building";

  return (
    <div className="cache-storage-layer" role="presentation">
      <div className="cache-storage-backdrop" aria-hidden="true" onClick={props.onClose} />
      <section
        className="cache-storage-panel"
        role="dialog"
        aria-modal="true"
        aria-label="缓存与存储"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cache-storage-head">
          <div>
            <h2>缓存与存储</h2>
            <p>设置只用于当前设备。</p>
          </div>
          <button type="button" className="tb-btn" onClick={props.onClose} aria-label="关闭缓存与存储">
            关闭
          </button>
        </header>

        {error && <div className="cache-storage-alert is-error" role="alert">{error}</div>}
        {status?.fallbackReason && (
          <div className="cache-storage-alert is-warn" role="status">
            自定义目录不可用，已回退到默认目录：{status.fallbackReason}
          </div>
        )}
        {notice && <div className="cache-storage-alert is-notice" role="status">{notice}</div>}

        {loading && !status && <div className="cache-storage-loading">正在读取缓存状态…</div>}

        {status && (
          <>
            <dl className="cache-storage-paths">
              <div>
                <dt>本次使用目录</dt>
                <dd className="cache-storage-path" title={status.activeDirectory}>{status.activeDirectory}</dd>
              </div>
              <div>
                <dt>已保存目录</dt>
                <dd className="cache-storage-path" title={status.configuredBaseDirectory ?? "默认目录"}>
                  {status.configuredBaseDirectory ?? "默认（应用数据目录）"}
                </dd>
              </div>
            </dl>

            {status.restartRequired && (
              <div className="cache-storage-restart">设置已保存，重启应用后生效。</div>
            )}

            {capabilities.supportsCustomCacheDirectory && (
              <div className="cache-storage-actions">
                <button type="button" className="tb-btn" onClick={() => void chooseDirectory()} disabled={busy !== null}>
                  {busy === "choose" ? "正在选择…" : "选择缓存目录"}
                </button>
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => void restoreDefault()}
                  disabled={busy !== null || status.configuredBaseDirectory === null}
                >
                  {busy === "default" ? "正在恢复…" : "恢复默认"}
                </button>
              </div>
            )}

            <div className="cache-storage-total">
              <span>索引缓存数据库总占用</span>
              <strong>{formatBytes(status.totalSizeBytes)}</strong>
            </div>

            <div className="cache-storage-category">
              <div className="cache-storage-category-head">
                <h3>全文索引</h3>
                <button
                  type="button"
                  className="tb-btn is-danger"
                  onClick={() => void clearIndex()}
                  disabled={clearDisabled}
                  title={fullText?.state === "building" ? "正在建立全文索引，完成后才能清理" : "清除全文索引"}
                >
                  {busy === "clear" ? "正在清除…" : "清除全文索引"}
                </button>
              </div>
              {fullText ? (
                <div className="cache-storage-category-grid">
                  <FullTextCacheRow cache={fullText} />
                </div>
              ) : (
                <div className="cache-storage-loading">暂无全文索引分类。</div>
              )}
              <p className="cache-storage-hint">
                清除后全文搜索需要重新准备。显示的占用可能不会立即下降。
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
