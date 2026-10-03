import type { ChapterState } from "../render/paginator";

export type ReaderLoadFeedbackKind = "loading" | "empty" | "error";

export interface ReaderLoadFeedback {
  kind: ReaderLoadFeedbackKind;
  text: string;
}

export interface ReaderLoadFeedbackInput {
  /** Reader session is mounted with a parsed book. */
  visible: boolean;
  /** Existing final display-ready boundary; never approximated by a timer. */
  displayReady: boolean;
  /** First正文可见 has completed in this opened-book session. */
  displayedOnce: boolean;
  /** Authoritative chapter state emitted by the paginator. */
  chapter: ChapterState;
}

/**
 * Read-only projection of existing application state for small loading feedback.
 * It never advances state, never authenticates a chapter as visible, and keeps
 * the original error/empty terminal labels.
 */
export function resolveReaderLoadFeedback(
  input: ReaderLoadFeedbackInput,
): ReaderLoadFeedback | null {
  if (!input.visible) return null;
  if (input.chapter.status === "error") {
    return { kind: "error", text: `章节加载失败：${input.chapter.message}` };
  }
  if (input.chapter.status === "ready" && input.chapter.empty) {
    return { kind: "empty", text: "本章无可显示内容" };
  }
  if (input.displayReady) return null;
  if (!input.displayedOnce) {
    return { kind: "loading", text: "准备阅读位置…" };
  }
  if (input.chapter.status === "loading") {
    return { kind: "loading", text: "正在加载章节…" };
  }
  return { kind: "loading", text: "正在准备排版…" };
}
