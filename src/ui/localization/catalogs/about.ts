import { defineMessages } from "../defineMessages";

/** About section (shelf drawer and phone reader "more" layer). Release note bodies are not in this catalog. */
export const about = defineMessages("about", {
  "about.webPreview": { zh: "Web 预览", note: "Runtime channel: running in a browser preview." },
  "about.native": { zh: "{platform} 原生", note: "Runtime channel, e.g. 'Android native'. {platform} is a product name." },
  "about.notesEmpty": "暂无此版本的说明",
  "about.region": "关于",
  "about.unavailable": "版本信息不可用",
  "about.version": { zh: "版本 {version}", max: 18 },
  "about.releasedOn": { zh: "{date} 发布", note: "{date} is YYYY-MM-DD." },
  "about.notes": "本版更新",
  "about.collapse": { zh: "收起", max: 8 },
  "about.expand": { zh: "展开", max: 8 },
  "about.category.new": { zh: "新增", note: "Release note group heading.", max: 12 },
  "about.category.improved": { zh: "改进", note: "Release note group heading.", max: 12 },
  "about.category.fixed": { zh: "修复", note: "Release note group heading.", max: 12 },
  "about.checkUpdates": "检查更新",
  "about.checkUpdates.detail": "在 GitHub 发布页下载最新版本",
});
