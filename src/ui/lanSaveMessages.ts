import type { AndroidLanScanStatus } from "../platform/androidLanScanBridge";
import type { LanOfferSummary, LanProgress } from "../platform/lanSaveNativeBridge";
import { currentUiLocale, uiPlural, uiText } from "./localization/UiLanguageProvider";
import type { PlainMessageKey } from "./localization/core";

/**
 * User-facing wording for LAN transfer.
 *
 * Native errors carry technical messages (TLS, JSON, file paths). The panel
 * never shows them: every text here is derived from the stable error code and
 * the step the user was taking. The one exception is a version explanation on
 * `protocol-mismatch`, which the backend writes for the user (upgrade vs. use
 * a save file) and the generic sentence would lose.
 */
export type LanUserStep = "host" | "join" | "send" | "receive";

export function formatLanBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

export function lanErrorText(code: string | null, step: LanUserStep | null, nativeMessage?: string | null): string {
  switch (code) {
    case "lan-unreachable":
      return uiText("lan.error.unreachable");
    case "pin-mismatch":
    case "token-mismatch":
    case "expired":
      return uiText("lan.error.expired");
    case "invalid-request":
    case "invalid-data":
      return step === "join"
        ? uiText("lan.error.invalidLink")
        : uiText("lan.error.invalidData");
    case "busy":
      return uiText("lan.error.busy");
    case "network":
      return uiText("lan.error.network");
    case "secure-error":
      return uiText("lan.error.secure");
    case "storage-error":
      return step === "send"
        ? uiText("lan.error.readBooks")
        : uiText("lan.error.save");
    case "insufficient-space":
      return step === "send"
        ? uiText("lan.error.spaceSend")
        : uiText("lan.error.spaceReceive");
    case "metadata-too-large":
      return uiText("lan.error.metadataTooLarge");
    case "protocol-mismatch": {
      const message = nativeMessage?.trim();
      // The backend writes this explanation in Chinese; other UI languages use the generic sentence.
      if (currentUiLocale() === "zh-CN" && message && message.includes("版本") && message.length <= 80) {
        return /[。！？]$/.test(message) ? message : `${message}。`;
      }
      return uiText("lan.error.protocol");
    }
    case "not-found":
    case "invalid-state":
      return uiText("lan.error.ended");
    case "cancelled":
      return uiText("lan.error.cancelled");
    case "unsupported-platform":
      return uiText("lan.error.unsupported");
    default:
      return uiText("lan.error.generic");
  }
}

/** Plain explanation for a scanner outcome other than a successful scan. */
export function lanScanText(status: AndroidLanScanStatus | "failed"): string | null {
  switch (status) {
    case "scanned":
    case "cancelled":
      return null;
    case "permission-denied":
      return uiText("lan.scan.permission");
    case "no-camera":
      return uiText("lan.scan.noCamera");
    case "camera-error":
      return uiText("lan.scan.cameraError");
    default:
      return uiText("lan.scan.failed");
  }
}

const PHASE_LABELS: Record<string, PlainMessageKey> = {
  preparing: "lan.phase.preparing",
  reading: "lan.phase.reading",
  extracting: "lan.phase.extracting",
  writing: "lan.phase.writing",
  finalizing: "lan.phase.finalizing",
  copying: "lan.phase.copying",
  committing: "lan.phase.committing",
  receiving: "lan.phase.receiving",
};

export interface LanProgressView {
  label: string;
  /** 0–100 when the total is known, otherwise null (indeterminate bar). */
  percent: number | null;
  detail: string | null;
}

export function lanProgressView(progress: LanProgress | null): LanProgressView {
  if (!progress) return { label: uiText("lan.phase.preparing"), percent: null, detail: null };
  const label = uiText(PHASE_LABELS[progress.phase] ?? "lan.phase.working");
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100)));
    return {
      label,
      percent,
      detail: uiText("lan.progress.bytes", { done: formatLanBytes(progress.processedBytes), total: formatLanBytes(progress.totalBytes) }),
    };
  }
  return {
    label,
    percent: null,
    detail: progress.processedBytes > 0 ? uiText("lan.progress.processed", { done: formatLanBytes(progress.processedBytes) }) : null,
  };
}

export function lanOfferTitle(offer: LanOfferSummary): string {
  return offer.bookCount > 0 ? uiPlural("lan.offer.books", offer.bookCount, { count: offer.bookCount }) : uiText("lan.offer.settings");
}

export function lanOfferDetail(offer: LanOfferSummary): string {
  if (!offer.includeBooks) {
    return uiText("lan.offer.dataOnly", { size: formatLanBytes(offer.archiveBytes) });
  }
  const attached = uiText("lan.offer.attached", { count: offer.attachedBookCount });
  const reused = offer.reusedBookCount > 0 ? uiText("lan.offer.reused", { count: offer.reusedBookCount }) : "";
  const skipped = offer.skippedBookCount > 0
    ? uiText("lan.offer.skipped", { count: offer.skippedBookCount })
    : "";
  return uiText("lan.offer.summary", { count: offer.bookCount, attached, reused, skipped });
}
