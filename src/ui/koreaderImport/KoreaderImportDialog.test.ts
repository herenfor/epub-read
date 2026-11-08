import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../../test/reactDomHarness";
import { KoreaderImportDialog, type KoreaderImportDialogProps } from "./KoreaderImportDialog";
import { canConfirmKoreader, splitKoreaderBooks, type KoreaderImportState, type KoreaderLocalBook, type KoreaderPreview } from "./koreaderImportModel";

const book = (id: string, basis: KoreaderLocalBook["basis"], progressPct: number | null = null): KoreaderLocalBook =>
  ({ id, title: `书${id}`, author: "", progressPct, progressUpdatedAtMs: null, basis });
const sidecar = { label: "metadata.epub.lua", title: "书名", author: null };
const books = [book("a", null), book("b", "title", 30), book("c", "partial-md5")];
const preview = (patch: Partial<KoreaderPreview> = {}): KoreaderPreview => ({
  bookId: "b",
  koreader: { progressPct: 62, updatedAtMs: null },
  local: { progressPct: 30, updatedAtMs: null },
  target: { spineIndex: 2, chapterTitle: "第三章", excerpt: "原文片段" },
  status: { kind: "ready" },
  ...patch,
});

async function mount(state: KoreaderImportState) {
  const dom = createReactDomHarness();
  const props: KoreaderImportDialogProps = {
    state, onChoose: vi.fn(), onNext: vi.fn(), onBack: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
  };
  await dom.render(createElement(KoreaderImportDialog, props));
  const button = (text: string) => Array.from(dom.container.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  return { dom, props, button };
}

describe("KOReader import model", () => {
  it("orders digest candidates before title candidates and keeps the rest as manual choices", () => {
    const split = splitKoreaderBooks(books);
    expect(split.candidates.map((b) => b.id)).toEqual(["c", "b"]);
    expect(split.others.map((b) => b.id)).toEqual(["a"]);
  });

  it("confirms only a ready preview made for the book still chosen", () => {
    const base = { kind: "preview" as const, sidecar, books, chosen: "b" };
    expect(canConfirmKoreader({ ...base, preview: preview() })).toBe(true);
    expect(canConfirmKoreader({ ...base, chosen: "c", preview: preview() })).toBe(false);
    expect(canConfirmKoreader({ ...base, preview: preview({ status: { kind: "same" } }) })).toBe(false);
    expect(canConfirmKoreader({ ...base, preview: preview({ status: { kind: "blocked", reason: "node-missing" } }) })).toBe(false);
  });
});

describe("KoreaderImportDialog", () => {
  it("needs a chosen local book before moving on, and reports the pick", async () => {
    const { dom, props, button } = await mount({ kind: "choose", sidecar, books, chosen: null });
    try {
      expect(button("下一步")!.disabled).toBe(true);
      const radios = dom.container.querySelectorAll<HTMLInputElement>("input[type=radio]");
      expect(radios).toHaveLength(2);
      await dom.click(radios[0]);
      expect(props.onChoose).toHaveBeenCalledWith("c");
    } finally {
      await dom.dispose();
    }
  });

  it("shows both positions with an unknown time and the landing excerpt, then confirms", async () => {
    const { dom, props, button } = await mount({ kind: "preview", sidecar, books, chosen: "b", preview: preview() });
    try {
      const text = dom.container.textContent ?? "";
      expect(text).toContain("约 62% · 时间未知");
      expect(text).toContain("约 30% · 时间未知");
      expect(text).toContain("原文片段");
      await dom.click(button("替换进度")!);
      expect(props.onConfirm).toHaveBeenCalledTimes(1);
      await dom.click(button("取消")!);
      expect(props.onCancel).toHaveBeenCalledTimes(1);
    } finally {
      await dom.dispose();
    }
  });

  it("explains a blocked preview, hides its landing place and keeps confirm off", async () => {
    const { dom, button } = await mount({
      kind: "preview", sidecar, books, chosen: "b",
      preview: preview({ status: { kind: "blocked", reason: "other", code: "xpointer-weird" } }),
    });
    try {
      expect(dom.container.querySelector("[role=alert]")?.textContent).toContain("xpointer-weird");
      expect(dom.container.textContent).not.toContain("原文片段");
      expect(button("替换进度")!.disabled).toBe(true);
    } finally {
      await dom.dispose();
    }
  });

  it("cannot cancel while committing", async () => {
    const { dom, button } = await mount({ kind: "working", step: "committing", sourceLabel: "metadata.epub.lua", done: 0, total: 0 });
    try {
      expect(button("取消")!.disabled).toBe(true);
    } finally {
      await dom.dispose();
    }
  });
});
