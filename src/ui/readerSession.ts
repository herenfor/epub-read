/**
 * B3：阅读会话标志的唯一转移表。
 *
 * 原样记录 App 里各入口成组写入的标志，不改变任何语义；恢复门（restoreCommitGate）
 * 与拖动进度（scrub）各有自己的 reducer，这里只管下面五个标志。有意保留的现有差异：
 * - 拖动进度不把正文置为未就绪；本地结算/失败恢复记历史，阅读器异步取消/失败只清“导航中”。
 * - 开书时“导航中”但允许记历史（开书前的位置不进返回栈，由首个跳转自己捕获）。
 * - 同章直达只恢复就绪与记历史，不碰“导航中”。
 * - 语义锚点失败解除显示门但守住进度，直到用户真实移动或下一次正文就绪。
 */

export interface ReaderSessionFlags {
  /** 正文已就绪：快捷键、同章直达、优先级让路都看它。 */
  readonly displayReady: boolean;
  /** 本书显示过第一页：开书遮罩、加载反馈、面板预热。 */
  readonly displayedOnce: boolean;
  /** 有显式导航在途。 */
  readonly navigationPending: boolean;
  /** 当前位置还能被下一次跳转记成历史。 */
  readonly historyCaptureAllowed: boolean;
  /** 语义锚点失败后禁止写进度。 */
  readonly suppressProgress: boolean;
}

export type ReaderSessionEvent =
  /** 打开一本书，首页尚未显示。 */
  | { readonly type: "open" }
  /** 正文首次或跳转后就绪（含连续视图的目标已提交）。 */
  | { readonly type: "display-ready" }
  /** 语义锚点没找到：解除显示门，守住进度。 */
  | { readonly type: "navigation-unresolved" }
  /** 用户真实移动了位置。 */
  | { readonly type: "user-position-committed" }
  /** 显式跳转：目录、书内链接、搜索、历史前进后退、笔记、书签、换章。 */
  | { readonly type: "begin-explicit" }
  /** 开始拖动进度：不置未就绪。 */
  | { readonly type: "begin-scrub" }
  /** 拖动在本地结算或本地失败（同章分页直接结算、找不到目标章）。 */
  | { readonly type: "scrub-local-settled" }
  /** 阅读器异步报告拖动目标已到。 */
  | { readonly type: "scrub-reader-settled" }
  /** 阅读器异步报告拖动取消/失败，或章节出错时有待定拖动。 */
  | { readonly type: "scrub-reader-aborted" }
  /** 当前位置已记入历史，下一次跳转前不再重复记。 */
  | { readonly type: "history-captured" }
  /** 同章直达成功（历史前进/后退、书签、弹注锚点）。 */
  | { readonly type: "direct-settled" }
  /** 离开阅读器。 */
  | { readonly type: "leave" };

export const INITIAL_READER_SESSION: ReaderSessionFlags = {
  displayReady: false,
  displayedOnce: false,
  navigationPending: false,
  historyCaptureAllowed: true,
  suppressProgress: false,
};

export function reduceReaderSession(state: ReaderSessionFlags, event: ReaderSessionEvent): ReaderSessionFlags {
  switch (event.type) {
    case "open":
      return { ...state, displayReady: false, displayedOnce: false, navigationPending: true, historyCaptureAllowed: true };
    case "display-ready":
      return { ...state, displayReady: true, displayedOnce: true, navigationPending: false, historyCaptureAllowed: true, suppressProgress: false };
    case "navigation-unresolved":
      return { ...state, displayReady: true, navigationPending: false, historyCaptureAllowed: true, suppressProgress: true };
    case "user-position-committed":
      return { ...state, suppressProgress: false };
    case "begin-explicit":
      return { ...state, displayReady: false, navigationPending: true, historyCaptureAllowed: false };
    case "begin-scrub":
      return { ...state, navigationPending: true, historyCaptureAllowed: false };
    case "scrub-local-settled":
      return { ...state, navigationPending: false, historyCaptureAllowed: true };
    case "scrub-reader-settled":
      return { ...state, displayReady: true, navigationPending: false, historyCaptureAllowed: true };
    case "scrub-reader-aborted":
      return { ...state, navigationPending: false };
    case "history-captured":
      return { ...state, historyCaptureAllowed: false };
    case "direct-settled":
      return { ...state, displayReady: true, historyCaptureAllowed: true };
    case "leave":
      return { ...state, displayReady: false, displayedOnce: false, navigationPending: false, historyCaptureAllowed: true };
  }
}
