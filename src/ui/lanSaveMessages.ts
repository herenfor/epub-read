import type { AndroidLanScanStatus } from "../platform/androidLanScanBridge";
import type { LanOfferSummary, LanProgress } from "../platform/lanSaveNativeBridge";

/**
 * User-facing wording for LAN transfer.
 *
 * Native errors carry technical messages (TLS, JSON, file paths). The panel
 * never shows them: every text here is derived from the stable error code and
 * the step the user was taking.
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

export function lanErrorText(code: string | null, step: LanUserStep | null): string {
  switch (code) {
    case "lan-unreachable":
      return "连不上对方设备。请确认两台设备连着同一个 Wi‑Fi。公司、学校或酒店的网络可能不允许设备互连，可以改用手机热点。";
    case "pin-mismatch":
    case "token-mismatch":
    case "expired":
      return "二维码已失效。请在对方设备上重新显示二维码，再扫一次。";
    case "invalid-request":
    case "invalid-data":
      return step === "join"
        ? "这不是有效的连接信息。请重新扫码，或复制完整的连接信息再粘贴。"
        : "传输的数据不完整。请重新连接后再试一次。";
    case "busy":
      return "另一项导入或导出正在进行，请等它完成后再试。";
    case "network":
      return "网络连接中断了。请确认两台设备都还连着同一个 Wi‑Fi，然后重新连接。";
    case "secure-error":
      return "没能建立安全连接。请在对方设备上重新显示二维码后再试。";
    case "storage-error":
      return step === "send"
        ? "读取要发送的书籍时出错。请确认书籍文件还在原来的位置。"
        : "保存时出错。请确认设备存储空间充足。";
    case "insufficient-space":
      return step === "send"
        ? "空间不足，无法准备这次发送。请释放空间，或少选一些书。"
        : "空间不足，无法接收这次传输。请释放空间后重新连接，或让对方少选一些书。";
    case "metadata-too-large":
      return "这次阅读资料太多。请少选一些书，分批发送。";
    case "protocol-mismatch":
      return "两台设备需要更新到支持同一互传协议的版本。";
    case "not-found":
    case "invalid-state":
      return "连接已经结束了。请重新连接。";
    case "cancelled":
      return "已取消。";
    case "unsupported-platform":
      return "这台设备暂不支持局域网互传。";
    default:
      return "这次传输没有完成。请重新连接后再试一次。";
  }
}

/** Plain explanation for a scanner outcome other than a successful scan. */
export function lanScanText(status: AndroidLanScanStatus | "failed"): string | null {
  switch (status) {
    case "scanned":
    case "cancelled":
      return null;
    case "permission-denied":
      return "需要相机权限才能扫码。可以在系统设置里允许使用相机，或改用「粘贴连接信息」。";
    case "no-camera":
      return "这台设备没有可用的相机，请改用「粘贴连接信息」。";
    case "camera-error":
      return "相机暂时无法使用，可能正被其他应用占用。请稍后再试，或改用「粘贴连接信息」。";
    default:
      return "无法打开扫码，请改用「粘贴连接信息」。";
  }
}

const PHASE_LABELS: Record<string, string> = {
  preparing: "正在准备",
  reading: "正在读取",
  extracting: "正在解压",
  writing: "正在写入",
  finalizing: "即将完成",
  copying: "正在传输",
  committing: "正在写入书架",
  receiving: "正在接收",
};

export interface LanProgressView {
  label: string;
  /** 0–100 when the total is known, otherwise null (indeterminate bar). */
  percent: number | null;
  detail: string | null;
}

export function lanProgressView(progress: LanProgress | null): LanProgressView {
  if (!progress) return { label: "正在准备", percent: null, detail: null };
  const label = PHASE_LABELS[progress.phase] ?? "正在处理";
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100)));
    return {
      label,
      percent,
      detail: `${formatLanBytes(progress.processedBytes)} / ${formatLanBytes(progress.totalBytes)}`,
    };
  }
  return {
    label,
    percent: null,
    detail: progress.processedBytes > 0 ? `已处理 ${formatLanBytes(progress.processedBytes)}` : null,
  };
}

export function lanOfferTitle(offer: LanOfferSummary): string {
  return offer.bookCount > 0 ? `对方想发送 ${offer.bookCount} 本书的资料` : "对方想发送阅读设置";
}

export function lanOfferDetail(offer: LanOfferSummary): string {
  if (!offer.includeBooks) {
    return `只包含阅读进度、书签和笔记，共 ${formatLanBytes(offer.archiveBytes)}。`;
  }
  const attached = `新传 ${offer.attachedBookCount} 本书`;
  const reused = offer.reusedBookCount > 0 ? `，你已有 ${offer.reusedBookCount} 本书` : "";
  const skipped = offer.skippedBookCount > 0
    ? `；另有 ${offer.skippedBookCount} 本书没有可用文件，只同步资料`
    : "";
  return `同步 ${offer.bookCount} 本资料，${attached}${reused}${skipped}。`;
}
