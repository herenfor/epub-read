import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as QRCode from "qrcode";
import type { ShelfEntry } from "./shelf";
import { SaveFileImportPreview } from "./SaveFileDialogs";
import { openAndroidAppSettings, scanAndroidQrCode } from "../platform/androidLanScanBridge";
import { listLanSaveAddresses, type LanAddressOption } from "../platform/lanSaveNativeBridge";
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
import { uiText, useUiText } from "./localization/UiLanguageProvider";

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
  help: <svg {...svgProps}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></svg>,
  send: <svg {...svgProps}><path d="M4 12 20 4l-6 16-3-7z" /></svg>,
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
  const { t, tn } = useUiText();
  const state = props.session.state;
  const [joinText, setJoinText] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [bindIp, setBindIp] = useState("");
  const [addresses, setAddresses] = useState<LanAddressOption[]>([]);
  const [selectedAddress, setSelectedAddress] = useState("");
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

  // One fresh native snapshot per start page visit. A single listed network
  // changes nothing; only >1 shows the optional network chooser below.
  useEffect(() => {
    if (!props.open || state.status !== "idle") return;
    let cancelled = false;
    setSelectedAddress("");
    void listLanSaveAddresses()
      .then((items) => {
        if (!cancelled) setAddresses(items);
      })
      .catch(() => {
        if (!cancelled) setAddresses([]);
      });
    return () => { cancelled = true; };
  }, [props.open, state.status]);

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
      setLocalError(uiText("lanPanel.copyFailed"));
    }
  }, [props.session.state.pairingInfo]);

  const handleHost = useCallback((): void => {
    clearLocalError();
    stepRef.current = "host";
    // Manual advanced IP wins; otherwise the selected native candidate is
    // passed. If the user never opened the chooser, undefined lets Rust use
    // the first item from the same sorted snapshot.
    void props.session.startHost(bindIp.trim() || selectedAddress.trim() || undefined);
  }, [bindIp, clearLocalError, props.session, selectedAddress]);

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
        sourceLabel={t("lanPanel.sourceLabel")}
        canceling={state.closing}
        onCancel={closePanel}
        onConfirm={(applyPreferences) => void props.session.commit(applyPreferences)}
      />
    );
  }

  const nativeError = state.error ? lanErrorText(state.errorCode, stepRef.current, state.error) : null;
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
              {t("lanPanel.openSettings")}
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
        <p>{t("lanPanel.intro")}</p>
      </div>
      <div className={`lan-tiles${props.isAndroid ? "" : " is-single"}`}>
        <button type="button" className="lan-tile is-primary" disabled={scanBusy} onClick={handleHost}>
          <span className="lan-tile-icon">{Icon.qr}</span>
          <strong>{t("lanPanel.host")}</strong>
          <small>{t("lanPanel.host.detail")}</small>
        </button>
        {props.isAndroid && (
          <button type="button" className="lan-tile" disabled={scanBusy} onClick={() => void handleScan()}>
            <span className="lan-tile-icon">{scanBusy ? <Spinner /> : Icon.scan}</span>
            <strong>{scanBusy ? t("lanPanel.scanOpening") : t("lanPanel.scan")}</strong>
            <small>{t("lanPanel.scan.detail")}</small>
          </button>
        )}
      </div>
      <div className="lan-rows">
        <button
          type="button"
          className={`lan-row${pasteOpen ? " is-open" : ""}`}
          aria-expanded={pasteOpen}
          disabled={scanBusy}
          onClick={() => setPasteOpen((value) => !value)}
        >
          <span className="lan-row-icon">{Icon.paste}</span>
          <span className="lan-row-text">{props.isAndroid ? t("lanPanel.paste.android") : t("lanPanel.paste")}</span>
          <span className="lan-row-chevron">{Icon.chevron}</span>
        </button>
        {pasteOpen && (
          <div className="lan-paste">
            <textarea
              aria-label={t("lanPanel.pairingInfo")}
              value={joinText}
              placeholder={t("lanPanel.paste.placeholder")}
              onChange={(event) => setJoinText(event.target.value)}
            />
            <button type="button" className="lan-primary" disabled={scanBusy || !joinText.trim()} onClick={handleJoin}>
              {t("lanPanel.connect")}
            </button>
          </div>
        )}
        <details className="lan-help">
          <summary className="lan-row">
            <span className="lan-row-icon">{Icon.help}</span>
            <span className="lan-row-text">{t("lanPanel.help")}</span>
            <span className="lan-row-chevron">{Icon.chevron}</span>
          </summary>
          <div className="lan-help-body">
            <ul>
              <li>{t("lanPanel.help.sameWifi")}</li>
              <li>{t("lanPanel.help.guestNetwork")}</li>
              <li>{t("lanPanel.help.firewall")}</li>
            </ul>
            {addresses.length > 1 && (
              <label className="lan-field">
                <span>{t("lanPanel.network")}</span>
                <select
                  value={selectedAddress || addresses[0]?.address || ""}
                  onChange={(event) => setSelectedAddress(event.target.value)}
                >
                  {addresses.map((address) => (
                    <option key={`${address.interfaceId}:${address.address}`} value={address.address}>
                      {address.label} · {address.address}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="lan-field">
              <span>{t("lanPanel.bindIp")}</span>
              <input
                type="text"
                inputMode="decimal"
                value={bindIp}
                placeholder={t("lanPanel.bindIp.placeholder")}
                onChange={(event) => setBindIp(event.target.value)}
              />
            </label>
          </div>
        </details>
      </div>
    </>
  );

  const renderHost = () => (
    <div className="lan-host">
      <div className="lan-qr-card">
        {qrDataUrl ? (
          <img className="lan-qr" src={qrDataUrl} alt={t("lanPanel.qr")} />
        ) : qrFailed ? (
          <p className="lan-qr-fallback">{t("lanPanel.qrFailed")}</p>
        ) : (
          <Spinner />
        )}
      </div>
      <h3>{t("lanPanel.scanThis")}</h3>
      <ol className="lan-steps">
        <li>{t("lanPanel.step.open")}</li>
        <li>{t("lanPanel.step.scan")}</li>
      </ol>
      <p className="lan-waiting"><span className="lan-pulse" aria-hidden />{t("lanPanel.waiting")}</p>
      <div className="lan-actions">
        <button type="button" className="lan-secondary" disabled={!state.pairingInfo} onClick={() => void handleCopy()}>
          {copied ? t("lanPanel.copied") : t("lanPanel.copy")}
        </button>
        <button type="button" className="lan-ghost" onClick={handleReconnect}>{t("lanPanel.cancel")}</button>
      </div>
    </div>
  );

  const renderConnected = () => (
    <>
      {renderBanner()}
      <section className="lan-send" aria-label={t("lanPanel.send.region")}>
        <div className="lan-send-group">
          <h3>{t("lanPanel.send.what")}</h3>
          <div className="lan-segmented" role="radiogroup" aria-label={t("lanPanel.send.scope")}>
            <button
              type="button"
              role="radio"
              aria-checked={scopeChoice === "all"}
              className={scopeChoice === "all" ? "active" : ""}
              onClick={() => setScopeChoice("all")}
            >
              {t("lanPanel.send.all")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scopeChoice === "selected"}
              className={scopeChoice === "selected" ? "active" : ""}
              disabled={selectedCount === 0}
              onClick={() => setScopeChoice("selected")}
            >
              {selectedCount > 0 ? tn("lanPanel.send.selected", selectedCount, { count: selectedCount }) : t("lanPanel.send.selectedNone")}
            </button>
          </div>
          {selectedCount === 0 && (
            <p className="lan-hint">{t("lanPanel.send.selectHint")}</p>
          )}
        </div>
        <div className="lan-send-options">
          <label className="lan-switch-row">
            <span className="lan-switch-text">
              <strong>{t("lanPanel.send.includeBooks")}</strong>
              <small>
                {includeBooks
                  ? t("lanPanel.send.includeBooks.on")
                  : t("lanPanel.send.includeBooks.off")}
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
          <p className="lan-send-note">
            <span aria-hidden="true">{Icon.info}</span>
            <span>{t("lanPanel.send.note")}</span>
          </p>
        </div>
      </section>
      <div className="lan-send-footer">
        <button type="button" className="lan-primary wide" disabled={state.busy} onClick={handleSend}>
          {Icon.send}
          <span>{t("lanPanel.send")}</span>
        </button>
        <p className="lan-waiting"><span className="lan-pulse" aria-hidden />{t("lanPanel.waitPeer")}</p>
      </div>
    </>
  );

  const renderOffer = () => {
    const offer = state.offer!;
    return (
      <div className="lan-offer">
        <span className="lan-offer-icon">{Icon.incoming}</span>
        <h3>{lanOfferTitle(offer)}</h3>
        <p>{lanOfferDetail(offer)}</p>
        <p className="lan-hint">{t("lanPanel.offer.hint")}</p>
        <div className="lan-actions stacked">
          <button type="button" className="lan-primary" onClick={handleAccept}>{t("lanPanel.accept")}</button>
          <button type="button" className="lan-secondary" onClick={() => void props.session.decline()}>{t("lanPanel.decline")}</button>
        </div>
      </div>
    );
  };

  const renderProgress = () => {
    const view = lanProgressView(state.progress);
    const title = state.status === "sending" ? t("lanPanel.progress.sending")
      : state.status === "receiving" ? t("lanPanel.progress.receiving")
        : state.status === "preparing" ? t("lanPanel.progress.checking")
          : t("lanPanel.progress.writing");
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
          <span>{view.percent === null ? view.label : t("lanPanel.progress.percent", { label: view.label, percent: view.percent })}</span>
          {view.detail && <span>{view.detail}</span>}
        </p>
        {state.status === "committing" ? (
          <p className="lan-hint">{t("lanPanel.progress.committing")}</p>
        ) : (
          <button type="button" className="lan-secondary" onClick={handleReconnect}>{t("lanPanel.cancel")}</button>
        )}
      </div>
    );
  };

  const reconnectActions = (primary: "done" | "reconnect") => (
    <>
      {primary === "done" ? (
        <>
          <button type="button" className="lan-primary" onClick={closePanel}>{t("lanPanel.done")}</button>
          <button type="button" className="lan-secondary" onClick={handleReconnect}>{t("lanPanel.again")}</button>
        </>
      ) : (
        <>
          <button type="button" className="lan-primary" onClick={handleReconnect}>{t("lanPanel.reconnect")}</button>
          <button type="button" className="lan-secondary" onClick={closePanel}>{t("lanPanel.close")}</button>
        </>
      )}
    </>
  );

  const renderSendResult = () => {
    const result = state.sendResult;
    const skipped = result?.skippedBooks.length ?? 0;
    const skippedNote = skipped > 0 ? tn("lanPanel.skipped", skipped, { count: skipped }) : "";
    if (state.status === "sendComplete") {
      const imported = state.remoteCommit?.importedBookCount;
      return (
        <ResultView
          tone="success"
          title={t("lanPanel.sent.title")}
          detail={`${imported !== undefined ? tn("lanPanel.sent.imported", imported, { count: imported }) : t("lanPanel.sent.received")}${skippedNote}`}
          actions={reconnectActions("done")}
        />
      );
    }
    if (state.status === "sendUnconfirmed") {
      return (
        <ResultView
          tone="info"
          title={t("lanPanel.unconfirmed.title")}
          detail={t("lanPanel.unconfirmed.detail")}
          actions={reconnectActions("done")}
        />
      );
    }
    if (state.status === "sendCancelled") {
      return (
        <ResultView
          tone="info"
          title={t("lanPanel.notSent.title")}
          detail={t("lanPanel.notSent.detail")}
          actions={reconnectActions("reconnect")}
        />
      );
    }
    return (
      <ResultView
        tone="error"
        title={t("lanPanel.failed.title")}
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
          <h3>{t("lanPanel.connecting")}</h3>
          <button type="button" className="lan-secondary" onClick={handleReconnect}>{t("lanPanel.cancel")}</button>
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
      const imported = state.localCommit?.importedBooks.length ?? 0;
      return (
        <ResultView
          tone="success"
          title={t("lanPanel.imported.title")}
          detail={imported > 0 ? tn("lanPanel.imported.books", imported, { count: imported }) : t("lanPanel.imported.data")}
          actions={reconnectActions("done")}
        />
      );
    }
    if (state.status === "closed") {
      return (
        <ResultView
          tone={nativeError ? "error" : "info"}
          title={t("lanPanel.closed.title")}
          detail={nativeError ?? t("lanPanel.closed.detail")}
          actions={reconnectActions("reconnect")}
        />
      );
    }
    if (state.status === "connected") return renderConnected();
    return renderStart();
  };

  const subtitle = state.status === "idle"
    ? t("lanPanel.subtitle.idle")
    : state.status === "startingHost" || state.status === "hostReady"
      ? t("lanPanel.subtitle.host")
      : t("lanPanel.subtitle.active");

  // The App ends the session as soon as the panel starts closing; keep the last
  // frame on screen during the exit animation instead of flashing the start page.
  const content = props.closing && lastContentRef.current ? lastContentRef.current : (
    <>
      <header className="lan-head">
        <div className="lan-head-text">
          <h2>{t("lanPanel.title")}</h2>
          {state.status === "connected" ? (
            <p className="lan-head-status"><span className="lan-status-dot" aria-hidden="true" />{t("lanPanel.connected")}</p>
          ) : (
            <p>{subtitle}</p>
          )}
        </div>
        {state.status === "connected" && (
          <button type="button" className="lan-head-pill" onClick={handleReconnect}>{t("lanPanel.disconnect")}</button>
        )}
        <button type="button" className="lan-icon-btn lan-close" onClick={closePanel} aria-label={t("lanPanel.close.label")}>
          {Icon.close}
        </button>
      </header>
      <div className="lan-body">{renderBody()}</div>
    </>
  );
  if (!props.closing) lastContentRef.current = content;

  return (
    <div className={`lan-backdrop${props.closing ? " is-closing" : ""}`} role="presentation">
      <section className="lan-panel" role="dialog" aria-modal="true" aria-label={t("lanPanel.dialog")}>
        {content}
      </section>
    </div>
  );
}

