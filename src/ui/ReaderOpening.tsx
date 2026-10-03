import React, { useEffect, useState } from "react";
import { BookOpenIcon } from "./readerIcons";
import "./readerOpening.css";

export interface ReaderOpeningProps {
  /** 从点击开书到正文首次可见；只读既有状态，不参与就绪判定。 */
  visible: boolean;
  title: string;
  creator?: string;
  /** 当前阶段的简短说明，同时作为读屏播报。 */
  stage: string;
}

const LEAVE_MS = 240;
/** 解析完成到阅读页挂载之间可能有一两帧两个条件都不成立；短暂空档不触发离场。 */
const HIDE_DEBOUNCE_MS = 80;

/**
 * 开书过渡：一个主题色画面贯穿“解析书籍 → 准备阅读位置”两段，
 * 正文就绪后淡出，取代黑色遮罩 + 空白页 + 顶部胶囊三段式反馈。
 */
export const ReaderOpening: React.FC<ReaderOpeningProps> = ({ visible, title, creator, stage }) => {
  const [mounted, setMounted] = useState(visible);
  const [leaving, setLeaving] = useState(false);
  const [shown, setShown] = useState({ title, creator, stage });

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setLeaving(false);
      // 离场期间保留最后一帧文案，避免淡出时闪成空白标题。
      if (title) setShown({ title, creator, stage });
      return;
    }
    const leaveTimer = window.setTimeout(() => setLeaving(true), HIDE_DEBOUNCE_MS);
    const unmountTimer = window.setTimeout(() => setMounted(false), HIDE_DEBOUNCE_MS + LEAVE_MS);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(unmountTimer);
    };
  }, [visible, title, creator, stage]);

  if (!mounted) return null;

  return (
    <div
      className={`reader-opening${leaving ? " is-leaving" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy={!leaving}
    >
      <div className="reader-opening-card">
        <div className="reader-opening-mark" aria-hidden="true">
          <BookOpenIcon size={30} />
        </div>
        <div className="reader-opening-title" title={shown.title}>{shown.title}</div>
        {shown.creator && <div className="reader-opening-creator">{shown.creator}</div>}
        <div className="reader-opening-progress" aria-hidden="true" />
        <div className="reader-opening-stage">{shown.stage}</div>
      </div>
    </div>
  );
};
