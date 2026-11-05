import { defineMessages } from "../defineMessages";

/** Log and diagnostics panel. Log entries and the diagnostic dump are technical data and stay untranslated. */
export const log = defineMessages("log", {
  "log.title": { zh: "日志与诊断", max: 24 },
  "log.close": { zh: "关闭日志与诊断", note: "Accessible label of the panel's close button." },
  "log.issues.one": { zh: "{count} 个问题", note: "Badge next to the title.", max: 12 },
  "log.issues.other": { zh: "{count} 个问题", note: "Badge next to the title.", max: 12 },
  "log.ok": { zh: "正常", note: "Badge when no problems were recorded.", max: 12 },
  "log.records": "本次开书记录",
  "log.empty": "没有记录到异常问题。",
  "log.diagnostics": "渲染状态诊断",
  "log.refresh": { zh: "刷新诊断", max: 12 },
  "log.diagnostics.capturedAt": { zh: "采集时间：{time}", note: "This is a manually refreshed diagnostic snapshot, not live status." },
  "log.resourceErrorRecord": { zh: "读取错误记录：{error}", note: "Preserves the original technical read error even after the resource has recovered." },
  "log.diagnostics.pending": { zh: "（打开面板时自动采集）", note: "Placeholder before the diagnostic dump is collected." },
  "log.diagnostics.unavailable": { zh: "（阅读器未初始化）", note: "Diagnostic dump when no book page is loaded yet." },
  "log.copyDiagnostics": { zh: "复制诊断信息", note: "Button that copies app version, platform and runtime facts for an issue report. Not the log.", max: 16 },
  "log.copyDiagnostics.hint": { zh: "仅含版本、平台与运行环境，不含书籍与日志。复制后可贴进问题反馈。", note: "Explains what the copy button includes, shown next to it." },
  "log.copyDiagnostics.copied": { zh: "已复制诊断信息", max: 20 },
  "log.copyDiagnostics.unavailable": { zh: "当前环境不支持读取诊断信息。", note: "Shown in the browser build, which has no native backend." },
  "log.copyDiagnostics.collectFailed": "没能读取诊断信息，请稍后再试。",
  "log.copyDiagnostics.clipboardFailed": "没能复制到剪贴板，请再试一次。",
});
