import { describe, expect, it } from "vitest";
import { validateFolderNameDraft } from "./folderNameDraft";

describe("folder name form boundary", () => {
  it("reports invalid input without throwing or silently truncating it", () => {
    expect(validateFolderNameDraft(" \n ", [])).toMatchObject({ ok: false, code: "empty", count: 0 });
    const pasted = "书".repeat(41);
    expect(validateFolderNameDraft(pasted, [])).toMatchObject({ ok: false, code: "too-long", count: 41, limit: 40 });
    expect(pasted).toHaveLength(41);
  });

  it("uses the persisted code-point limit, rather than the input's UTF-16 length", () => {
    const fortyEmoji = "📚".repeat(40);
    expect(fortyEmoji.length).toBe(80);
    expect(validateFolderNameDraft(` ${fortyEmoji} `, [])).toEqual({ ok: true, name: fortyEmoji, count: 40, unchanged: false });
    expect(validateFolderNameDraft(`${fortyEmoji}📚`, [])).toMatchObject({ ok: false, code: "too-long", count: 41 });
  });

  it("checks trimmed duplicates but does not emit a rename for the current name", () => {
    expect(validateFolderNameDraft(" 分类 ", ["分类"])).toMatchObject({ ok: false, code: "duplicate" });
    expect(validateFolderNameDraft(" 分类 ", ["分类"], "分类")).toEqual({ ok: true, name: "分类", count: 2, unchanged: true });
    expect(validateFolderNameDraft(" 分类 ", ["分类"], "其他")).toMatchObject({ ok: false, code: "duplicate" });
  });
});
