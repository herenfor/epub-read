import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { countCodePoints, getNoteContentError, isNoteContentSavable, NoteComposer, NOTE_CONTENT_MAX_CODE_POINTS } from "./NoteComposer";
import { shouldConfirmNoteDiscard } from "./readerCloseGuards";
import type { ReaderForeground } from "./readerForeground";

describe("NoteComposer helpers", () => {
  it("counts Unicode code points rather than UTF-16 units", () => {
    expect(countCodePoints("a😀" )).toBe(2);
  });

  it("rejects blank content and accepts the exact limit", () => {
    expect(isNoteContentSavable("   \n")).toBe(false);
    expect(isNoteContentSavable("字".repeat(NOTE_CONTENT_MAX_CODE_POINTS))).toBe(true);
    expect(isNoteContentSavable("字".repeat(NOTE_CONTENT_MAX_CODE_POINTS + 1))).toBe(false);
  });

  it("distinguishes blank and over-limit validation errors", () => {
    expect(getNoteContentError(" \n")).toBe("empty");
    expect(getNoteContentError("字".repeat(NOTE_CONTENT_MAX_CODE_POINTS + 1))).toBe("too-long");
    expect(getNoteContentError("有效笔记")).toBeNull();
  });
});


describe("NoteComposer 关闭边界", () => {
  it("点击取消通过同一 onCancel 入口，组件不再独立确认", async () => {
    const dom = createReactDomHarness();
    const onCancel = vi.fn();
    try {
      await dom.render(createElement(NoteComposer, {
        selectedText: "正文",
        initialContent: "",
        onSave: () => {},
        onCancel,
      }));
      const cancel = Array.from(dom.container.querySelectorAll("button")).find((button) => button.textContent === "取消");
      expect(cancel).not.toBeNull();
      await dom.click(cancel!);
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally {
      await dom.dispose();
    }
  });
});


describe("统一笔记关闭确认判断", () => {
  it("只在笔记模态且有未保存草稿时确认", () => {
    const noteModal = { kind: "modal", modal: "note-composer", draft: { mode: "create" } } as unknown as ReaderForeground;
    expect(shouldConfirmNoteDiscard(noteModal, true)).toBe(true);
    expect(shouldConfirmNoteDiscard(noteModal, false)).toBe(false);
    expect(shouldConfirmNoteDiscard({ kind: "none" }, true)).toBe(false);
    expect(shouldConfirmNoteDiscard({ kind: "panel", panel: "notes" }, true)).toBe(false);
  });
});
