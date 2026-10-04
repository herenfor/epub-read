import { useCallback, useEffect, useRef, useState } from "react";
import * as QRCode from "qrcode";
import type { ShelfEntry } from "./shelf";
import { SaveFileImportPreview } from "./SaveFileDialogs";
import { scanAndroidQrCode } from "../platform/androidLanScanBridge";
import type { LanOfferSummary, LanProgress } from "../platform/lanSaveNativeBridge";
import type { UseLanSaveSessionResult } from "./useLanSaveSession";
import "./lanSavePanel.css";

export interface LanSavePanelProps {
  open: boolean;
  session: UseLanSaveSessionResult;
  selectedEntries: ShelfEntry[];
  isAndroid: boolean;
  onClose(): void;
}

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

function progressLabel(progress: LanProgress | null): string {
  if (!progress) return "等待进度…";
  const labels: Record<string, string> = {
    preparing: "正在准备",
    reading: "正在读取资料",
    extracting: "正在解析存档",
    writing: "正在写入",
    finalizing: "正在收尾",
    copying: "正在传输",
    committing: "正在提交到书库",
    receiving: "正在接收",
  };
  const label = labels[progress.phase] ?? (progress.phase || "进行中");
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    const percent = Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100));
    return `${label} ${percent}% · ${formatBytes(progress.processedBytes)} / ${formatBytes(progress.totalBytes)}`;
  }
  if (progress.processedBytes > 0) return `${label} · 已处理 ${formatBytes(progress.processedBytes)}`;
  return `${label}…`;
}

function friendlyError(message: string | null, code: string | null): string {
  switch (code) {
    case "lan-unreachable":
      return "无法连接对端：请确认两台设备在同一 Wi-Fi/局域网，路由器未开启 AP 隔离或访客网络，且系统防火墙允许本地连接。";
    case "pin-mismatch":
    case "token-mismatch":
      return "连接信息不匹配或已过期，请在显示端重新显示连接码后再试。";
    case "busy":
      return "当前有传输或存档任务正在进行，请等待本轮结束后重试。";
    case "cancelled":
      return "已取消。";
    case "expired":
      return message || "连接已超时，请重新显示连接码。";
    case "invalid-request":
    case "invalid-data":
      return message || "连接信息无效，请重新复制完整的连接信息。";
    case "network":
      return message || "网络连接中断，请确认同一 Wi-Fi 后重试。";
    case "secure-error":
      return message || "安全连接失败，请重新显示连接码。";
    case "storage-error":
      return message || "本地存储失败，请确认设备空间充足。";
    default:
      return message || "局域网互传失败，请重试。";
  }
}

function OfferSummary(props: { offer: LanOfferSummary }) {
  const offer = props.offer;
  return (
    <div className="lan-save-offer">
      <h3>对端想发送资料</h3>
      <dl className="lan-save-summary">
        <div><dt>包大小</dt><dd>{formatBytes(offer.archiveBytes)}</dd></div>
        <div><dt>资料本数</dt><dd>{offer.bookCount}</dd></div>
        <div><dt>附带书籍</dt><dd>{offer.includeBooks ? `${offer.attachedBookCount} 本` : "不附书"}</dd></div>
        <div><dt>跳过附书</dt><dd>{offer.skippedBookCount}</dd></div>
      </dl>
      <p className="lan-save-muted">这是接收前摘要，尚未验证；确认接收后才会下载并显示导入预览。</p>
    </div>
  );
}

