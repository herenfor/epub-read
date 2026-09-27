import React, { useState } from "react";
import type { Theme } from "../render/settings";
import type { PageMarginsPx, ReadingMode } from "../render/pageLayout";
import {
  presentationPatch,
  readingPresentation,
  type ReadingPresentation,
} from "../render/pagedSpread";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  RotateCcwIcon,
  WrenchIcon,
} from "./readerIcons";
import "./aaPopover.css";

export interface AaPopoverProps {
  fontSize: number;
  onFontSizeChange: (v: number) => void;
  onFontDec: () => void;
  onFontInc: () => void;

  theme: Theme;
  onThemeChange: (theme: Theme) => void;

  // 字体设置
  customFontName?: string;
  onOpenFontSettings: () => void;

  // 排版：行高预设 (1.4 紧凑, 1.7 标准, 2.0 宽松)
  lineHeight?: number;
  onLineHeightChange: (v: number) => void;

  // 排版：边距预设 (窄, 适中, 宽)
  pageMargins?: PageMarginsPx;
  onPageMarginsChange?: (margins: PageMarginsPx) => void;

  // 唯一阅读方式选项：单页 | 双页 | 滚动
  columnsPerView?: 1 | 2;
  onColumnsChange?: (columns: 1 | 2) => void;
  readingMode?: ReadingMode;
  onReadingModeChange?: (mode: ReadingMode) => void;
  /** 窄窗回退提示：当 presentation === "spread" 且 effectiveColumns === 1 时提示 */
  effectiveColumns?: 1 | 2;
  /** 一次原子更新阅读方式 */
  onPresentationChange?: (patch: { readingMode: "paginated" | "scroll"; columnsPerView?: 1 | 2 }) => void;

  // 极速无动画模式（0ms瞬翻）
  instantTurn?: boolean;
  onInstantTurnChange?: (enabled: boolean) => void;

  // 更多高级选项（折叠）
  forceHorizontal?: boolean;
  onForceHorizontalChange?: (enabled: boolean) => void;
  preloadNextChapter?: boolean;
  preloadNextChapterDisabled?: boolean;
  onPreloadNextChapterChange?: (enabled: boolean) => void;
  customCss?: string;
  onCustomCssChange?: (css: string) => void;
  onResetDefaults?: () => void;
  onToggleLog?: () => void;
  issueCount?: number;
  onOpenFile?: () => void;

  onClose: () => void;
}

export const THEME_PALETTES: Array<{
  id: Theme;
  name: string;
  bg: string;
  fg: string;
  border: string;
}> = [
  { id: "light", name: "白底", bg: "#ffffff", fg: "#1a1a1a", border: "#e2e8f0" },
  { id: "sepia", name: "羊皮纸", bg: "#fbf0d9", fg: "#5f4b32", border: "#e8dac0" },
  { id: "gray", name: "深灰", bg: "#2d2d30", fg: "#cccccc", border: "#3e3e42" },
  { id: "dark", name: "暗夜", bg: "#18181b", fg: "#e4e4e7", border: "#27272a" },
];

export const LINE_HEIGHT_PRESETS = [
  { label: "紧凑", value: 1.4 },
  { label: "标准", value: 1.7 },
  { label: "宽松", value: 2.0 },
];

export const MARGIN_PRESETS: Array<{ label: string; margins: PageMarginsPx }> = [
  { label: "窄", margins: { left: 20, right: 20, top: 20, bottom: 20 } },
  { label: "适中", margins: { left: 40, right: 40, top: 28, bottom: 28 } },
  { label: "宽", margins: { left: 64, right: 64, top: 36, bottom: 36 } },
];

