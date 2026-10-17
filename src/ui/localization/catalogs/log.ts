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
});
