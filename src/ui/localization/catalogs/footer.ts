import { defineMessages } from "../defineMessages";

/**
 * Reader footer and phone action bar. Page numbers count within the current
 * chapter only, so "本章" (this chapter) must survive translation.
 */
export const footer = defineMessages("footer", {
  "footer.chapterN": { zh: "第 {n} 章", note: "Fallback chapter name when a chapter has no title." },
  "footer.scrub.chapterBook": { zh: "{title} · 全书 {percent}%", note: "Scrubber tooltip: target chapter title and whole-book percent." },
  "footer.scrub.page": { zh: "第 {page} / {total} 页 · {title}", note: "Scrubber tooltip inside the current chapter." },
  "footer.chapterPercent": { zh: "本章 {percent}%", note: "Scroll mode: progress within this chapter.", max: 16 },
  "footer.mobile.page": { zh: "本章 {page}/{total} 页", note: "Phone footer, pages within this chapter. Very tight.", max: 18 },
  "footer.mobile.pageRange": { zh: "本章 {first}–{last}/{total} 页", note: "Phone footer, two-page spread within this chapter.", max: 20 },
  "footer.mobile.chapters": { zh: "{current}/{total} 章", note: "Phone footer chapter position, e.g. '437/1382 ch.'.", max: 14 },
  "footer.page": { zh: "本章 {page} / {total} 页", note: "Desktop footer, pages within this chapter." },
  "footer.pageRange": { zh: "本章 {first}–{last} / {total} 页", note: "Desktop footer, two-page spread within this chapter." },
  "footer.chapters": { zh: "第 {current}/{total} 章", note: "Desktop footer chapter position." },
  "footer.book": { zh: "全书 {progress}", note: "Whole-book progress; {progress} is like '34%'.", max: 12 },
  "footer.preparing": "准备进度…",
  "footer.region.mobile": "阅读工具与进度",
  "footer.region.desktop": "阅读进度与导览",
  "footer.scrubber": "全书阅读进度",
  "footer.progress": "阅读进度",
  "footer.actions": "阅读工具",
  "footer.action.toc.label": "目录、书签与笔记",
  "footer.action.toc": { zh: "目录", note: "Phone bottom action bar; icon + one short word.", max: 8 },
  "footer.action.search.label": "搜索正文",
  "footer.action.search": { zh: "搜索", note: "Phone bottom action bar.", max: 8 },
  "footer.action.layout.label": "外观与排版设置",
  "footer.action.layout": { zh: "排版", note: "Phone bottom action bar: typography/appearance.", max: 8 },
  "footer.action.more.label": "更多阅读操作",
  "footer.action.more": { zh: "更多", note: "Phone bottom action bar.", max: 8 },
});
