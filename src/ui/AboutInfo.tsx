import { useId, useState, type ReactNode } from "react";
import { APP_EDITION } from "../config/edition";
import type { AppEdition } from "../config/editionValue";
import { APP_VERSION } from "../config/appVersion";
import { getAppBuildSession, type AppBuildSession } from "../config/appBuildSession";
import type { AppPlatform } from "../config/platformValue";
import {
  findReleaseNote,
  type ReleaseNote,
  type ReleaseNoteCategory,
} from "../config/releaseNotes";
import "./aboutInfo.css";
import { AppUpdateNotice, AppUpdateRows } from "./appUpdate/AppUpdatePanel";
import { openExternalPage } from "./appUpdate/appUpdateStore";
import { CHEVRON, Icon, SettingsRow } from "./settingsRows";
import { uiText, useUiText } from "./localization/UiLanguageProvider";
import type { PlainMessageKey } from "./localization/core";

export interface AboutProjection {
  productName: "EPUB Reader";
  version: string;
  edition: "Core" | "AI";
  /** Narrow runtime label, e.g. Android 原生 / Web 预览. */
  channel: string;
}

const PLATFORM_LABELS: Record<AppPlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
  web: "Web",
};

const RELEASE_CATEGORIES: readonly ReleaseNoteCategory[] = ["new", "improved", "fixed"];
const RELEASE_CATEGORY_KEYS: Readonly<Record<ReleaseNoteCategory, PlainMessageKey>> = {
  new: "about.category.new",
  improved: "about.category.improved",
  fixed: "about.category.fixed",
};

function editionLabel(edition: AppEdition): "Core" | "AI" {
  return edition === "ai" ? "AI" : "Core";
}

/**
 * Single projection shared by the shelf settings drawer and the mobile reader
 * "more" layer. Native sessions only trust the handshake buildInfo; browser
 * sessions use the Vite compile-time version and are always marked preview.
 */
export function projectAboutInfo(
  session: AppBuildSession | null,
  compiled: { version: string; edition: AppEdition },
): AboutProjection | null {
  if (!session) return null;

  const edition = editionLabel(session.edition);
  if (session.source === "desktop") {
    const buildInfo = session.buildInfo;
    if (!buildInfo) return null;
    const platform = PLATFORM_LABELS[session.platform];
    return {
      productName: "EPUB Reader",
      version: buildInfo.version,
      edition,
      channel: session.platform === "web" ? uiText("about.webPreview") : uiText("about.native", { platform }),
    };
  }

  return {
    productName: "EPUB Reader",
    version: compiled.version,
    edition: editionLabel(compiled.edition),
    channel: uiText("about.webPreview"),
  };
}

function ReleaseNoteItems({ note }: { note: ReleaseNote }) {
  const { t } = useUiText();
  if (note.items.length === 0) {
    return <p className="about-release-empty">{t("about.notesEmpty")}</p>;
  }

  return (
    <div className="about-release-items">
      {RELEASE_CATEGORIES.map((category) => {
        const items = note.items.filter((item) => item.category === category);
        if (items.length === 0) return null;
        return (
          <div className="about-release-group" key={category}>
            <div className="about-release-group-title">{t(RELEASE_CATEGORY_KEYS[category])}</div>
            <ul className="about-release-list">
              {items.map((item, index) => (
                <li key={`${category}-${index}`}>{item.text}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

const ICONS = {
  notes: <Icon><path d="M8 6h11M8 12h11M8 18h7" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></Icon>,
  releases: <Icon><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></Icon>,
};

const EXTERNAL = <svg className="shelf-settings-row-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" />
</svg>;

/**
 * The About section: one card names the app and carries the update notice,
 * one list holds every action (check, auto check, this version's notes,
 * all releases, plus any rows the page adds, such as diagnostics).
 */
export function AboutInfo({ children }: { children?: ReactNode }) {
  const { t } = useUiText();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const releaseNotesPanelId = useId();
  const projection = projectAboutInfo(getAppBuildSession(), {
    version: APP_VERSION,
    edition: APP_EDITION,
  });
  const currentRelease = projection ? findReleaseNote(projection.version) : undefined;
  const meta = projection ? [t("about.version", { version: projection.version }), projection.edition, projection.channel] : [];

  return <>
    <section className="shelf-settings-card about-card" aria-label={t("about.region")}>
      <div className="about-identity">
        <span className="about-mark" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5.5c2.7-1.2 5.3-1.2 8 .7v12.6c-2.7-1.9-5.3-1.9-8-.7z" /><path d="M20 5.5c-2.7-1.2-5.3-1.2-8 .7v12.6c2.7-1.9 5.3-1.9 8-.7z" />
          </svg>
        </span>
        <div className="about-identity-text">
          <div className="about-product">EPUB Reader</div>
          <div className="about-meta">{projection ? meta.join(" · ") : t("about.unavailable")}</div>
        </div>
      </div>
      <AppUpdateNotice />
    </section>

    <div className="shelf-settings-card is-list about-list">
      <AppUpdateRows />
      <SettingsRow icon={ICONS.notes} title={t("about.notes")}
        detail={currentRelease?.releasedOn ? t("about.releasedOn", { date: currentRelease.releasedOn }) : t("about.notesEmpty")}
        expanded={releaseNotesOpen}
        trailing={<span className={`about-disclosure${releaseNotesOpen ? " is-open" : ""}`}>{CHEVRON}</span>}
        onClick={() => setReleaseNotesOpen((open) => !open)} />
      {releaseNotesOpen && <div className="about-release-panel" id={releaseNotesPanelId}>
        {currentRelease ? <ReleaseNoteItems note={currentRelease} /> : <p className="about-release-empty">{t("about.notesEmpty")}</p>}
      </div>}
      <SettingsRow icon={ICONS.releases} title={t("about.allVersions")} detail={t("about.allVersions.detail")}
        trailing={EXTERNAL} onClick={() => openExternalPage()} />
      {children}
    </div>
  </>;
}
