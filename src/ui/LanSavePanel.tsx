import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as QRCode from "qrcode";
import type { ShelfEntry } from "./shelf";
import { SaveFileImportPreview } from "./SaveFileDialogs";
import { openAndroidAppSettings, scanAndroidQrCode } from "../platform/androidLanScanBridge";
import type { UseLanSaveSessionResult } from "./useLanSaveSession";
import {
  lanErrorText,
  lanOfferDetail,
  lanOfferTitle,
  lanProgressView,
  lanScanText,
  type LanUserStep,
} from "./lanSaveMessages";
import "./lanSavePanel.css";

export interface LanSavePanelProps {
  open: boolean;
  /** Plays the shared menu exit animation before the App unmounts the panel. */
  closing?: boolean;
  session: UseLanSaveSessionResult;
  selectedEntries: ShelfEntry[];
  isAndroid: boolean;
  onClose(): void;
}

const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const Icon = {
  close: <svg {...svgProps}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  chevron: <svg {...svgProps}><path d="M9 6l6 6-6 6" /></svg>,
  qr: (
    <svg {...svgProps}>
      <rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2v2h-2zM18 14h2M14 18v2M18 18h2v2" />
    </svg>
  ),
  scan: (
    <svg {...svgProps}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </svg>
  ),
  paste: (
    <svg {...svgProps}>
      <rect x="6" y="4" width="12" height="16" rx="2" /><path d="M9 4.5h6M9 10h6M9 14h4" />
    </svg>
  ),
  check: <svg {...svgProps}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  info: <svg {...svgProps}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>,
  alert: <svg {...svgProps}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></svg>,
  incoming: <svg {...svgProps}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>,
  devices: (
    <svg viewBox="0 0 96 48" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="8" width="26" height="34" rx="4" />
      <path d="M16 36h6" />
      <rect x="62" y="6" width="28" height="38" rx="4" />
      <path d="M73 38h6" />
      <path d="M40 20h16M51 15l5 5-5 5" />
      <path d="M56 30H40M45 25l-5 5 5 5" />
    </svg>
  ),
};

type ResultTone = "success" | "info" | "error";

function ResultView(props: { tone: ResultTone; title: string; detail: string; actions: ReactNode }) {
  return (
    <div className={`lan-result tone-${props.tone}`} role="status">
      <span className="lan-result-icon">
        {props.tone === "success" ? Icon.check : props.tone === "info" ? Icon.info : Icon.alert}
      </span>
      <h3>{props.title}</h3>
      <p>{props.detail}</p>
      <div className="lan-actions stacked">{props.actions}</div>
    </div>
  );
}

function Spinner() {
  return <span className="lan-spinner" aria-hidden />;
}

