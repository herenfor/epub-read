import { useState } from "react";
import { APP_EDITION } from "../config/edition";
import type { AppEdition } from "../config/editionValue";
import { APP_VERSION } from "../config/appVersion";
import { getAppBuildSession, type AppBuildSession } from "../config/appBuildSession";
import type { AppPlatform } from "../config/platformValue";
import "./aboutInfo.css";

export interface AboutProjection {
  productName: "EPUB Reader";
  version: string;
  edition: "Core" | "AI";
  /** Narrow runtime label, e.g. Android 原生 / Web 预览. */
  channel: string;
  /** Actual session/build projection. Contains no invented commit or build time. */
  copyText: string;
}

const PLATFORM_LABELS: Record<AppPlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
  web: "Web",
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
      channel: session.platform === "web" ? "Web 预览" : `${platform} 原生`,
      copyText: [
        "EPUB Reader",
        `版本：${buildInfo.version}`,
        `Edition：${edition}`,
        `来源：原生宿主（${platform}）`,
        `Target：${buildInfo.target}`,
        `Profile：${buildInfo.profile}`,
        `Debug：${buildInfo.debug ? "是" : "否"}`,
      ].join("\n"),
    };
  }

  return {
    productName: "EPUB Reader",
    version: compiled.version,
    edition: editionLabel(compiled.edition),
    channel: "Web 预览",
    copyText: [
      "EPUB Reader",
      `版本：${compiled.version}`,
      `Edition：${editionLabel(compiled.edition)}`,
      "来源：Web 预览（前端编译版本）",
    ].join("\n"),
  };
}

async function copyVersionInfo(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") throw new Error("当前环境不支持剪贴板");
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("复制失败");
}

export function AboutInfo() {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const projection = projectAboutInfo(getAppBuildSession(), {
    version: APP_VERSION,
    edition: APP_EDITION,
  });

  if (!projection) {
    return (
      <section className="about-info" aria-label="关于">
        <div className="about-info-unavailable">版本信息不可用</div>
      </section>
    );
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await copyVersionInfo(projection.copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section className="about-info" aria-label="关于">
      <div className="about-product">{projection.productName}</div>
      <div className="about-version-row">
        <span className="about-version">版本 {projection.version}</span>
        <span className="about-edition">{projection.edition}</span>
      </div>
      <div className="about-channel">{projection.channel}</div>
      <div className="about-copy-row">
        <button type="button" className="about-copy-btn" onClick={() => void handleCopy()}>
          复制版本信息
        </button>
        {copyState !== "idle" && (
          <span
            className={`about-copy-status about-copy-status-${copyState}`}
            role="status"
            aria-live="polite"
          >
            {copyState === "copied" ? "已复制" : "复制失败"}
          </span>
        )}
      </div>
    </section>
  );
}
