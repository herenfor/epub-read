import { defineMessages } from "../defineMessages";

/** Floating progress card/pill while books are imported. */
export const importProgress = defineMessages("importProgress", {
  "importProgress.starting": "正在开始导入…",
  "importProgress.committing": "正在保存到书库…",
  "importProgress.processed": { zh: "已处理 {completed}/{total}", max: 20 },
  "importProgress.preparing": "正在准备…",
  "importProgress.expand": { zh: "展开导入进度：{status}", note: "Accessible label of the collapsed pill." },
  "importProgress.region": "导入进度",
  "importProgress.title": { zh: "正在导入", max: 14 },
  "importProgress.collapse": "收起导入进度",
  "importProgress.cancelRequested": "已请求取消，等待任务结束…",
  "importProgress.tooLate": "提交已开始，继续等待结果…",
  "importProgress.cancel": { zh: "取消", max: 10 },
  "importProgress.canceling": { zh: "取消中…", max: 10 },
});
