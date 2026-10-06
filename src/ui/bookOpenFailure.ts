/** Native commands may reject with a string rather than an Error. */
export function bookOpenErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error === "object" && error !== null &&
      "message" in error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return "未收到具体错误原因，请重试；若仍失败，请保留现场反馈";
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
      message: `${message}。原书进度和笔记已保留；请选择原文件，或将修改后的文件导入为另一版本`,
      sourceUnavailable: changed,
    };
  }
  if (missing) {
    return {
      message: `${message}。原书进度和笔记已保留；可重新导入原文件，无需先删除书架记录`,
      sourceUnavailable: true,
    };
  }
  // Repository, permission and transient IPC errors are not proof of a lost source.
  return { message, sourceUnavailable: false };
}
