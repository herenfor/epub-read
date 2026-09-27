import React, { useState } from "react";
import type { Theme } from "../render/settings";
import type { PageMarginsPx, ReadingMode } from "../render/pageLayout";
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

  // 栏数与模式
  columnsPerView: 1 | 2;
  onColumnsChange: (columns: 1 | 2) => void;
  readingMode: ReadingMode;
  onReadingModeChange: (mode: ReadingMode) => void;

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

          {/* Row 5: 栏数与翻页模式 */}
          <div className="aa-section aa-control-row">
            <span className="aa-section-label">栏数</span>
            <div className="aa-segmented-capsule" role="group" aria-label="正文栏数">
              <button
                type="button"
                className={`aa-segmented-btn${columnsPerView === 1 ? " active" : ""}`}
                onClick={() => onColumnsChange(1)}
              >
                单栏
              </button>
              <button
                type="button"
                className={`aa-segmented-btn${columnsPerView === 2 ? " active" : ""}`}
                onClick={() => onColumnsChange(2)}
              >
                双栏
              </button>
            </div>
          </div>

          <div className="aa-section aa-control-row">
            <span className="aa-section-label">模式</span>
            <div className="aa-segmented-capsule" role="group" aria-label="阅读模式">
              <button
                type="button"
                className={`aa-segmented-btn${readingMode === "paginated" ? " active" : ""}`}
                onClick={() => onReadingModeChange("paginated")}
              >
                分页
              </button>
              <button
                type="button"
                className={`aa-segmented-btn${readingMode === "scroll" ? " active" : ""}`}
                onClick={() => onReadingModeChange("scroll")}
              >
                滚动
              </button>
            </div>
          </div>

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
                    <span>预载相邻章节</span>
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