export function LanSavePanel(props: LanSavePanelProps) {
  const state = props.session.state;
  const [joinText, setJoinText] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [bindIp, setBindIp] = useState("");
  const [scopeChoice, setScopeChoice] = useState<"all" | "selected">(
    props.selectedEntries.length > 0 ? "selected" : "all",
  );
  const [includeBooks, setIncludeBooks] = useState(false);
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showSettingsLink, setShowSettingsLink] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const scanRunRef = useRef(0);
  const scanBusyRef = useRef(false);
  const stepRef = useRef<LanUserStep | null>(null);
  const lastContentRef = useRef<ReactNode>(null);
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

  // Back on the start page after a session ends or fails. The pasted text is
  // kept so a mistyped connection string can be corrected instead of re-pasted.
  useEffect(() => {
    if (!props.open || state.status !== "idle") return;
    setScanBusy(false);
    setCopied(false);
  }, [props.open, state.status]);

  // Native messages stay out of the UI; keep them for developers only.
  useEffect(() => {
    if (state.error) console.warn("[lan-save]", state.errorCode ?? "unknown", state.error);
  }, [state.error, state.errorCode]);

  useEffect(() => {
    let cancelled = false;
    if (!props.open || !state.pairingInfo) {
      setQrDataUrl(null);
      setQrFailed(false);
      return () => { cancelled = true; };
    }
    void QRCode.toDataURL(state.pairingInfo, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 480,
      color: { dark: "#111113", light: "#ffffff" },
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

  const clearLocalError = useCallback((): void => {
    setLocalError(null);
    setShowSettingsLink(false);
  }, []);

  const handleCopy = useCallback(async (): Promise<void> => {
    const info = props.session.state.pairingInfo;
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info);
      setCopied(true);
    } catch {
      setLocalError("没能复制到剪贴板，请再试一次。");
    }
  }, [props.session.state.pairingInfo]);

  const handleHost = useCallback((): void => {
    clearLocalError();
    stepRef.current = "host";
    void props.session.startHost(bindIp.trim() || undefined);
  }, [bindIp, clearLocalError, props.session]);

  const handleJoin = useCallback((): void => {
    clearLocalError();
    stepRef.current = "join";
    void props.session.join(joinText);
  }, [clearLocalError, joinText, props.session]);

  const handleScan = useCallback(async (): Promise<void> => {
    if (scanBusyRef.current) return;
    scanBusyRef.current = true;
    const run = ++scanRunRef.current;
    clearLocalError();
    setScanBusy(true);
    try {
      const outcome = await scanAndroidQrCode();
      if (scanRunRef.current !== run) return;
      if (outcome.status === "scanned" && outcome.contents) {
        stepRef.current = "join";
        await props.session.join(outcome.contents);
      } else {
        setLocalError(lanScanText(outcome.status));
        setShowSettingsLink(outcome.status === "permission-denied");
      }
    } catch (error) {
      if (scanRunRef.current === run) {
        console.warn("[lan-save] scan", error);
        setLocalError(lanScanText("failed"));
      }
    } finally {
      scanBusyRef.current = false;
      if (scanRunRef.current === run) setScanBusy(false);
    }
  }, [clearLocalError, props.session]);

  const handleSend = useCallback((): void => {
    stepRef.current = "send";
    void props.session.send(scopeChoice, includeBooks);
  }, [includeBooks, props.session, scopeChoice]);

  const handleAccept = useCallback((): void => {
    stepRef.current = "receive";
    void props.session.accept();
  }, [props.session]);

  const handleReconnect = useCallback((): void => {
    setCopied(false);
    clearLocalError();
    stepRef.current = null;
    void props.session.close();
  }, [clearLocalError, props.session]);

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

  const nativeError = state.error ? lanErrorText(state.errorCode, stepRef.current) : null;
  const selectedCount = props.selectedEntries.length;

  const renderBanner = () => {
    const text = localError ?? nativeError;
    if (!text) return null;
    return (
      <div className="lan-banner" role="alert">
        <span className="lan-banner-icon">{Icon.alert}</span>
        <div>
          <p>{text}</p>
          {showSettingsLink && props.isAndroid && (
            <button type="button" className="lan-link" onClick={() => void openAndroidAppSettings().catch(() => undefined)}>
              打开系统设置
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderStart = () => (
    <>
      {renderBanner()}
      <div className="lan-intro">
        <span className="lan-intro-art">{Icon.devices}</span>
        <p>两台设备连接同一个 Wi‑Fi，在一台上显示二维码，用另一台扫码，就能互相传送书籍和阅读进度。</p>
      </div>
      <div className="lan-options">
        <button type="button" className="lan-option" disabled={scanBusy} onClick={handleHost}>
          <span className="lan-option-icon">{Icon.qr}</span>
          <span className="lan-option-text">
            <strong>显示二维码</strong>
            <small>让另一台设备扫码连接这台设备</small>
          </span>
          <span className="lan-option-chevron">{Icon.chevron}</span>
        </button>
        {props.isAndroid && (
          <button type="button" className="lan-option" disabled={scanBusy} onClick={() => void handleScan()}>
            <span className="lan-option-icon">{scanBusy ? <Spinner /> : Icon.scan}</span>
            <span className="lan-option-text">
              <strong>{scanBusy ? "正在打开相机…" : "扫码连接"}</strong>
              <small>扫描另一台设备上显示的二维码</small>
            </span>
            <span className="lan-option-chevron">{Icon.chevron}</span>
          </button>
        )}
        <button
          type="button"
          className={`lan-option${pasteOpen ? " is-open" : ""}`}
          aria-expanded={pasteOpen}
          disabled={scanBusy}
          onClick={() => setPasteOpen((value) => !value)}
        >
          <span className="lan-option-icon">{Icon.paste}</span>
          <span className="lan-option-text">
            <strong>粘贴连接信息</strong>
            <small>{props.isAndroid ? "不方便扫码时使用" : "在另一台设备点「复制连接信息」后粘贴到这里"}</small>
          </span>
          <span className="lan-option-chevron">{Icon.chevron}</span>
        </button>
        {pasteOpen && (
          <div className="lan-paste">
            <textarea
              aria-label="连接信息"
              value={joinText}
              placeholder="粘贴另一台设备复制的连接信息"
              onChange={(event) => setJoinText(event.target.value)}
            />
            <button type="button" className="lan-primary" disabled={scanBusy || !joinText.trim()} onClick={handleJoin}>
              连接
            </button>
          </div>
        )}
      </div>
      <details className="lan-help">
        <summary>连不上怎么办？</summary>
        <ul>
          <li>确认两台设备连着同一个 Wi‑Fi，或者都连同一部手机的热点。</li>
          <li>公司、学校、酒店的网络和路由器的“访客网络”常常禁止设备互连，可以改用手机热点。</li>
          <li>电脑上如果弹出防火墙提示，请选择允许。</li>
        </ul>
        <label className="lan-field">
          <span>指定本机网络地址（一般不需要填写）</span>
          <input
            type="text"
            inputMode="decimal"
            value={bindIp}
            placeholder="例如 192.168.1.10"
            onChange={(event) => setBindIp(event.target.value)}
          />
        </label>
      </details>
    </>
  );

  const renderHost = () => (
    <div className="lan-host">
      <div className="lan-qr-card">
        {qrDataUrl ? (
          <img className="lan-qr" src={qrDataUrl} alt="局域网互传二维码" />
        ) : qrFailed ? (
          <p className="lan-qr-fallback">二维码显示失败，请点下方「复制连接信息」，在另一台设备粘贴。</p>
        ) : (
          <Spinner />
        )}
      </div>
      <h3>用另一台设备扫描这个二维码</h3>
      <ol className="lan-steps">
        <li>在另一台设备打开「书架菜单 → 局域网互传」</li>
        <li>选择「扫码连接」，对准这个二维码</li>
      </ol>
      <p className="lan-waiting"><span className="lan-pulse" aria-hidden />等待连接…</p>
      <div className="lan-actions">
        <button type="button" className="lan-secondary" disabled={!state.pairingInfo} onClick={() => void handleCopy()}>
          {copied ? "已复制" : "复制连接信息"}
        </button>
        <button type="button" className="lan-ghost" onClick={handleReconnect}>取消</button>
      </div>
    </div>
  );

  const renderConnected = () => (
    <>
      {renderBanner()}
      <div className="lan-connected-chip"><span>{Icon.check}</span>已连接到另一台设备</div>
      <section className="lan-card" aria-label="发送给对方">
        <h3>发送给对方</h3>
        <div className="lan-segmented" role="radiogroup" aria-label="发送范围">
          <button
            type="button"
            role="radio"
            aria-checked={scopeChoice === "all"}
            className={scopeChoice === "all" ? "active" : ""}
            onClick={() => setScopeChoice("all")}
          >
            全部书籍
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={scopeChoice === "selected"}
            className={scopeChoice === "selected" ? "active" : ""}
            disabled={selectedCount === 0}
            onClick={() => setScopeChoice("selected")}
          >
            {selectedCount > 0 ? `已选的 ${selectedCount} 本` : "已选的书"}
          </button>
        </div>
        {selectedCount === 0 && (
          <p className="lan-hint">只想发几本？先在书架上用「批量选择」选好，再打开这里。</p>
        )}
        <label className="lan-switch-row">
          <span className="lan-switch-text">
            <strong>同时发送书籍文件</strong>
            <small>
              {includeBooks
                ? "对方可以直接打开阅读，书多时需要多等一会儿"
                : "只发送阅读进度、书签和笔记，对方需要已有这些书"}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="lan-switch"
            checked={includeBooks}
            onChange={(event) => setIncludeBooks(event.target.checked)}
          />
        </label>
        <button type="button" className="lan-primary wide" disabled={state.busy} onClick={handleSend}>
          发送
        </button>
      </section>
      <p className="lan-waiting"><span className="lan-pulse" aria-hidden />也可以等对方发送给你</p>
      <button type="button" className="lan-text-btn" onClick={handleReconnect}>断开连接</button>
    </>
  );

  const renderOffer = () => {
    const offer = state.offer!;
    return (
      <div className="lan-offer">
        <span className="lan-offer-icon">{Icon.incoming}</span>
        <h3>{lanOfferTitle(offer)}</h3>
        <p>{lanOfferDetail(offer)}</p>
        <p className="lan-hint">接收后会先显示导入预览，确认后才会写入书架。</p>
        <div className="lan-actions stacked">
          <button type="button" className="lan-primary" onClick={handleAccept}>接收</button>
          <button type="button" className="lan-secondary" onClick={() => void props.session.decline()}>拒绝</button>
        </div>
      </div>
    );
  };

  const renderProgress = () => {
    const view = lanProgressView(state.progress);
    const title = state.status === "sending" ? "正在发送"
      : state.status === "receiving" ? "正在接收"
        : state.status === "preparing" ? "正在检查收到的资料"
          : "正在写入书架";
    return (
      <div className="lan-progress" role="status" aria-live="polite">
        <h3>{title}</h3>
        <div
          className={`lan-bar${view.percent === null ? " indeterminate" : ""}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent ?? undefined}
        >
          <span style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
        </div>
        <p className="lan-progress-meta">
          <span>{view.percent === null ? view.label : `${view.label} ${view.percent}%`}</span>
          {view.detail && <span>{view.detail}</span>}
        </p>
        {state.status === "committing" ? (
          <p className="lan-hint">马上就好。现在关闭面板也不会中断，完成后书架会自动更新。</p>
        ) : (
          <button type="button" className="lan-secondary" onClick={handleReconnect}>取消</button>
        )}
      </div>
    );
  };

  const reconnectActions = (primary: "done" | "reconnect") => (
    <>
      {primary === "done" ? (
        <>
          <button type="button" className="lan-primary" onClick={closePanel}>完成</button>
          <button type="button" className="lan-secondary" onClick={handleReconnect}>再传一次</button>
        </>
      ) : (
        <>
          <button type="button" className="lan-primary" onClick={handleReconnect}>重新连接</button>
          <button type="button" className="lan-secondary" onClick={closePanel}>关闭</button>
        </>
      )}
    </>
  );

  const renderSendResult = () => {
    const result = state.sendResult;
    const skipped = result?.skippedBooks.length ?? 0;
    const skippedNote = skipped > 0 ? `有 ${skipped} 本书的文件没有找到，只发送了它们的阅读进度。` : "";
    if (state.status === "sendComplete") {
      const imported = state.remoteCommit?.importedBooks.length;
      return (
        <ResultView
          tone="success"
          title="发送完成"
          detail={`${imported !== undefined ? `对方已导入 ${imported} 本书。` : "对方已收到并导入。"}${skippedNote}`}
          actions={reconnectActions("done")}
        />
      );
    }
    if (state.status === "sendUnconfirmed") {
      return (
        <ResultView
          tone="info"
          title="已发送，但没收到对方确认"
          detail="连接在对方确认前断开了。请在对方设备的书架上看看这些书是否已经导入。"
          actions={reconnectActions("done")}
        />
      );
    }
    if (state.status === "sendCancelled") {
      return (
        <ResultView
          tone="info"
          title="发送没有完成"
          detail="发送被取消，或者对方没有接收。对方的书架没有任何变化。"
          actions={reconnectActions("reconnect")}
        />
      );
    }
    return (
      <ResultView
        tone="error"
        title="发送失败"
        detail={nativeError ?? lanErrorText(null, "send")}
        actions={reconnectActions("reconnect")}
      />
    );
  };

  const renderBody = () => {
    if (state.status === "startingHost" || state.status === "hostReady") return renderHost();
    if (state.status === "joining") {
      return (
        <div className="lan-busy" role="status">
          <Spinner />
          <h3>正在连接…</h3>
          <button type="button" className="lan-secondary" onClick={handleReconnect}>取消</button>
        </div>
      );
    }
    if (state.offer && state.status === "receiving") return renderOffer();
    if (state.status === "sending" || state.status === "receiving" || state.status === "preparing" || state.status === "committing") {
      return renderProgress();
    }
    if (state.status === "sendComplete" || state.status === "sendUnconfirmed" || state.status === "sendCancelled" || state.status === "sendFailed") {
      return renderSendResult();
    }
    if (state.status === "commitComplete") {
      const imported = state.remoteCommit?.importedBooks.length ?? 0;
      return (
        <ResultView
          tone="success"
          title="导入完成"
          detail={imported > 0 ? `已导入 ${imported} 本书，书架已经更新。` : "资料已导入，书架已经更新。"}
          actions={reconnectActions("done")}
        />
      );
    }
    if (state.status === "closed") {
      return (
        <ResultView
          tone={nativeError ? "error" : "info"}
          title="连接已断开"
          detail={nativeError ?? "对方已经断开连接。需要继续传送时，请重新连接。"}
          actions={reconnectActions("reconnect")}
        />
      );
    }
    if (state.status === "connected") return renderConnected();
    return renderStart();
  };

  const subtitle = state.status === "idle"
    ? "同一 Wi‑Fi 下直接传送，不经过云端"
    : state.status === "startingHost" || state.status === "hostReady"
      ? "等待另一台设备扫码"
      : state.status === "connected"
        ? "已连接，选择要发送的内容"
        : "请保持两台设备都打开本应用";

  // The App ends the session as soon as the panel starts closing; keep the last
  // frame on screen during the exit animation instead of flashing the start page.
  const content = props.closing && lastContentRef.current ? lastContentRef.current : (
    <>
      <header className="lan-head">
        <div className="lan-head-text">
          <h2>局域网互传</h2>
          <p>{subtitle}</p>
        </div>
        <button type="button" className="lan-icon-btn lan-close" onClick={closePanel} aria-label="关闭局域网互传">
          {Icon.close}
        </button>
      </header>
      <div className="lan-body">{renderBody()}</div>
    </>
  );
  if (!props.closing) lastContentRef.current = content;

  return (
    <div className={`lan-backdrop${props.closing ? " is-closing" : ""}`} role="presentation">
      <section className="lan-panel" role="dialog" aria-modal="true" aria-label="局域网互传">
        {content}
      </section>
    </div>
  );
}

