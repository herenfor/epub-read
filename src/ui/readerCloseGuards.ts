import type { ReaderForeground } from "./readerForeground";

/** 只有笔记模态且存在未保存内容时，统一关闭入口才需要确认。 */
export function shouldConfirmNoteDiscard(
  foreground: ReaderForeground,
  dirty: boolean,
): boolean {
  return (
    dirty &&
    foreground.kind === "modal" &&
    foreground.modal === "note-composer"
  );
}
