import { uiText } from "./localization/UiLanguageProvider";

/** Native commands may reject with a string rather than an Error. */
export function bookOpenErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error === "object" && error !== null &&
      "message" in error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return uiText("notice.openFailure.noReason");
}

export function describeBookOpenFailure(error: unknown): {
  message: string;
  sourceUnavailable: boolean;
} {
  const message = bookOpenErrorMessage(error);
  const missing = message === "本机没有这本书的源文件绑定" ||
    message === "源 EPUB 已变化或丢失；请重新导入或重新定位";
  const changed = message.startsWith("源 EPUB 在") && message.includes("发生了变化");
  const mismatch = message === "选择的 EPUB 内容与目标书籍不一致，未重新绑定";
  if (changed || mismatch) {
    return {
      message: uiText("notice.openFailure.changed", { message }),
      sourceUnavailable: changed,
    };
  }
  if (missing) {
    return {
      message: uiText("notice.openFailure.missing", { message }),
      sourceUnavailable: true,
    };
  }
  // Repository, permission and transient IPC errors are not proof of a lost source.
  return { message, sourceUnavailable: false };
}
