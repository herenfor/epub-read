import { useEffect, useState, type ReactNode } from "react";
import { getRuntimeCapabilities } from "../../platform/runtimeCapabilities";
import {
  cloudSyncNative,
  type CloudSyncBook,
  type CloudSyncDevice,
  type CloudSyncFailure,
  type CloudSyncPreview,
  type CloudSyncStatus,
} from "../../platform/cloudSyncNative";
import { useUiText } from "../localization/UiLanguageProvider";
import type { PlainMessageKey } from "../localization/core";
import { CHEVRON, Icon, SettingsRow } from "../settingsRows";
import { adoptCloudSyncStatus, refreshCloudSyncStatus, runCloudSyncAction, useCloudSync } from "./cloudSyncStore";
import "./cloudSync.css";

type Translate = ReturnType<typeof useUiText>["t"];

/** Jianguoyun's documented WebDAV root; a custom server is typed in full. */
export const JIANGUOYUN_DAV_URL = "https://dav.jianguoyun.com/dav/";
const DEFAULT_REMOTE_ROOT = "EPUBReader";

const ICONS = {
  account: <Icon><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c1.2-3.6 3.8-5.5 7-5.5s5.8 1.9 7 5.5" /></Icon>,
  folder: <Icon><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.5l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /></Icon>,
  device: <Icon><rect x="6" y="3" width="12" height="18" rx="2" /><path d="M11 17.5h2" /></Icon>,
  devices: <Icon><rect x="3" y="5" width="12" height="9" rx="1.5" /><rect x="15" y="9" width="6" height="10" rx="1.2" /><path d="M6 18h7" /></Icon>,
  books: <Icon><path d="M5 4.5h5v15H5zM10 4.5h4v15h-4z" /><path d="m15 5.5 3.5-.9 3 14-3.5.9z" /></Icon>,
};

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = new Date();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === today.toDateString() ? clock : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const ERROR_TEXT: Readonly<Record<string, PlainMessageKey>> = {
  "invalid-config": "cloudSync.error.invalid-config",
  "native-bridge-unavailable": "cloudSync.error.native-bridge-unavailable",
  "credential-unavailable": "cloudSync.error.credential-unavailable",
  "credential-cleanup-failed": "cloudSync.error.credential-cleanup-failed",
  "probe-expired": "cloudSync.error.probe-expired",
  "confirmation-required": "cloudSync.error.confirmation-required",
  "space-changed": "cloudSync.error.space-changed",
  "unsupported-sync-version": "cloudSync.error.unsupported-sync-version",
  "unsupported-local-version": "cloudSync.error.unsupported-local-version",
  "storage-error": "cloudSync.error.storage-error",
  "local-state-invalid": "cloudSync.error.local-state-invalid",
  "repository-not-ready": "cloudSync.error.repository-not-ready",
  "writer-identity-conflict": "cloudSync.error.writer-identity-conflict",
  "own-file-unread": "cloudSync.error.own-file-unread",
  "invalid-data": "cloudSync.error.invalid-data",
  "event-collision": "cloudSync.error.event-collision",
  "busy": "cloudSync.error.busy",
  "cancelled": "cloudSync.error.cancelled",
};

const REMOTE_TEXT: Readonly<Record<string, PlainMessageKey>> = {
  "invalid-config": "cloudSync.remote.invalid-config",
  "authentication": "cloudSync.remote.authentication",
  "permission-denied": "cloudSync.remote.permission-denied",
  "not-found": "cloudSync.remote.not-found",
  "conflict": "cloudSync.remote.conflict",
  "locked": "cloudSync.remote.locked",
  "rate-limited": "cloudSync.remote.rate-limited",
  "quota-exceeded": "cloudSync.remote.quota-exceeded",
  "unsupported": "cloudSync.remote.unsupported",
  "unsafe-redirect": "cloudSync.remote.unsafe-redirect",
  "unsafe-creation": "cloudSync.remote.unsafe-creation",
  "invalid-response": "cloudSync.remote.invalid-response",
  "size-limit": "cloudSync.remote.size-limit",
  "timeout": "cloudSync.remote.timeout",
  "network": "cloudSync.remote.network",
  "server-error": "cloudSync.remote.server-error",
  "cancelled": "cloudSync.remote.cancelled",
  "unsupported-sync-version": "cloudSync.remote.unsupported-sync-version",
};

