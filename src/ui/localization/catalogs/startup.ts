import { defineMessages } from "../defineMessages";

/** Shown before App loads (release handshake failed). Keep this catalog free of App imports. */
export const startup = defineMessages("startup", {
  "startup.mismatch.title": "发行组件不匹配",
  "startup.mismatch.body": "前端与原生后端不是同一发行版，应用已停止启动。",
  "startup.failed.title": "无法验证发行组件",
  "startup.failed.body": "原生发行版握手失败，应用已停止启动。",
});
