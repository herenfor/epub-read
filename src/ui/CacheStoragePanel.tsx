import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import {
  clearFullTextIndex,
  getCacheStorageStatus,
  resetIndexCaches,
  setCacheStorageDirectory,
  type AiCacheStatus,
  type CacheStorageStatus,
} from "../platform/cacheStorage";
import "./cacheStoragePanel.css";
import { currentUiLocale, uiText, useUiText } from "./localization/UiLanguageProvider";

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
    return new Date(value).toLocaleString(currentUiLocale());
  } catch {
    return "—";
  }
}

function cacheStateLabel(state: string): string {
  switch (state) {
    case "building":
      return uiText("cache.state.building");
    case "ready":
      return uiText("cache.state.ready");
    case "partial":
      return uiText("cache.state.partial");
    case "error":
      return uiText("cache.state.error");
    case "empty":
      return uiText("cache.state.empty");
    default:
      return state;
  }
}

function FullTextCacheRow({ cache }: { cache: AiCacheStatus }) {
  const { t } = useUiText();
  return (
    <>
      <div>{t("cache.indexedBooks")} <strong>{cache.itemCount}</strong></div>
      <div>{t("cache.state")} <strong>{cacheStateLabel(cache.state)}</strong></div>
      <div>{t("cache.updated")} <strong>{formatTimestamp(cache.updatedAt)}</strong></div>
      <div>{t("cache.size")} <strong>{formatBytes(cache.sizeBytes)}</strong></div>
    </>
  );
}

export function CacheStoragePanel(props: CacheStoragePanelProps) {
  const { t } = useUiText();
  const capabilities = getRuntimeCapabilities();
  const [status, setStatus] = useState<CacheStorageStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"choose" | "default" | "clear" | "reset" | null>(null);
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
        title: uiText("cache.chooseDirectory.title"),
      });
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (!selectedPath) return;
      setStatus(await setCacheStorageDirectory(selectedPath));
      setNotice(uiText("cache.saved"));
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
      setNotice(uiText("cache.restored"));
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
      setNotice(uiText("cache.cleared"));
    } catch (reason) {
      await refresh();
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }, [busy, refresh]);

  const resetCaches = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy("reset");
    setError(null);
    setNotice(null);
    try {
      await resetIndexCaches();
      await refresh();
      setNotice(uiText("cache.reset.done"));
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
        aria-label={t("cache.dialog")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cache-storage-head">
          <div>
            <h2>{t("cache.title")}</h2>
            <p>{t("cache.deviceOnly")}</p>
          </div>
          <button type="button" className="tb-btn" onClick={props.onClose} aria-label={t("cache.close.label")}>
            {t("cache.close")}
          </button>
        </header>

        {error && <div className="cache-storage-alert is-error" role="alert">{error}</div>}
        {status?.fallbackReason && (
          <div className="cache-storage-alert is-warn" role="status">
            {t("cache.fallback", { reason: status.fallbackReason })}
          </div>
        )}
        {notice && <div className="cache-storage-alert is-notice" role="status">{notice}</div>}

        {loading && !status && <div className="cache-storage-loading">{t("cache.loading")}</div>}
        {!loading && (status !== null || error !== null) && (
          <div className="cache-storage-category">
            <p className="cache-storage-hint">
              {t("cache.reset.hint")}
            </p>
            <button type="button" className="tb-btn is-danger"
              disabled={busy !== null || status?.caches.some((cache) => cache.state === "building")}
              onClick={() => void resetCaches()}>
              {busy === "reset" ? t("cache.resetting") : t("cache.reset")}
            </button>
          </div>
        )}

        {status && (
          <>
            <dl className="cache-storage-paths">
              <div>
                <dt>{t("cache.activeDirectory")}</dt>
                <dd className="cache-storage-path" title={status.activeDirectory}>{status.activeDirectory}</dd>
              </div>
              <div>
                <dt>{t("cache.savedDirectory")}</dt>
                <dd className="cache-storage-path" title={status.configuredBaseDirectory ?? t("cache.defaultDirectory")}>
                  {status.configuredBaseDirectory ?? t("cache.defaultDirectory.detail")}
                </dd>
              </div>
            </dl>

            {status.restartRequired && (
              <div className="cache-storage-restart">{t("cache.restartRequired")}</div>
            )}

            {capabilities.supportsCustomCacheDirectory && (
              <div className="cache-storage-actions">
                <button type="button" className="tb-btn" onClick={() => void chooseDirectory()} disabled={busy !== null}>
                  {busy === "choose" ? t("cache.choosing") : t("cache.chooseDirectory")}
                </button>
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => void restoreDefault()}
                  disabled={busy !== null || status.configuredBaseDirectory === null}
                >
                  {busy === "default" ? t("cache.restoring") : t("cache.restoreDefault")}
                </button>
              </div>
            )}

            <div className="cache-storage-total">
              <span>{t("cache.total")}</span>
              <strong>{formatBytes(status.totalSizeBytes)}</strong>
            </div>

            <div className="cache-storage-category">
              <div className="cache-storage-category-head">
                <h3>{t("cache.fullText")}</h3>
                <button
                  type="button"
                  className="tb-btn is-danger"
                  onClick={() => void clearIndex()}
                  disabled={clearDisabled}
                  title={fullText?.state === "building" ? t("cache.clear.building") : t("cache.clear")}
                >
                  {busy === "clear" ? t("cache.clearing") : t("cache.clear")}
                </button>
              </div>
              {fullText ? (
                <div className="cache-storage-category-grid">
                  <FullTextCacheRow cache={fullText} />
                </div>
              ) : (
                <div className="cache-storage-loading">{t("cache.fullText.none")}</div>
              )}
              <p className="cache-storage-hint">
                {t("cache.clear.hint")}
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