function textKey(table: Readonly<Record<string, PlainMessageKey>>, code: string): PlainMessageKey | undefined {
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
}

/** Fixed wording per machine code; an unknown code is shown as itself, never guessed. */
export function cloudSyncFailureText(t: Translate, failure: CloudSyncFailure): string {
  if (failure.code === "remote" && failure.remote) {
    const key = textKey(REMOTE_TEXT, failure.remote.code);
    const text = key ? t(key) : t("cloudSync.error.unknown", { code: failure.remote.code });
    return failure.remote.cleanupFailed ? `${text} ${t("cloudSync.remote.cleanupFailed")}` : text;
  }
  if (failure.code === "repository-error") return t("cloudSync.error.repository-error", { code: failure.repositoryCode ?? "?" });
  const key = textKey(ERROR_TEXT, failure.code);
  return key ? t(key) : t("cloudSync.error.unknown", { code: failure.code });
}

function ErrorLine({ failure }: { failure: CloudSyncFailure | null }) {
  const { t } = useUiText();
  if (!failure) return null;
  return <p className="shelf-settings-error cloud-sync-error" role="alert">{cloudSyncFailureText(t, failure)}</p>;
}

function Field(props: { label: string; children: ReactNode; note?: string }) {
  return <label className="cloud-sync-field">
    <span>{props.label}</span>
    {props.children}
    {props.note && <small>{props.note}</small>}
  </label>;
}

function defaultDeviceLabel(t: Translate): string {
  return getRuntimeCapabilities().platform === "android" ? t("cloudSync.defaultLabel.android") : t("cloudSync.defaultLabel.windows");
}

/**
 * Connecting: one form for Jianguoyun (address preset) or any standard
 * WebDAV server. A test reads the cloud without saving or merging anything;
 * only the explicit confirmation connects. The password lives in this form's
 * memory until it is handed to the native store, then it is cleared.
 */
