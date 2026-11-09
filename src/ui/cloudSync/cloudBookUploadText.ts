import type { CloudBookUploadPhase, CloudBookUploadResult } from "../../platform/cloudBookUploadNative";
import type { CloudSyncFailure } from "../../platform/cloudSyncNative";
import type { useUiText } from "../localization/UiLanguageProvider";
import type { PlainMessageKey } from "../localization/core";

type UiText = ReturnType<typeof useUiText>;

/** Fixed wording per backend code; an unknown code is shown as itself, never guessed. */
const REASON: Readonly<Record<string, PlainMessageKey>> = {
  "book-not-found": "cloudSync.upload.reason.book-not-found",
  "source-unbound": "cloudSync.upload.reason.source-unbound",
  "source-missing": "cloudSync.upload.reason.source-missing",
  "source-unreadable": "cloudSync.upload.reason.source-unreadable",
  "source-changed": "cloudSync.upload.reason.source-changed",
  "unsupported-format": "cloudSync.upload.reason.unsupported-format",
  "storage-error": "cloudSync.upload.reason.storage-error",
  "timeout": "cloudSync.upload.reason.timeout",
  "cancelled": "cloudSync.upload.reason.cancelled",
  "remote-conflict": "cloudSync.upload.reason.remote-conflict",
  "space-mismatch": "cloudSync.upload.reason.space-mismatch",
  "connection-changed": "cloudSync.upload.reason.connection-changed",
  "authentication": "cloudSync.upload.reason.authentication",
  "permission-denied": "cloudSync.upload.reason.permission-denied",
  "quota-exceeded": "cloudSync.upload.reason.quota-exceeded",
  "rate-limited": "cloudSync.upload.reason.rate-limited",
  "locked": "cloudSync.upload.reason.locked",
  "network": "cloudSync.upload.reason.network",
  "server-error": "cloudSync.upload.reason.server-error",
  "unsupported": "cloudSync.upload.reason.unsupported",
  "invalid-response": "cloudSync.upload.reason.invalid-response",
  "invalid-config": "cloudSync.upload.reason.invalid-config",
  "not-found": "cloudSync.upload.reason.not-found",
  "conflict": "cloudSync.upload.reason.conflict",
  "unsafe-redirect": "cloudSync.upload.reason.unsafe-redirect",
  "unsafe-creation": "cloudSync.upload.reason.unsafe-creation",
  "size-limit": "cloudSync.upload.reason.size-limit",
};

/** Codes that stop the whole batch: the result's headline names the cause. */
const STOP_TITLE: Readonly<Record<string, PlainMessageKey>> = {
  "quota-exceeded": "cloudSync.upload.stopped.quota-exceeded",
  "authentication": "cloudSync.upload.stopped.authentication",
  "permission-denied": "cloudSync.upload.stopped.permission-denied",
  "unsupported": "cloudSync.upload.stopped.unsupported",
  "space-mismatch": "cloudSync.upload.stopped.space-mismatch",
  "connection-changed": "cloudSync.upload.stopped.connection-changed",
};

const PHASE: Readonly<Record<CloudBookUploadPhase, PlainMessageKey>> = {
  preparing: "cloudSync.upload.phase.preparing",
  checking: "cloudSync.upload.phase.checking",
  uploading: "cloudSync.upload.phase.uploading",
  verifying: "cloudSync.upload.phase.verifying",
  publishing: "cloudSync.upload.phase.publishing",
};

function own<T>(table: Readonly<Record<string, T>>, code: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
}

export function uploadReasonText(t: UiText["t"], code: string | null): string {
  if (!code) return t("cloudSync.upload.reason.notAttempted");
  const key = own(REASON, code);
  return key ? t(key) : t("cloudSync.upload.reason.unknown", { code });
}

export function uploadPhaseText(t: UiText["t"], phase: string | null): string {
  const key = phase ? own(PHASE, phase) : undefined;
  return t(key ?? "cloudSync.upload.phase.preparing");
}

/** The code that stopped a batch: the first failed book carrying a stop code. */
export function stopCode(result: CloudBookUploadResult): string | null {
  for (const book of result.books) {
    if (book.outcome === "failed" && book.code && own(STOP_TITLE, book.code)) return book.code;
  }
  return null;
}

/** One line for the whole batch, from the final result only. */
export function uploadResultTitle({ t, tn }: Pick<UiText, "t" | "tn">, result: CloudBookUploadResult): string {
  const total = result.books.length;
  const missed = result.failed + result.cancelled + result.notAttempted;
  switch (result.status) {
    case "cancelled":
      return t("cloudSync.upload.title.cancelled");
    case "stopped": {
      const code = stopCode(result);
      const key = code ? own(STOP_TITLE, code) : undefined;
      return t(key ?? "cloudSync.upload.stopped.other");
    }
    case "completed":
      if (missed === 0) return tn("cloudSync.upload.title.completed", total, { count: total });
      return tn("cloudSync.upload.title.partial", missed, { count: missed });
    default:
      return tn("cloudSync.upload.title.partial", missed, { count: missed });
  }
}

/** Command-level refusals; the rest share the sync section's wording. */
export function uploadFailureText(t: UiText["t"], failure: CloudSyncFailure, fallback: (failure: CloudSyncFailure) => string): string {
  if (failure.code === "busy") return t("cloudSync.upload.error.busy");
  if (failure.code === "connection-required") return t("cloudSync.upload.error.connection-required");
  return fallback(failure);
}

export function formatUploadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
