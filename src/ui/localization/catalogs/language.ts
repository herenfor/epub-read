import { defineMessages } from "../defineMessages";

export const language = defineMessages("language", {
  "language.setting": { zh: "界面语言", note: "Settings row label for the app UI language." },
  "language.system": { zh: "跟随系统", note: "Option: use the device's language." },
  "language.zh-CN": { zh: "简体中文", note: "Always shown in its own script; do not translate." },
  "language.en": { zh: "English", note: "Always shown in its own script; do not translate." },
  "language.saveFailed": "界面语言保存失败：{error}",
});