function ConnectForm({ status }: { status: CloudSyncStatus }) {
  const { t } = useUiText();
  const [service, setService] = useState<"jianguoyun" | "custom">("jianguoyun");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remoteRoot, setRemoteRoot] = useState(DEFAULT_REMOTE_ROOT);
  const [deviceLabel, setDeviceLabel] = useState(() => defaultDeviceLabel(t));
  const [preview, setPreview] = useState<CloudSyncPreview | null>(null);
  const [busy, setBusy] = useState<"test" | "connect" | null>(null);
  const [failure, setFailure] = useState<CloudSyncFailure | null>(null);
  const disabled = !status.nativeReady || busy !== null;
  const address = service === "jianguoyun" ? JIANGUOYUN_DAV_URL : baseUrl.trim();

  // Any change to what was tested invalidates the preview: it must be tested again.
  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPreview(null);
    setFailure(null);
  };

  const test = async (): Promise<void> => {
    setBusy("test");
    setFailure(null);
    setPreview(null);
    const result = await runCloudSyncAction(() => cloudSyncNative.testConnection({ baseUrl: address, remoteRoot, username, appPassword: password }));
    setBusy(null);
    if (result.ok) setPreview(result.value);
    else setFailure(result.failure);
  };

  const connect = async (): Promise<void> => {
    if (!preview) return;
    setBusy("connect");
    setFailure(null);
    const result = await runCloudSyncAction(() => cloudSyncNative.connect(preview.probeId, preview.existingSpaceId !== null, deviceLabel));
    setBusy(null);
    if (result.ok) {
      setPassword("");
      setPreview(null);
      adoptCloudSyncStatus(result.value);
      return;
    }
    // A stale or changed preview must be tested and confirmed again.
    if (result.failure.code === "probe-expired" || result.failure.code === "confirmation-required" || result.failure.code === "space-changed") setPreview(null);
    setFailure(result.failure);
  };

  const ready = address !== "" && username.trim() !== "" && password !== "" && remoteRoot.trim() !== "" && deviceLabel.trim() !== "";
  return <div className="shelf-settings-card cloud-sync-form">
    <div className="shelf-settings-control">
      <span>{t("cloudSync.service")}</span>
      <div className="shelf-segmented" role="group" aria-label={t("cloudSync.service")}>
        {(["jianguoyun", "custom"] as const).map((value) => <button key={value} type="button" aria-pressed={service === value}
          className={service === value ? "active" : ""} disabled={disabled}
          onClick={() => edit(() => setService(value))("")}>{t(value === "jianguoyun" ? "cloudSync.service.jianguoyun" : "cloudSync.service.custom")}</button>)}
      </div>
    </div>
    {service === "custom" && <Field label={t("cloudSync.field.baseUrl")}>
      <input type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://example.com/dav/"
        value={baseUrl} disabled={disabled} onChange={(event) => edit(setBaseUrl)(event.target.value)} />
    </Field>}
    <Field label={t("cloudSync.field.username")}>
      <input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
        placeholder={service === "jianguoyun" ? t("cloudSync.field.username.jianguoyun") : undefined}
        value={username} disabled={disabled} onChange={(event) => edit(setUsername)(event.target.value)} />
    </Field>
    <Field label={t("cloudSync.field.password")}
      note={t(service === "jianguoyun" ? "cloudSync.field.password.jianguoyun" : "cloudSync.field.password.custom")}>
      <input type="password" autoComplete="current-password" value={password} disabled={disabled}
        onChange={(event) => edit(setPassword)(event.target.value)} />
    </Field>
    <Field label={t("cloudSync.field.remoteRoot")}>
      <input type="text" autoCapitalize="none" spellCheck={false} value={remoteRoot} disabled={disabled}
        onChange={(event) => edit(setRemoteRoot)(event.target.value)} />
    </Field>
    <Field label={t("cloudSync.field.deviceLabel")} note={t("cloudSync.field.deviceLabel.detail")}>
      <input type="text" maxLength={128} value={deviceLabel} disabled={disabled}
        onChange={(event) => { setDeviceLabel(event.target.value); setFailure(null); }} />
    </Field>
    <p className="shelf-settings-note cloud-sync-note">{t("cloudSync.passwordNote")}</p>
    <ErrorLine failure={failure} />
    {preview && <div className="cloud-sync-preview" role="status">
      <p>{preview.existingSpaceId
        ? t("cloudSync.preview.existing", { books: preview.cloudBookCount, devices: preview.devices.length })
        : t("cloudSync.preview.new")}</p>
      {preview.issues.length > 0 && <p className="cloud-sync-muted">{t("cloudSync.preview.issues", { count: preview.issues.length })}</p>}
    </div>}
    <div className="shelf-settings-actions">
      {preview
        ? <button type="button" className="is-primary" disabled={disabled || deviceLabel.trim() === ""} onClick={() => void connect()}>
          {busy === "connect" ? t("cloudSync.connecting") : t(preview.existingSpaceId ? "cloudSync.connectMerge" : "cloudSync.connectNew")}
        </button>
        : <button type="button" className="is-primary" disabled={disabled || !ready} onClick={() => void test()}>
          {busy === "test" ? t("cloudSync.testing") : t("cloudSync.test")}
        </button>}
    </div>
  </div>;
}

function phaseLine(t: Translate, status: CloudSyncStatus): string {
  switch (status.phase) {
    case "syncing": return t("cloudSync.phase.syncing");
    case "queued": return t("cloudSync.phase.queued");
    case "waiting": return status.retryAtMs ? t("cloudSync.phase.waiting", { time: formatTime(status.retryAtMs) }) : t("cloudSync.phase.queued");
    case "error": return t("cloudSync.phase.error");
    default: return status.lastSuccessAtMs ? t("cloudSync.phase.done", { time: formatTime(status.lastSuccessAtMs) }) : t("cloudSync.phase.never");
  }
}

/** The disclosure lists load when opened; they are local summaries, not a network request. */
function useOpenList<T>(load: () => Promise<T[]>, revision: unknown): [boolean, () => void, T[] | null] {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<T[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void load().then((next) => { if (!cancelled) setItems(next); }, () => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, revision]);
  return [open, () => setOpen((value) => !value), items];
}

function Disclosure({ open }: { open: boolean }) {
  return <span className={`about-disclosure${open ? " is-open" : ""}`}>{CHEVRON}</span>;
}

