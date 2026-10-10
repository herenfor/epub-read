import { defineMessages } from "../defineMessages";

export const folder = defineMessages("folder", {
  "folder.name.empty": "文件夹名称不能为空",
  "folder.name.too-long": "名称不能超过 {limit} 个字符",
  "folder.name.duplicate": "已存在同名文件夹",
  "folder.name.count": { zh: "{count}/{limit}", note: "Character counter under the folder name field." },
});
