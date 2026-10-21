import { useId, useState } from "react";
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
import { AppUpdatePanel } from "./appUpdate/AppUpdatePanel";
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

export function AboutInfo() {
  const { t } = useUiText();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const releaseNotesPanelId = useId();
  const projection = projectAboutInfo(getAppBuildSession(), {
    version: APP_VERSION,
    edition: APP_EDITION,
  });

  if (!projection) {
    return (
      <section className="about-info" aria-label={t("about.region")}>
        <div className="about-info-unavailable">{t("about.unavailable")}</div>
      </section>
    );
  }

  const currentRelease = findReleaseNote(projection.version);

  return (
    <section className="about-info" aria-label={t("about.region")}>
      <div className="about-product">{projection.productName}</div>
      <div className="about-version-row">
        <span className="about-version">{t("about.version", { version: projection.version })}</span>
        <span className="about-edition">{projection.edition}</span>
        {currentRelease?.releasedOn && (
          <time className="about-release-date" dateTime={currentRelease.releasedOn}>
            {t("about.releasedOn", { date: currentRelease.releasedOn })}
          </time>
        )}
      </div>
      <div className="about-channel">{projection.channel}</div>

      <button
        type="button"
        className="about-release-toggle"
        aria-expanded={releaseNotesOpen}
        aria-controls={releaseNotesPanelId}
        onClick={(event) => {
          event.currentTarget.blur();
          setReleaseNotesOpen((open) => !open);
        }}
      >
        <span>{t("about.notes")}</span>
        <span className="about-release-toggle-state">{releaseNotesOpen ? t("about.collapse") : t("about.expand")}</span>
      </button>

      {releaseNotesOpen && (
        <div className="about-release-panel" id={releaseNotesPanelId}>
          {currentRelease ? (
            <ReleaseNoteItems note={currentRelease} />
          ) : (
            <p className="about-release-empty">{t("about.notesEmpty")}</p>
          )}
        </div>
      )}

      <AppUpdatePanel />
    </section>
  );
}