function ConnectedView({ status }: { status: CloudSyncStatus & { connection: NonNullable<CloudSyncStatus["connection"]> } }) {
  const { t } = useUiText();
  const connection = status.connection;
  const [confirm, setConfirm] = useState<"disconnect" | "identity" | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CloudSyncFailure | null>(null);
  const [devicesOpen, toggleDevices, devices] = useOpenList<CloudSyncDevice>(cloudSyncNative.devices, status.lastSuccessAtMs);
  const [booksOpen, toggleBooks, books] = useOpenList<CloudSyncBook>(cloudSyncNative.cloudBooks, status.lastSuccessAtMs);
  const running = status.phase === "syncing" || status.phase === "queued";
  const identityTrouble = status.lastError?.code === "writer-identity-conflict" || status.lastError?.code === "own-file-unread";

  const act = async (action: () => Promise<CloudSyncStatus>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const result = await runCloudSyncAction(action);
    setBusy(false);
    setConfirm(null);
    if (result.ok) adoptCloudSyncStatus(result.value);
    else setFailure(result.failure);
  };

  return <>
    <div className="shelf-settings-card cloud-sync-status" role="status" aria-live="polite">
      <div className="cloud-sync-status-main">
        <div className="cloud-sync-status-text">
          <strong className={status.phase === "error" ? "is-error" : ""}>{phaseLine(t, status)}</strong>
          {status.phase !== "syncing" && status.lastSuccessAtMs !== null && status.phase !== "idle" &&
            <small>{t("cloudSync.phase.done", { time: formatTime(status.lastSuccessAtMs) })}</small>}
        </div>
        {status.phase === "syncing" && <span className="about-spinner" aria-hidden="true" />}
        <div className="shelf-settings-actions">
          {running
            ? <button type="button" disabled={busy} onClick={() => void act(cloudSyncNative.cancel)}>{t("cloudSync.stop")}</button>
            : <button type="button" className="is-primary" disabled={busy} onClick={() => void act(() => cloudSyncNative.trigger("manual"))}>{t("cloudSync.syncNow")}</button>}
        </div>
      </div>
      {status.lastError && status.phase !== "syncing" && <ErrorLine failure={status.lastError} />}
      {status.pending && status.phase !== "syncing" && <p className="cloud-sync-muted">{t("cloudSync.pendingNote")}</p>}
      {status.issues.length > 0 && <p className="cloud-sync-muted">{t("cloudSync.issues", { count: status.issues.length })}</p>}
      <ErrorLine failure={failure} />
    </div>

    {identityTrouble && <div className="shelf-settings-card">
      <div className="shelf-settings-card-title">{t("cloudSync.identity.title")}</div>
      <p className="shelf-settings-note">{t("cloudSync.identity.detail")}</p>
      <div className="shelf-settings-actions">
        {confirm === "identity"
          ? <>
            <span className="cloud-sync-confirm">{t("cloudSync.identity.confirm")}</span>
            <button type="button" className="is-danger" disabled={busy} onClick={() => void act(cloudSyncNative.resetIdentity)}>{t("cloudSync.identity.reset")}</button>
            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>{t("cloudSync.cancel")}</button>
          </>
          : <button type="button" disabled={busy} onClick={() => setConfirm("identity")}>{t("cloudSync.identity.reset")}</button>}
      </div>
    </div>}

    <div className="shelf-settings-card is-list cloud-sync-list">
      <SettingsRow icon={ICONS.account} title={t("cloudSync.account")} detail={`${connection.username} · ${hostOf(connection.baseUrl)}`}
        trailing={<span />} disabled onClick={() => undefined} />
      <SettingsRow icon={ICONS.folder} title={t("cloudSync.folder")} detail={connection.remoteRoot} trailing={<span />} disabled onClick={() => undefined} />
      <SettingsRow icon={ICONS.device} title={t("cloudSync.device")} detail={connection.deviceLabel} trailing={<span />} disabled onClick={() => undefined} />
      <SettingsRow icon={ICONS.devices} title={t("cloudSync.devices")} detail={t("cloudSync.devices.count", { count: status.deviceCount })}
        expanded={devicesOpen} trailing={<Disclosure open={devicesOpen} />} onClick={toggleDevices} />
      {devicesOpen && <div className="cloud-sync-sublist">
        {devices === null ? null : devices.length === 0
          ? <p className="cloud-sync-muted">{t("cloudSync.devices.empty")}</p>
          : <ul>{devices.map((device) => <li key={device.installationId}>
            <strong>{device.deviceLabel}</strong>
            <small>{t("cloudSync.devices.item", { version: device.appVersion, time: formatTime(device.publishedAtMs) })}</small>
          </li>)}</ul>}
      </div>}
      {status.cloudOnlyBookCount > 0 && <SettingsRow icon={ICONS.books} title={t("cloudSync.cloudBooks")}
        detail={t("cloudSync.cloudBooks.count", { count: status.cloudOnlyBookCount })}
        expanded={booksOpen} trailing={<Disclosure open={booksOpen} />} onClick={toggleBooks} />}
      {status.cloudOnlyBookCount > 0 && booksOpen && <div className="cloud-sync-sublist">
        <p className="cloud-sync-muted">{t("cloudSync.cloudBooks.note")}</p>
        {books && books.length > 0 && <ul>{books.map((book) => <li key={book.contentHash}>
          <strong>{book.title || t("cloudSync.cloudBooks.untitled")}</strong>
          {book.creator && <small>{book.creator}</small>}
        </li>)}</ul>}
      </div>}
    </div>

    <div className="shelf-settings-card cloud-sync-disconnect">
      {confirm === "disconnect" && <p className="shelf-settings-note cloud-sync-note">{t("cloudSync.disconnect.confirm")}</p>}
      <div className="shelf-settings-actions">
        {confirm === "disconnect"
          ? <>
            <button type="button" className="is-danger" disabled={busy} onClick={() => void act(cloudSyncNative.disconnect)}>{t("cloudSync.disconnect")}</button>
            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>{t("cloudSync.cancel")}</button>
          </>
          : <button type="button" disabled={busy} onClick={() => setConfirm("disconnect")}>{t("cloudSync.disconnect")}</button>}
      </div>
    </div>
  </>;
}

