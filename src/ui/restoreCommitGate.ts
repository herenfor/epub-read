/** 首次恢复的进度回写门：只控制能否写进度，不控制显示、触摸或翻页动画。 */
export interface RestoreTicket {
  readonly session: number;
  readonly request: number;
  readonly chapterPath: string;
}

export type RestorePhase = "resolving" | "located" | "unresolved" | "user-position";

export interface RestoreCommitState {
  readonly ticket: RestoreTicket;
  readonly phase: RestorePhase;
  readonly displayReady: boolean;
}

export type RestoreCommitEvent =
  | { readonly type: "display-ready"; readonly ticket: RestoreTicket }
  | { readonly type: "resolved"; readonly ticket: RestoreTicket; readonly located: boolean }
  // 必须是真实用户导航已提交的新位置；按下、RAF取样、字体重排不算。
  | { readonly type: "user-position-committed"; readonly ticket: RestoreTicket };

export function beginRestoreCommit(ticket: RestoreTicket): RestoreCommitState {
  return { ticket: { ...ticket }, phase: "resolving", displayReady: false };
}

function sameTicket(a: RestoreTicket, b: RestoreTicket): boolean {
  return a.session === b.session && a.request === b.request && a.chapterPath === b.chapterPath;
}

export function reduceRestoreCommit(
  state: RestoreCommitState,
  event: RestoreCommitEvent,
): RestoreCommitState {
  if (!sameTicket(state.ticket, event.ticket)) return state;
  if (event.type === "display-ready") return { ...state, displayReady: true };
  if (event.type === "resolved") {
    // 一次恢复只结算一次；晚到的结果不能覆盖用户已经提交的位置。
    if (state.phase !== "resolving") return state;
    return { ...state, phase: event.located ? "located" : "unresolved" };
  }
  if (!state.displayReady) return state;
  return { ...state, phase: "user-position" };
}

export function mayCommitRestoredProgress(state: RestoreCommitState): boolean {
  return state.displayReady && (state.phase === "located" || state.phase === "user-position");
}