export const AaPopover: React.FC<AaPopoverProps> = ({
  fontSize,
  onFontSizeChange: _onFontSizeChange,
  onFontDec,
  onFontInc,
  theme,
  onThemeChange,
  customFontName,
  onOpenFontSettings,
  lineHeight = 1.7,
  onLineHeightChange,
  pageMargins,
  onPageMarginsChange,
  columnsPerView,
  onColumnsChange,
  readingMode,
  onReadingModeChange,
  effectiveColumns,
  onPresentationChange,
  instantTurn = false,
  onInstantTurnChange,
  forceHorizontal = false,
  onForceHorizontalChange,
  preloadNextChapter = false,
  preloadNextChapterDisabled = false,
  onPreloadNextChapterChange,
  customCss = "",
  onCustomCssChange,
  onResetDefaults,
  onToggleLog,
  issueCount = 0,
  onOpenFile,
  onClose,
}) => {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cssDraft, setCssDraft] = useState(customCss);

  const presentation = readingPresentation({
    readingMode: readingMode ?? "paginated",
    columnsPerView: columnsPerView ?? 1,
  });

  const handlePresentationClick = (choice: ReadingPresentation) => {
    const patch = presentationPatch(choice);
    if (onPresentationChange) {
      onPresentationChange(patch);
    } else {
      if (patch.columnsPerView && onColumnsChange) {
        onColumnsChange(patch.columnsPerView);
      }
      if (onReadingModeChange) {
        onReadingModeChange(patch.readingMode);
      }
    }
  };

  // 判断当前边距属于哪档
  const currentMarginLevel = (() => {
    const left = pageMargins?.left ?? 40;
    if (left <= 28) return "窄";
    if (left >= 56) return "宽";
    return "适中";
  })();

  // 判断当前行高属于哪档
  const currentLineHeightLevel = (() => {
    if (lineHeight <= 1.5) return "紧凑";
    if (lineHeight >= 1.9) return "宽松";
    return "标准";
  })();

  return (
    <>
      <div className="aa-popover-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="aa-popover" role="dialog" aria-label="排版与外观设置">
        {/* 头部标题与关闭 */}
        <div className="aa-popover-header">
          <span className="aa-popover-title">排版与外观</span>
          <button
            type="button"
            className="aa-popover-close-btn"
            onClick={onClose}
            title="关闭设置 (Esc)"
            aria-label="关闭"
          >
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="aa-popover-body">
          {/* Row 1: 4 款预设主题色块 */}
          <div className="aa-section aa-theme-section" role="radiogroup" aria-label="主题配色">
            {THEME_PALETTES.map((palette) => {
              const active = theme === palette.id;
              return (
                <button
                  key={palette.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`aa-theme-card${active ? " active" : ""}`}
                  style={{
                    backgroundColor: palette.bg,
                    color: palette.fg,
                    borderColor: active ? "var(--accent, #6366f1)" : palette.border,
                  }}
                  onClick={() => onThemeChange(palette.id)}
                  title={`${palette.name}主题`}
                >
                  <span className="aa-theme-letter">Aa</span>
                  <span className="aa-theme-label">{palette.name}</span>
                </button>
              );
            })}
          </div>

          {/* Row 2: 字号步进调节 */}
          <div className="aa-section aa-control-row">
            <span className="aa-section-label">字号</span>
            <div className="aa-stepper-capsule">
              <button
                type="button"
                className="aa-step-btn"
                onClick={onFontDec}
                disabled={fontSize <= 12}
                title="减小字号 (最小 12px)"
                aria-label="减小字号"
              >
                <span className="aa-stepper-text-small">小 A</span>
              </button>
              <span className="aa-stepper-val" title={`当前字号 ${fontSize}px`}>
                {fontSize}px
              </span>
              <button
                type="button"
                className="aa-step-btn"
                onClick={onFontInc}
                disabled={fontSize >= 32}
                title="增大字号 (最大 32px)"
                aria-label="增大字号"
              >
                <span className="aa-stepper-text-large">大 A</span>
              </button>
            </div>
          </div>

          {/* Row 3: 字体选择 */}
          <div className="aa-section aa-control-row">
            <span className="aa-section-label">字体</span>
            <button
              type="button"
              className="aa-font-trigger"
              onClick={() => {
                onOpenFontSettings();
              }}
              title="配置字体与导入字体"
            >
              <span className="aa-font-name">
                {customFontName || "系统 / 书籍默认"}
              </span>
              <ChevronRightIcon size={13} className="aa-chevron" />
            </button>
          </div>

          {/* Row 4: 行高与页边距 */}
          <div className="aa-section aa-control-row">
            <span className="aa-section-label">行高</span>
            <div className="aa-segmented-capsule" role="group" aria-label="行高">
              {LINE_HEIGHT_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={`aa-segmented-btn${currentLineHeightLevel === preset.label ? " active" : ""}`}
                  onClick={() => onLineHeightChange(preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {onPageMarginsChange && (
            <div className="aa-section aa-control-row">
              <span className="aa-section-label">边距</span>
              <div className="aa-segmented-capsule" role="group" aria-label="页边距">
                {MARGIN_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={`aa-segmented-btn${currentMarginLevel === preset.label ? " active" : ""}`}
                    onClick={() => onPageMarginsChange(preset.margins)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Row 5: 唯一阅读方式选项 单页 | 双页 | 滚动 */}
          <div className="aa-section aa-control-row">
            <span className="aa-section-label">排版</span>
            <div className="aa-segmented-capsule" role="radiogroup" aria-label="排版方式">
              <button
                type="button"
                role="radio"
                aria-checked={presentation === "single"}
                className={`aa-segmented-btn${presentation === "single" ? " active" : ""}`}
                onClick={() => handlePresentationClick("single")}
              >
                单页
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={presentation === "spread"}
                className={`aa-segmented-btn${presentation === "spread" ? " active" : ""}`}
                onClick={() => handlePresentationClick("spread")}
              >
                双页
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={presentation === "scroll"}
                className={`aa-segmented-btn${presentation === "scroll" ? " active" : ""}`}
                onClick={() => handlePresentationClick("scroll")}
              >
                滚动
              </button>
            </div>
          </div>
          {presentation === "spread" && effectiveColumns === 1 && (
            <div
              className="aa-section-note"
              role="status"
              style={{
                fontSize: "11px",
                color: "var(--text-secondary, #888)",
                marginTop: "-6px",
                marginBottom: "4px",
                textAlign: "right",
                paddingRight: "4px",
              }}
            >
              窗口较窄，暂以单页显示
            </div>
          )}

          {/* 联动 Packet C: 极速瞬翻模式 */}
          {onInstantTurnChange && (
            <div className="aa-section aa-control-row aa-toggle-row">
              <span className="aa-section-label" title="开启后翻页耗时0ms，无需等待过渡动画">
                极速瞬翻 (0ms)
              </span>
              <label className="aa-switch-label">
                <input
                  type="checkbox"
                  checked={instantTurn}
                  onChange={(e) => onInstantTurnChange(e.target.checked)}
                />
                <span className="aa-switch-track" />
              </label>
            </div>
          )}

          {/* 折叠区：更多高级设置 */}
          <div className="aa-advanced-container">
            <button
              type="button"
              className="aa-advanced-toggle"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              aria-expanded={advancedOpen}
            >
              <span>更多高级设置</span>
              {advancedOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            </button>

            {advancedOpen && (
              <div className="aa-advanced-body">
                {onForceHorizontalChange && (
                  <div className="aa-advanced-row">
                    <span>强制竖排转横排</span>
                    <label className="aa-switch-label">
                      <input
                        type="checkbox"
                        checked={forceHorizontal}
                        onChange={(e) => onForceHorizontalChange(e.target.checked)}
                      />
                      <span className="aa-switch-track" />
                    </label>
                  </div>
                )}

                {onPreloadNextChapterChange && (
                  <div className="aa-advanced-row">
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span>高性能</span>
                      <span style={{ fontSize: 11, color: "var(--color-error, #e53935)", lineHeight: 1.2 }}>
                        对硬件要求较高
                      </span>
                    </div>
                    <label className="aa-switch-label">
                      <input
                        type="checkbox"
                        checked={preloadNextChapter}
                        disabled={preloadNextChapterDisabled}
                        onChange={(e) => onPreloadNextChapterChange(e.target.checked)}
                      />
                      <span className="aa-switch-track" />
                    </label>
                  </div>
                )}

                {onCustomCssChange && (
                  <div className="aa-css-editor-section">
                    <span className="aa-css-label">自定义 CSS</span>
                    <textarea
                      className="aa-css-textarea"
                      rows={3}
                      placeholder="/* 自定义注入 CSS */"
                      value={cssDraft}
                      onChange={(e) => setCssDraft(e.target.value)}
                    />
                    {cssDraft !== customCss && (
                      <button
                        type="button"
                        className="aa-btn-save-css"
                        onClick={() => onCustomCssChange(cssDraft)}
                      >
                        保存并应用 CSS
                      </button>
                    )}
                  </div>
                )}

                <div className="aa-advanced-actions">
                  {onOpenFile && (
                    <button
                      type="button"
                      className="aa-mini-action-btn"
                      onClick={onOpenFile}
                      title="打开并导入书籍"
                    >
                      <span>导入书籍</span>
                    </button>
                  )}
                  {onToggleLog && (
                    <button
                      type="button"
                      className="aa-mini-action-btn"
                      onClick={onToggleLog}
                      title="打开日志与诊断"
                    >
                      <WrenchIcon size={13} />
                      <span>诊断日志{issueCount > 0 ? ` (${issueCount})` : ""}</span>
                    </button>
                  )}
                  {onResetDefaults && (
                    <button
                      type="button"
                      className="aa-mini-action-btn"
                      onClick={onResetDefaults}
                      title="恢复全部设置默认值"
                    >
                      <RotateCcwIcon size={13} />
                      <span>恢复默认</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
