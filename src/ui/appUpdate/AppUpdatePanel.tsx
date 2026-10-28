import type { ReactNode } from "react";
import { useUiText } from "../localization/UiLanguageProvider";
import type { PlainMessageKey } from "../localization/core";
import { Icon, SettingsRow, SettingsSwitchRow } from "../settingsRows";
import {
  abandonUpdate,
  checkForUpdatesNow,
  installUpdate,
  openExternalPage,
  openInstallPermission,
  setAutoCheckUpdates,
  skipUpdateVersion,
  startUpdateDownload,
  useAppUpdate,
  type UpdateFailure,
} from "./appUpdateStore";
import "./appUpdate.css";

const FAILURE_KEYS: Readonly<Record<UpdateFailure, PlainMessageKey>> = {
  unavailable: "about.update.failed.unavailable",
  download: "about.update.failed.download",
  verify: "about.update.failed.verify",
  save: "about.update.failed.save",
  install: "about.update.failed.install",
};

const ICONS = {
  check: <Icon><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></Icon>,
};

function formatCheckedAt(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Action(props: { primary?: boolean; onClick(): void; children: ReactNode }) {
  return <button type="button" className={`app-update-btn${props.primary ? " is-primary" : ""}`}
    onClick={(event) => { event.currentTarget.blur(); props.onClick(); }}>{props.children}</button>;
}

/**
 * The waiting version, under the app's name in the About card: one line of
 * text, the action this copy supports, and while downloading a hairline of
 * progress. Nothing when this copy is current.
 */
export function AppUpdateNotice() {
  const { t } = useUiText();
  const update = useAppUpdate();
  const release = update.release;
  if (!release) return null;
  const { flow } = update;
  const inApp = update.asset !== null && (update.kind === "installer" || update.kind === "android");
  const openPage = () => openExternalPage(release.htmlUrl);
  const date = release.publishedAt.slice(0, 10);

  let line: ReactNode = t("about.releasedOn", { date });
  let note: ReactNode = null;
  let actions: ReactNode;
  let percent: number | null | undefined;
  if (!inApp) {
    actions = <Action primary onClick={openPage}>{t("about.update.goDownload")}</Action>;
  } else if (flow.step === "downloading") {
    percent = flow.total ? Math.min(100, Math.round((flow.received / flow.total) * 100)) : null;
    line = percent === null ? t("about.update.downloading") : t("about.update.downloadingPercent", { percent });
    actions = <Action onClick={abandonUpdate}>{t("about.update.cancel")}</Action>;
  } else if (flow.step === "needsPermission") {
    note = t("about.update.permission");
    actions = <Action primary onClick={openInstallPermission}>{t("about.update.allow")}</Action>;
  } else if (flow.step === "ready") {
    line = t("about.update.ready");
    actions = <>
      <Action onClick={abandonUpdate}>{t("about.update.cancel")}</Action>
      <Action primary onClick={() => void installUpdate()}>
        {update.kind === "installer" ? t("about.update.installRestart") : t("about.update.install")}
      </Action>
    </>;
  } else if (flow.step === "installing") {
    line = t("about.update.installing");
    actions = null;
  } else if (flow.step === "failed") {
    note = <span className="is-error">{t(FAILURE_KEYS[flow.reason])}</span>;
    actions = flow.reason === "unavailable"
      ? <Action primary onClick={openPage}>{t("about.update.goDownload")}</Action>
      : <Action primary onClick={() => void startUpdateDownload()}>{t("about.update.retry")}</Action>;
  } else {
    actions = <Action primary onClick={() => void startUpdateDownload()}>{t("about.update.download")}</Action>;
  }

  const busy = flow.step === "downloading" || flow.step === "installing";
  // The browser stays a way out whenever the in-app path is stuck.
  const browserFallback = inApp && (flow.step === "needsPermission" || (flow.step === "failed" && flow.reason !== "unavailable"));
  return <div className="about-update" role="status">
    <div className="about-update-main">
      <div className="about-update-text">
        <strong>{t("about.update.available", { version: release.version })}</strong>
        <small>{line}</small>
      </div>
      {actions && <div className="about-update-actions">{actions}</div>}
    </div>
    {percent !== undefined && <div className="about-update-progress" role="progressbar" aria-label={t("about.update.downloading")}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <span style={{ width: `${percent ?? 8}%` }} />
    </div>}
    {note && <p className="about-update-note">{note}</p>}
    <div className="about-update-links">
      <button type="button" onClick={openPage}>{t("about.update.viewNotes")}</button>
      {browserFallback && <button type="button" onClick={openPage}>{t("about.update.browser")}</button>}
      {!busy && <button type="button" onClick={() => skipUpdateVersion(release.version)}>{t("about.update.skip")}</button>}
    </div>
  </div>;
}

/** "Check for updates" and the auto-check switch, as rows of the About list. */
export function AppUpdateRows() {
  const { t } = useUiText();
  const update = useAppUpdate();
  const status = update.checking ? t("about.update.checking")
    : update.manualResult === "failed" ? t("about.update.checkFailed")
    : update.manualResult === "latest" ? t("about.update.latest")
    : update.lastSuccessAt ? t("about.update.lastChecked", { time: formatCheckedAt(update.lastSuccessAt) })
    : t("about.checkUpdates.detail");
  return <>
    <SettingsRow icon={ICONS.check} title={t("about.checkUpdates")} disabled={update.checking}
      detail={<span aria-live="polite">{status}</span>}
      trailing={update.checking ? <span className="about-spinner" aria-hidden="true" /> : <span className="about-trailing-gap" />}
      onClick={() => void checkForUpdatesNow()} />
    {update.kind !== null && update.kind !== "unsupported" &&
      <SettingsSwitchRow title={t("about.update.autoCheck")} detail={t("about.update.autoCheck.detail")}
        checked={update.autoCheck} onChange={setAutoCheckUpdates} />}
  </>;
}