export function LanSavePanel(props: LanSavePanelProps) {
  const state = props.session.state;
  const [joinText, setJoinText] = useState("");
  const [bindIp, setBindIp] = useState("");
  const [scopeChoice, setScopeChoice] = useState<"all" | "selected">(
    props.selectedEntries.length > 0 ? "selected" : "all",
  );
  const [includeBooks, setIncludeBooks] = useState(false);
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const scanRunRef = useRef(0);
  const scanBusyRef = useRef(false);
  useEffect(() => () => { scanRunRef.current += 1; }, []);
  const closePanel = useCallback((): void => {
    scanRunRef.current += 1;
    props.onClose();
  }, [props.onClose]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setScopeChoice(props.selectedEntries.length > 0 ? "selected" : "all");
  }, [props.open, props.selectedEntries.length]);

  useEffect(() => {
    if (!props.open || state.status !== "idle") return;
    setJoinText("");
    setLocalError(null);
    setScanBusy(false);
    setCopied(false);
  }, [props.open, state.status]);

  useEffect(() => {
    let cancelled = false;
    if (!props.open || !state.pairingInfo) {
      setQrDataUrl(null);
      setQrFailed(false);
      return () => { cancelled = true; };
    }
    void QRCode.toDataURL(state.pairingInfo, {
      errorCorrectionLevel: "M",
      margin: 3,
      width: 320,
      color: { dark: "#000000", light: "#ffffff" },
    }).then((url) => {
      if (!cancelled) {
        setQrDataUrl(url);
        setQrFailed(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setQrDataUrl(null);
        setQrFailed(true);
      }
    });
    return () => { cancelled = true; };
  }, [props.open, state.pairingInfo]);

  const handleCopy = useCallback(async (): Promise<void> => {
    const info = props.session.state.pairingInfo;
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info);
      setCopied(true);
    } catch {
      setLocalError("复制失败，请重试。");
    }
  }, [props.session.state.pairingInfo]);

  const handleScan = useCallback(async (): Promise<void> => {
    if (scanBusyRef.current) return;
    scanBusyRef.current = true;
    const run = ++scanRunRef.current;
    setLocalError(null);
    setScanBusy(true);
    try {
      const contents = await scanAndroidQrCode();
      if (scanRunRef.current !== run) return;
      const trimmed = contents?.trim();
      if (trimmed) {
        await props.session.join(trimmed);
      } else {
        setLocalError("未完成扫码（已取消或未授予相机权限），仍可粘贴连接信息加入。");
      }
    } catch (error) {
      if (scanRunRef.current === run) setLocalError(`无法打开扫码：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      scanBusyRef.current = false;
      if (scanRunRef.current === run) setScanBusy(false);
    }
  }, [props.session]);

  const handleReconnect = useCallback((): void => {
    setCopied(false);
    setLocalError(null);
    void props.session.close();
  }, [props.session]);

  if (!props.open) return null;

  if (state.preview) {
    return (
      <SaveFileImportPreview
        preview={state.preview}
        sourceLabel="局域网互传"
        canceling={state.closing}
        onCancel={closePanel}
        onConfirm={(applyPreferences) => void props.session.commit(applyPreferences)}
      />
    );
  }

  const visibleError = localError ?? (state.error ? friendlyError(state.error, state.errorCode) : null);
  const busyLabel = state.status === "startingHost"
    ? "正在准备连接码…"
    : state.status === "joining"
      ? "正在连接对端…"
      : null;

  const renderConnectedActions = () => (
    <div className="lan-save-scope">
      <h3>发送资料</h3>
      <fieldset className="lan-save-fieldset">
        <legend>范围</legend>
        <label className="lan-save-radio">
          <input
            type="radio"
            name="lan-save-scope"
            checked={scopeChoice === "all"}
            onChange={() => setScopeChoice("all")}
          />
          <span>全库资料</span>
        </label>
        <label className={`lan-save-radio${props.selectedEntries.length === 0 ? " disabled" : ""}`}>
          <input
            type="radio"
            name="lan-save-scope"
            checked={scopeChoice === "selected"}
            disabled={props.selectedEntries.length === 0}
            onChange={() => setScopeChoice("selected")}
          />
          <span>
            {props.selectedEntries.length > 0
              ? `当前选中的 ${props.selectedEntries.length} 本资料`
              : "当前没有选中的书籍"}
          </span>
        </label>
      </fieldset>
      <label className="lan-save-check">
        <input
          type="checkbox"
          checked={includeBooks}
          onChange={(event) => setIncludeBooks(event.target.checked)}
        />
        <span>附带书籍文件（默认不附带，只传资料与进度）</span>
      </label>
      <div className="lan-save-actions">
        <button
          className="primary"
          type="button"
          disabled={state.busy}
          onClick={() => void props.session.send(scopeChoice, includeBooks)}
        >
          发送资料
        </button>
      </div>
      <p className="lan-save-muted">等待对端发送时也可以保持此面板打开；双方同时发送会由底层拒绝并保留当前会话。</p>
    </div>
  );

  const renderProgress = () => (
    <div className="lan-save-progress" role="status" aria-live="polite">
      <h3>{
        state.status === "sending" ? "正在发送资料"
          : state.status === "receiving" ? "正在接收资料"
            : state.status === "preparing" ? "正在验证资料"
              : "正在提交到书库"
      }</h3>
      <p>{progressLabel(state.progress)}</p>
      {state.status === "committing" ? (
        <p className="lan-save-muted">提交已开始，关闭窗口不会回滚；可以隐藏面板，完成后仍会刷新书架。</p>
      ) : (
        <button type="button" onClick={handleReconnect}>取消</button>
      )}
    </div>
  );

  const renderSendResult = () => {
    const result = state.sendResult;
    return (
      <div className="lan-save-result">
        <h3>{state.status === "sendComplete" ? "发送完成" : "发送结束"}</h3>
        {result && (
          <dl className="lan-save-summary">
            <div><dt>状态</dt><dd>{state.notice ?? "已结束"}</dd></div>
            <div><dt>附书</dt><dd>{result.writtenBooks} 本</dd></div>
            <div><dt>跳过附书</dt><dd>{result.skippedBooks.length} 本</dd></div>
          </dl>
        )}
        {state.status === "sendUnconfirmed" && (
          <p className="lan-save-muted">连接已结束，不能推断对方没有导入；需要时请对方确认后重新连接。</p>
        )}
        {state.status === "sendFailed" && visibleError && (
          <p className="lan-save-alert" role="alert">{visibleError}</p>
        )}
        <div className="lan-save-actions">
          <button type="button" className="primary" onClick={handleReconnect}>重新连接</button>
          <button type="button" onClick={closePanel}>关闭</button>
        </div>
      </div>
    );
  };

  const renderBody = () => {
    if (busyLabel) {
      return (
        <div className="lan-save-progress">
          <h3>{busyLabel}</h3>
          <button type="button" onClick={closePanel}>取消</button>
        </div>
      );
    }

    if (state.offer && state.status === "receiving") {
      return (
        <div>
          <OfferSummary offer={state.offer} />
          <div className="lan-save-actions">
            <button type="button" className="primary" onClick={() => void props.session.accept()}>接收</button>
            <button type="button" onClick={() => void props.session.decline()}>取消</button>
          </div>
        </div>
      );
    }

    if (state.status === "sending" || state.status === "receiving" || state.status === "preparing" || state.status === "committing") {
      return renderProgress();
    }

    if (state.status === "sendComplete" || state.status === "sendUnconfirmed" || state.status === "sendCancelled" || state.status === "sendFailed") {
      return renderSendResult();
    }

    if (state.status === "commitComplete") {
      return (
        <div className="lan-save-result">
          <h3>导入完成</h3>
          <p>{state.notice ?? "资料已提交到本机书库。"}</p>
          <p className="lan-save-muted">一个会话只传输一份存档；继续互传需要重新连接创建新码。</p>
          <div className="lan-save-actions">
            <button type="button" className="primary" onClick={handleReconnect}>重新连接</button>
            <button type="button" onClick={closePanel}>关闭</button>
          </div>
        </div>
      );
    }

    if (state.status === "closed") {
      return (
        <div className="lan-save-result">
          <h3>连接已结束</h3>
          <p className="lan-save-muted">不会自动重连；需要继续时请重新创建连接码或扫码加入。</p>
          <div className="lan-save-actions">
            <button type="button" className="primary" onClick={handleReconnect}>重新连接</button>
            <button type="button" onClick={closePanel}>关闭</button>
          </div>
        </div>
      );
    }

    if (state.status === "hostReady") {
      return (
        <div className="lan-save-host">
          <p className="lan-save-connected">等待另一台设备扫码加入…</p>
          {qrDataUrl ? (
            <img className="lan-save-qr" src={qrDataUrl} alt="局域网互传连接码" />
          ) : qrFailed ? (
            <p className="lan-save-muted">二维码生成失败，请使用下方按钮复制完整连接信息。</p>
          ) : (
            <p className="lan-save-muted">正在生成二维码…</p>
          )}
          <div className="lan-save-actions">
            <button type="button" onClick={() => void handleCopy()}>
              {copied ? "已复制连接信息" : "复制连接信息"}
            </button>
            <button type="button" onClick={closePanel}>取消</button>
          </div>
          <p className="lan-save-muted">连接码包含一次性配对凭据；不默认复制、不写日志、不保存到设备。</p>
        </div>
      );
    }

    if (state.status === "connected") {
      return (
        <div>
          <p className="lan-save-connected">已连接，可以发送资料或等待对端发送。</p>
          {renderConnectedActions()}
          <div className="lan-save-actions">
            <button type="button" onClick={handleReconnect}>结束连接</button>
          </div>
        </div>
      );
    }

    return (
      <div className="lan-save-start">
        <p className="lan-save-muted">请确保两台设备连接同一 Wi-Fi/局域网。连接信息只用于这一次配对。</p>
        <div className="lan-save-actions">
          <button type="button" className="primary" disabled={scanBusy} onClick={() => void props.session.startHost(bindIp.trim() || undefined)}>
            显示连接码
          </button>
          {props.isAndroid && (
            <button type="button" disabled={scanBusy} onClick={() => void handleScan()}>
              {scanBusy ? "正在打开相机…" : "扫码加入"}
            </button>
          )}
        </div>
        <details className="lan-save-advanced">
          <summary>连接地址</summary>
          <label>
            <span>监听 IPv4（留空自动选择）</span>
            <input
              type="text"
              inputMode="decimal"
              value={bindIp}
              placeholder="例如 192.168.1.10"
              onChange={(event) => setBindIp(event.target.value)}
            />
          </label>
        </details>
        <div className="lan-save-join">
          <label htmlFor="lan-save-pairing-input">粘贴连接信息</label>
          <textarea
            id="lan-save-pairing-input"
            value={joinText}
            placeholder="从显示码设备复制完整连接信息后粘贴到这里"
            onChange={(event) => setJoinText(event.target.value)}
          />
          <button
            type="button"
            disabled={scanBusy || !joinText.trim()}
            onClick={() => void props.session.join(joinText)}
          >
            加入
          </button>
        </div>
        <p className="lan-save-muted">不可达时请检查同一 Wi-Fi、AP 隔离/访客网络与系统防火墙；本应用不会自动修改这些设置。</p>
      </div>
    );
  };

  return (
    <div className="lan-save-backdrop" role="presentation">
      <section className="lan-save-panel" role="dialog" aria-modal="true" aria-label="局域网互传">
        <header className="lan-save-head">
          <div>
            <h2>局域网互传</h2>
            <p>同一 Wi-Fi 下直接传输书籍资料，不经过云端。</p>
          </div>
          <button type="button" className="lan-save-close" onClick={closePanel} aria-label="关闭局域网互传">
            ×
          </button>
        </header>
        <div className="lan-save-content">
          {state.role && state.status !== "idle" && (
            <p className="lan-save-role">{state.role === "host" ? "本机显示连接码" : "本机扫码/粘贴加入"}</p>
          )}
          {visibleError && <div className="lan-save-alert" role="alert">{visibleError}</div>}
          {state.notice && !visibleError && <div className="lan-save-notice" role="status">{state.notice}</div>}
          {renderBody()}
        </div>
      </section>
    </div>
  );
}