/** A broken sidecar has no readable connection, but can still be disconnected.
 * Future versions must stay blocked; only known corruption can be isolated. */
function DisconnectedProblem({ problem }: { problem: CloudSyncFailure }) {
  const { t } = useUiText();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CloudSyncFailure | null>(null);
  const disconnect = async (): Promise<void> => {
    setBusy(true);
    const result = await runCloudSyncAction(cloudSyncNative.disconnect);
    setBusy(false);
    if (result.ok) adoptCloudSyncStatus(result.value);
    else setFailure(result.failure);
  };
  return <div className="shelf-settings-card">
    <ErrorLine failure={failure ?? problem} />
    {problem.code === "local-state-invalid" && <>
      {confirm && <p className="shelf-settings-note">{t("cloudSync.disconnect.confirm")}</p>}
      <div className="shelf-settings-actions">
        <button type="button" disabled={busy} onClick={() => confirm ? void disconnect() : setConfirm(true)}>
          {t("cloudSync.disconnect")}
        </button>
        {confirm && <button type="button" disabled={busy} onClick={() => setConfirm(false)}>{t("cloudSync.cancel")}</button>}
      </div>
    </>}
  </div>;
}

/** Settings → Sync. `active` is false for the warm-up copy, which must not call native code. */
export function CloudSyncPanel({ active }: { active: boolean }) {
  const { t } = useUiText();
  const { status, readError } = useCloudSync();
  useEffect(() => {
    if (active) void refreshCloudSyncStatus();
  }, [active]);

  return <div className="cloud-sync">
    <p className="shelf-settings-note cloud-sync-intro">{t("cloudSync.intro")}</p>
    {readError && !status && <p className="shelf-settings-error" role="alert">
      {t("cloudSync.readFailed", { error: cloudSyncFailureText(t, readError) })}</p>}
    {status?.localRecoverySaved && !status.connection && <p className="cloud-sync-muted">{t("cloudSync.recoverySaved")}</p>}
    {status && !status.nativeReady && !status.connection && <p className="shelf-settings-error">{t("cloudSync.unavailable")}</p>}
    {status && (status.connection
      ? <ConnectedView status={status as CloudSyncStatus & { connection: NonNullable<CloudSyncStatus["connection"]> }} />
      : status.phase === "error" && status.lastError
        ? <DisconnectedProblem problem={status.lastError} />
        : <ConnectForm status={status} />)}
  </div>;
}

/** The settings home row's muted line. */
export function useCloudSyncRowDetail(): string {
  const { t } = useUiText();
  const { status } = useCloudSync();
  return status?.connection ? t("cloudSync.detail.on", { host: hostOf(status.connection.baseUrl) }) : t("cloudSync.detail.off");
}
