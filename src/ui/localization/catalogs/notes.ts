import { defineMessages } from "../defineMessages";

/** Note editor shown after selecting text in a book. */
export const notes = defineMessages("notes", {
  "notes.edit": "编辑笔记",
  "notes.add": "添加笔记",
  "notes.closeTitled": { zh: "关闭{title}", note: "Close button label; {title} is 'Edit note' or 'Add note'." },
  "notes.placeholder": "写下此刻的想法…",
  "notes.content": "笔记内容",
  "notes.empty": "笔记内容不能为空",
  "notes.tooLong": "笔记内容不能超过 {limit} 个字符",
  "notes.cancel": "取消",
  "notes.save": "保存",
});
