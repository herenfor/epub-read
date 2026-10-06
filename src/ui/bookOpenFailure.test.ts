import { expect, it } from "vitest";
import { bookOpenErrorMessage, describeBookOpenFailure } from "./bookOpenFailure";

it("开书保护保留原生字符串和结构化错误原因，不显示 undefined", () => {
  for (const error of ["书库中没有这本书", new Error("权限不足"), { code: "storage-error", message: "磁盘不可写" }]) {
    expect(bookOpenErrorMessage(error)).toBe(typeof error === "string" ? error : error.message);
  }
  expect(bookOpenErrorMessage(undefined)).toContain("未收到具体错误原因");
});

it("开书保护仅在确认源文件缺失或内容变化时标记不可用", () => {
  for (const error of ["源 EPUB 已变化或丢失；请重新导入或重新定位", "源 EPUB 在打开期间发生了变化；未将旧进度应用到新内容"]) {
    const failure = describeBookOpenFailure(error);
    expect(failure.sourceUnavailable).toBe(true);
    expect(failure.message).toContain("原书进度和笔记已保留");
  }
  for (const error of ["书库中没有这本书", "读取结果已过期：源文件绑定已变化", { message: "书库写入锁已损坏" }, "无法读取源 EPUB：Permission denied"]) {
    expect(describeBookOpenFailure(error).sourceUnavailable).toBe(false);
  }
});

it("开书保护拒绝把另一版本重绑到旧书，并给出独立导入的办法", () => {
  const failure = describeBookOpenFailure("选择的 EPUB 内容与目标书籍不一致，未重新绑定");
  expect(failure.message).toContain("导入为另一版本");
  expect(failure.sourceUnavailable).toBe(false);
});
