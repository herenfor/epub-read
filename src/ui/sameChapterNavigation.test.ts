import { describe, expect, it } from "vitest";
import {
  emptyReaderNavigationHistory,
  readerHistoryBack,
  recordReaderNavigation,
  type ReaderNavigationPosition,
} from "./readerNavigationHistory";
import {
  commitDirectHistory,
  commitHistoryTransition,
  sameChapterRoute,
} from "./sameChapterNavigation";

const position = (spineIndex: number, page: number): ReaderNavigationPosition => ({
  spineIndex,
  page,
  anchor: { index: page, ratio: 0.5 },
});

describe("same-chapter navigation routing and history transactions", () => {
  it("uses direct only for the current ready chapter", () => {
    expect(
      sameChapterRoute({
        currentSpineIndex: 2,
        targetSpineIndex: 2,
        readerDisplayReady: true,
        navigationPending: false,
      })
    ).toBe("direct");
    expect(
      sameChapterRoute({
        currentSpineIndex: 2,
        targetSpineIndex: 2,
        readerDisplayReady: false,
        navigationPending: false,
      })
    ).toBe("reload");
    expect(
      sameChapterRoute({
        currentSpineIndex: 2,
        targetSpineIndex: 3,
        readerDisplayReady: true,
        navigationPending: false,
      })
    ).toBe("reload");
  });

  it("does not commit a direct history snapshot after failure", () => {
    const history = emptyReaderNavigationHistory();
    const snapshot = position(1, 4);
    expect(commitDirectHistory(history, snapshot, false)).toEqual(history);
    expect(commitDirectHistory(history, snapshot, true).back).toHaveLength(1);
  });

  it("adopts back transition only after direct success", () => {
    const current = position(0, 3);
    const history = recordReaderNavigation(
      recordReaderNavigation(emptyReaderNavigationHistory(), position(0, 1)),
      position(0, 2)
    );
    const transition = readerHistoryBack(history, current);
    expect(commitHistoryTransition(history, transition, false)).toEqual(history);
    expect(commitHistoryTransition(history, transition, true)).toEqual(transition.history);
  });

  it("forces reload route when navigation is pending during rapid concurrent clicks", () => {
    // 第一次点击正在处理中（跨章或重载尚未完成，navigationPending = true）
    // 此时用户快速并发点击同章或其他章节：必须走 reload 重新排队，绝不能走 direct 造成状态不同步
    expect(
      sameChapterRoute({
        currentSpineIndex: 1,
        targetSpineIndex: 1,
        readerDisplayReady: true,
        navigationPending: true,
      })
    ).toBe("reload");

    expect(
      sameChapterRoute({
        currentSpineIndex: 1,
        targetSpineIndex: 2,
        readerDisplayReady: true,
        navigationPending: true,
      })
    ).toBe("reload");
  });

  it("handles rapid consecutive same-chapter direct navigations safely", () => {
    let history = emptyReaderNavigationHistory();

    // 初始位置：第 1 章第 0 页
    const pos0 = position(1, 0);

    // 用户快速点击 2.1.10，direct 成功，提交 pos0
    history = commitDirectHistory(history, pos0, true);
    expect(history.back).toHaveLength(1);
    expect(history.back[0].page).toBe(0);

    // 用户在极短时间内接着点击 2.1.11，direct 成功，提交当前位置（第 1 章第 5 页）
    const pos5 = position(1, 5);
    history = commitDirectHistory(history, pos5, true);
    expect(history.back).toHaveLength(2);
    expect(history.back[1].page).toBe(5);

    // 用户再次快速点击 2.1（回到章首），提交当前位置（第 1 章第 8 页）
    const pos8 = position(1, 8);
    history = commitDirectHistory(history, pos8, true);
    expect(history.back).toHaveLength(3);
    expect(history.back.map((item) => item.page)).toEqual([0, 5, 8]);
  });

  it("prevents corrupted history during rapid cross-chapter click bursts", () => {
    let history = emptyReaderNavigationHistory();
    let historyCaptureAllowed = true;
    let navigationPending = false;

    const simulateClick = (targetSpine: number, currentSpine: number, currentPos: ReaderNavigationPosition) => {
      const route = sameChapterRoute({
        currentSpineIndex: currentSpine,
        targetSpineIndex: targetSpine,
        readerDisplayReady: !navigationPending,
        navigationPending,
      });

      if (route === "direct") {
        history = commitDirectHistory(history, currentPos, true);
      } else {
        // 跨章：只有当允许捕获时才记录快照，随后锁住
        if (historyCaptureAllowed) {
          history = recordReaderNavigation(history, currentPos);
          historyCaptureAllowed = false;
        }
        navigationPending = true;
      }
    };

    // 初始位置：第 0 章第 1 页
    const initialPos = position(0, 1);

    // 用户并发快速点击：第 1 章 -> 极短时间内快速又点了第 2 章 -> 第 3 章
    simulateClick(1, 0, initialPos);
    expect(navigationPending).toBe(true);
    expect(history.back).toHaveLength(1);
    expect(history.back[0].spineIndex).toBe(0);

    // 第二次点击（第 2 章）：此时 navigationPending 为 true，historyCaptureAllowed 为 false
    simulateClick(2, 0, position(0, 1));
    // 验证历史栈没有被中间状态污染
    expect(history.back).toHaveLength(1);

    // 第三次点击（第 3 章）：依然被保护
    simulateClick(3, 0, position(0, 1));
    expect(history.back).toHaveLength(1);
    expect(history.back[0].spineIndex).toBe(0);
  });
});
