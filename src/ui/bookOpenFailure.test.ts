import { expect, it } from "vitest";
import { bookOpenErrorMessage, describeBookOpenFailure } from "./bookOpenFailure";

it("开书保护保留原生字符串和结构化错误原因，不显示 undefined", () => {
  for (const error of ["书库中没有这本书", new Error("权限不足"), { code: "storage-error", message: "磁盘不可写" }]) {
    expect(bookOpenErrorMessage(error)).toBe(typeof error === "string" ? error : error.message);
  }
  expect(bookOpenErrorMessage(undefined)).toContain("未收到具体错误原因");
});

it("开书保护只按机器码标记源文件不可用", () => {
  for (const code of ["source-unbound", "source-missing", "source-changed", "source-unavailable"]) {
    const failure = describeBookOpenFailure({ code, message: "后端原文" });
    expect(failure.sourceUnavailable).toBe(true);
    expect(failure.message).toContain("原书进度和笔记已保留");
    expect(failure.message).not.toContain("后端原文");
  }
  expect(describeBookOpenFailure({ code: "source-unavailable", message: "" }).message).toContain("重新导入或重新定位");
});

it("开书保护不从中文报错猜原因，failed 和未知码显示原文", () => {
  for (const error of [
    "源 EPUB 已变化或丢失；请重新导入或重新定位",
    { message: "本机没有这本书的源文件绑定" },
    { code: "failed", message: "无法读取源 EPUB：Permission denied" },
    { code: "storage-error", message: "书库写入锁已损坏" },
  ]) {
    const failure = describeBookOpenFailure(error);
    expect(failure.sourceUnavailable).toBe(false);
    expect(failure.message).toBe(typeof error === "string" ? error : error.message);
  }
});

it("开书保护拒绝把另一版本重绑到旧书，并给出独立导入的办法", () => {
  const failure = describeBookOpenFailure({ code: "relink-mismatch", message: "选择的 EPUB 内容与目标书籍不一致，未重新绑定" });
  expect(failure.message).toContain("导入为另一版本");
  expect(failure.sourceUnavailable).toBe(false);
});
