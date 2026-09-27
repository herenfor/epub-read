import React from "react";

export interface ToolbarProps {
  /** 书名 */
  title?: string;
  issueCount?: number;
  onBackToShelf?: () => void;
  onHistoryBack?: () => void;
  canHistoryBack?: boolean;
  onHistoryForward?: () => void;
  canHistoryForward?: boolean;
  onOpenToc?: () => void;
  onOpenSearch?: () => void;
  onOpenNotes?: () => void;
  onOpenAssistant?: () => void;
  onToggleBookmark?: () => void;
  isBookmarked?: boolean;
  onOpenBookmarks?: (button: HTMLButtonElement) => void;
  bookmarksOpen?: boolean;
  onToggleMenu?: () => void;
  onToggleLog?: () => void;
  isPanelOpen?: boolean;
}

/**
 * @deprecated
 * PC 桌面端 Zen UI 重构（Packet A）：
 * 彻底废除所有边缘感应区（top/bottom/left/right-sensor）、孤立微手柄（left/right-handle）
 * 以及悬浮底部操作坞（toolbar-bottom-dock）。
 * 所有的核心操作与状态展示已完整统一收拢至一体化顶栏（TitleBar）。
 * 此处保留无 DOM 渲染的空壳以确保向后兼容与类型安全。
 */
export const Toolbar: React.FC<ToolbarProps> = () => {
  return null;
};
