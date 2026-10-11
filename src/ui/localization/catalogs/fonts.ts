import { defineMessages } from "../defineMessages";

/** Reader font picker: system fonts, imported fonts and the drop zone. Font family names are never translated. */
export const fonts = defineMessages("fonts", {
  "fonts.dialog": "字体设置",
  "fonts.title": "字体设置",
  "fonts.close": "关闭字体设置",
  "fonts.current": { zh: "当前字体：{name}", note: "{name} is a font family name or 'Follow book'." },
  "fonts.followBook": "跟随书籍",
  "fonts.override": { zh: "覆盖书籍字体", note: "Switch label: apply the chosen font to all body text, even where the book sets its own font.", max: 10 },
  "fonts.override.hint": { zh: "关闭时，所选字体只替换书未指定字体的文字；开启后正文全部改用所选字体，代码与公式保留原字体。", note: "Help text under the switch." },
  "fonts.search": "搜索字体名称",
  "fonts.tab.system": { zh: "系统字体（{count}）", max: 18 },
  "fonts.tab.imported": { zh: "已导入（{count}）", max: 18 },
  "fonts.system.loading": "正在读取系统字体…",
  "fonts.system.failed": { zh: "系统字体读取失败：{error}", note: "{error} is a technical detail." },
  "fonts.unknownError": "未知错误",
  "fonts.retry": "重试",
  "fonts.unavailable": { zh: "当前设备不可用：{name}", note: "The chosen system font is missing on this device." },
  "fonts.system.none": "未找到系统字体",
  "fonts.imported.none": "尚未导入字体",
  "fonts.delete": "删除字体",
  "fonts.drop": "拖入字体文件导入",
  "fonts.importing": "正在导入字体…",
  "fonts.dropRelease": "松开以导入字体",
  "fonts.dropHint": "可拖入 TTF、OTF、WOFF 或 WOFF2 字体",
  "fonts.import": { zh: "＋ 导入字体", note: "Button; keep the plus sign." },
});
