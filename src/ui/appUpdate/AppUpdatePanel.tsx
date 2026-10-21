import type { ReactNode } from "react";
import { useUiText } from "../localization/UiLanguageProvider";
import type { PlainMessageKey } from "../localization/core";
import { SettingsSwitch } from "../ReadingSettings";
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
  type AppUpdateView,
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

function formatCheckedAt(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Action(props: { primary?: boolean; disabled?: boolean; onClick(): void; children: ReactNode }) {
  return <button type="button" className={`app-update-btn${props.primary ? " is-primary" : ""}`} disabled={props.disabled}
    onClick={(event) => { event.currentTarget.blur(); props.onClick(); }}>{props.children}</button>;
}

/** The "new version" card: what to press depends on how this copy was installed. */
function UpdateCard({ update }: { update: AppUpdateView }) {
  const { t } = useUiText();
  const release = update.release!;
  const { flow } = update;
  const inApp = update.asset !== null && (update.kind === "installer" || update.kind === "android");
  const openPage = () => openExternalPage(release.htmlUrl);
  const date = release.publishedAt.slice(0, 10);

  let status: ReactNode = null;
  let actions: ReactNode;
  if (!inApp) {
    actions = <Action primary onClick={openPage}>{t("about.update.goDownload")}</Action>;
  } else if (flow.step === "downloading") {
    const percent = flow.total ? Math.min(100, Math.round((flow.received / flow.total) * 100)) : null;
    status = <div className="app-update-progress" role="progressbar" aria-label={t("about.update.downloading")}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <span style={{ width: `${percent ?? 0}%` }} />
    </div>;
    actions = <>
      <span className="app-update-status">{percent === null ? t("about.update.downloading") : t("about.update.downloadingPercent", { percent })}</span>
      <Action onClick={abandonUpdate}>{t("about.update.cancel")}</Action>
    </>;
  } else if (flow.step === "needsPermission") {
    status = <p className="app-update-note">{t("about.update.permission")}</p>;
    actions = <>
      <Action primary onClick={openInstallPermission}>{t("about.update.allow")}</Action>
      <Action onClick={openPage}>{t("about.update.browser")}</Action>
    </>;
  } else if (flow.step === "ready") {
    actions = <>
      <Action primary onClick={() => void installUpdate()}>
        {update.kind === "installer" ? t("about.update.installRestart") : t("about.update.install")}
      </Action>
      <Action onClick={abandonUpdate}>{t("about.update.cancel")}</Action>
    </>;
  } else if (flow.step === "installing") {
    actions = <span className="app-update-status">{t("about.update.installing")}</span>;
  } else if (flow.step === "failed") {
    status = <p className="app-update-note is-error">{t(FAILURE_KEYS[flow.reason])}</p>;
    actions = flow.reason === "unavailable"
      ? <Action primary onClick={openPage}>{t("about.update.goDownload")}</Action>
      : <>
        <Action primary onClick={() => void startUpdateDownload()}>{t("about.update.retry")}</Action>
        <Action onClick={openPage}>{t("about.update.browser")}</Action>
      </>;
  } else {
    actions = <Action primary onClick={() => void startUpdateDownload()}>{t("about.update.download")}</Action>;
  }

  const busy = flow.step === "downloading" || flow.step === "installing";
  return <div className="app-update-card" role="status">
    <div className="app-update-head">
      <strong>{t("about.update.available", { version: release.version })}</strong>
      <time dateTime={date}>{t("about.releasedOn", { date })}</time>
    </div>
    {status}
    <div className="app-update-actions">{actions}</div>
    <div className="app-update-links">
      <button type="button" onClick={openPage}>{t("about.update.viewNotes")}</button>
      {!busy && <button type="button" onClick={() => skipUpdateVersion(release.version)}>{t("about.update.skip")}</button>}
    </div>
  </div>;
}

/** About section's update area: the card when a version is waiting, the manual check and the auto-check switch. */
export function AppUpdatePanel() {
  const { t } = useUiText();
  const update = useAppUpdate();
  const line = update.checking ? t("about.update.checking")
    : update.manualResult === "failed" ? t("about.update.checkFailed")
    : update.manualResult === "latest" ? t("about.update.latest")
    : update.lastSuccessAt ? t("about.update.lastChecked", { time: formatCheckedAt(update.lastSuccessAt) })
    : t("about.checkUpdates.detail");
  return <div className="app-update">
    {update.release && <UpdateCard update={update} />}
    <button type="button" className="about-releases-link" disabled={update.checking}
      onClick={(event) => { event.currentTarget.blur(); void checkForUpdatesNow(); }}>
      <span>
        <strong>{t("about.checkUpdates")}</strong>
        <small aria-live="polite">{line}</small>
      </span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
      </svg>
    </button>
    {update.kind !== null && update.kind !== "unsupported" && <div className="app-update-auto">
      <SettingsSwitch label={t("about.update.autoCheck")} checked={update.autoCheck} onChange={setAutoCheckUpdates} />
      <small>{t("about.update.autoCheck.detail")}</small>
    </div>}
    <button type="button" className="app-update-releases" onClick={() => openExternalPage()}>{t("about.update.releasesPage")}</button>
  </div>;
}
