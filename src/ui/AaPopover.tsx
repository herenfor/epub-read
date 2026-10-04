import React, { useState } from "react";
import { MENU_CLOSE_MS } from "./menuMotion";
import type { Theme, TurnAnimation } from "../render/settings";
import { PAGE_GAP_MAX_PX, type PageMarginsPx, type ReadingMode, type SpreadGapMode } from "../render/pageLayout";
import {
  presentationPatch,
  readingPresentation,
  type ReadingPresentation,
} from "../render/pagedSpread";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  WrenchIcon,
} from "./readerIcons";
import "./aaPopover.css";

const TURN_ANIMATION_OPTIONS: ReadonlyArray<{ value: TurnAnimation; label: string }> = [
  { value: "slide", label: "滑动" },
  { value: "fade", label: "淡入" },
  { value: "none", label: "无" },
];

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

  // 排版：行高预设 + 详细连续微调 (1.2 ~ 2.4, 步进 0.1)
  lineHeight?: number;
  onLineHeightChange: (v: number) => void;
  onResetLineHeight?: () => void;

  // 字重 (300 细体 ~ 700 粗体，或 undefined 跟随书)
  fontWeight?: number;
  onFontWeightChange?: (v: number | undefined) => void;

  // 字间距 (0 ~ 8px，或 undefined 跟随书)
  letterSpacingPx?: number;
  onLetterSpacingChange?: (v: number | undefined) => void;

  // 词/字符间距 (0 ~ 16px，或 undefined 跟随书)
  wordSpacingPx?: number;
  onWordSpacingChange?: (v: number | undefined) => void;

  // 列间距：manual 时使用 gapPx；auto 时由舒适阅读区给真实有效数字。
  gapPx?: number;
  spreadGapMode?: SpreadGapMode;
  onGapPxChange?: (gap: number) => void;
  onSpreadGapModeChange?: (mode: SpreadGapMode) => void;
  /** 当前已提交双页几何；非双页不传，UI 不猜屏宽。 */
  spreadArea?: {
    baseLeftPx: number;
    baseRightPx: number;
    marginLeftPx: number;
    marginRightPx: number;
    gapPx: number;
  };

  // 界面缩放 (0.85, 1.0, 1.15, 1.3)
  uiScale?: number;
  onUiScaleChange?: (scale: number) => void;

  // 排版：边距预设 (窄, 适中, 宽) 与 四向独立边距微调
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

  // 分页翻页动画：滑动 / 淡入 / 无
  turnAnimation?: TurnAnimation;
  onTurnAnimationChange?: (value: TurnAnimation) => void;

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

export const UI_SCALES: Array<{ value: number; label: string }> = [
  { value: 0.85, label: "85%" },
  { value: 1.0, label: "100%" },
  { value: 1.15, label: "115%" },
  { value: 1.3, label: "130%" },
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
  onResetLineHeight,
  fontWeight,
  onFontWeightChange,
  letterSpacingPx,
  onLetterSpacingChange,
  wordSpacingPx,
  onWordSpacingChange,
  gapPx = 24,
  spreadGapMode = "auto",
  onGapPxChange,
  onSpreadGapModeChange,
  spreadArea,
  uiScale = 1.0,
  onUiScaleChange,
  pageMargins,
  onPageMarginsChange,
  columnsPerView,
  onColumnsChange,
  readingMode,
  onReadingModeChange,
  effectiveColumns,
  onPresentationChange,
  turnAnimation = "slide",
  onTurnAnimationChange,
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
  const [activeTab, setActiveTab] = useState<"quick" | "detailed">("quick");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cssDraft, setCssDraft] = useState(customCss);
  const [isClosing, setIsClosing] = useState(false);

  const requestClose = React.useCallback(() => {
    setIsClosing(true);
    // 与 aaPopover.css 退场动画（--menu-close）一致；遮罩随 .is-closing 同步淡出。
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, MENU_CLOSE_MS);
  }, [onClose]);

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

  // 判断当前边距属于哪档预设（若为自定义四向独立边距则返回 null）
  const currentMarginLevel = (() => {
    if (!pageMargins || Object.keys(pageMargins).length === 0) return "自动";
    const { left, right, top, bottom } = pageMargins;
    if (left === 20 && right === 20 && top === 20 && bottom === 20) return "窄";
    if (left === 40 && right === 40 && top === 28 && bottom === 28) return "适中";
    if (left === 64 && right === 64 && top === 36 && bottom === 36) return "宽";
    return null;
  })();

  // 判断当前行高属于哪档预设（若为自定义数值则返回 null）
  const currentLineHeightLevel = (() => {
    if (lineHeight === undefined) return "标准";
    if (Math.abs(lineHeight - 1.4) < 0.05) return "紧凑";
    if (Math.abs(lineHeight - 1.7) < 0.05) return "标准";
    if (Math.abs(lineHeight - 2.0) < 0.05) return "宽松";
    return null;
  })();

  // ---- 详细设置辅助调度器 ----
  const setMarginSide = (side: keyof PageMarginsPx, next: number | undefined) => {
    const current: PageMarginsPx = { ...(pageMargins ?? {}) };
    if (next === undefined) {
      delete current[side];
    } else {
      current[side] = next;
    }
    onPageMarginsChange?.(current);
  };

  const topVal = pageMargins?.top;
  const bottomVal = pageMargins?.bottom;
  const leftExplicit = pageMargins?.left;
  const rightExplicit = pageMargins?.right;
  // 未显式设置时显示自动；已提交几何可用时用真实基础值，不写假 40px。
  const autoLeftPx = spreadArea ? spreadArea.baseLeftPx : readingMode === "scroll" ? 16 : 0;
  const autoRightPx = spreadArea ? spreadArea.baseRightPx : readingMode === "scroll" ? 16 : 0;
  const leftVal = leftExplicit ?? autoLeftPx;
  const rightVal = rightExplicit ?? autoRightPx;
  const gapMode = spreadGapMode;
  const effectiveGapPx = spreadArea?.gapPx;
  const gapBasePx = gapMode === "manual" ? gapPx : effectiveGapPx ?? gapPx;
  const gapValueText = gapMode === "manual"
    ? `${gapPx}px`
    : effectiveGapPx !== undefined
      ? `自动（当前有效 ${Math.round(effectiveGapPx)}px）`
      : "自动";
  const leftValueText = leftExplicit !== undefined
    ? `${leftExplicit}px`
    : spreadArea
      ? `自动（${Math.round(spreadArea.baseLeftPx)}px）`
      : readingMode === "scroll"
        ? "自动（16px）"
        : "自动";
  const rightValueText = rightExplicit !== undefined
    ? `${rightExplicit}px`
    : spreadArea
      ? `自动（${Math.round(spreadArea.baseRightPx)}px）`
      : readingMode === "scroll"
        ? "自动（16px）"
        : "自动";

  const handleLineHeightDec = () => {
    const cur = lineHeight ?? 1.7;
    const next = Math.max(1.2, Math.round((cur - 0.1) * 10) / 10);
    onLineHeightChange(next);
  };
  const handleLineHeightInc = () => {
    const cur = lineHeight ?? 1.7;
    const next = Math.min(2.4, Math.round((cur + 0.1) * 10) / 10);
    onLineHeightChange(next);
  };

  const formatFontWeight = (w?: number): string => {
    if (w === undefined) return "跟随书籍";
    if (w <= 300) return "细体 (300)";
    if (w <= 400) return "常规 (400)";
    if (w <= 500) return "中等 (500)";
    if (w <= 600) return "半粗 (600)";
    return "粗体 (700)";
  };

  const handleWeightDec = () => {
    if (fontWeight === undefined) {
      onFontWeightChange?.(300);
    } else if (fontWeight <= 300) {
      onFontWeightChange?.(undefined);
    } else {
      onFontWeightChange?.(Math.max(300, fontWeight - 100));
    }
  };
  const handleWeightInc = () => {
    if (fontWeight === undefined) {
      onFontWeightChange?.(400);
    } else {
      onFontWeightChange?.(Math.min(700, fontWeight + 100));
    }
  };

  const handleLetterSpacingDec = () => {
    if (letterSpacingPx === undefined || letterSpacingPx <= 0) {
      onLetterSpacingChange?.(undefined);
    } else {
      onLetterSpacingChange?.(letterSpacingPx - 1);
    }
  };
  const handleLetterSpacingInc = () => {
    if (letterSpacingPx === undefined) {
      onLetterSpacingChange?.(1);
    } else {
      onLetterSpacingChange?.(Math.min(8, letterSpacingPx + 1));
    }
  };

  const handleWordSpacingDec = () => {
    if (wordSpacingPx === undefined || wordSpacingPx <= 0) {
      onWordSpacingChange?.(undefined);
    } else {
      onWordSpacingChange?.(Math.max(0, wordSpacingPx - 2));
    }
  };
  const handleWordSpacingInc = () => {
    if (wordSpacingPx === undefined) {
      onWordSpacingChange?.(2);
    } else {
      onWordSpacingChange?.(Math.min(16, wordSpacingPx + 2));
    }
  };

  return (
    <>
      <div
        className={`aa-popover-backdrop${isClosing ? " is-closing" : ""}`}
        onClick={requestClose}
        aria-hidden="true"
      />
      <div
        className={`aa-popover${isClosing ? " is-closing" : ""}`}
        role="dialog"
        aria-label="排版与外观设置"
      >
        {/* 头部：双模分段 Tab 切换与关闭按键 */}
        <div className="aa-popover-header">
          <div className="aa-popover-tabs" role="tablist" aria-label="排版设置模式切换">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "quick"}
              className={`aa-tab-btn${activeTab === "quick" ? " active" : ""}`}
              onClick={() => setActiveTab("quick")}
            >
              常用外观
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "detailed"}
              className={`aa-tab-btn${activeTab === "detailed" ? " active" : ""}`}
              onClick={() => setActiveTab("detailed")}
            >
              详细排版
            </button>
          </div>
          <button
            type="button"
            className="aa-popover-close-btn"
            onClick={requestClose}
            title="关闭设置 (Esc)"
            aria-label="关闭"
          >
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="aa-popover-body">
          {/* =========================================================
           * TAB 1: 常用外观 (Quick View)
           * ========================================================= */}
          {activeTab === "quick" && (
            <>
              {/* Group 1: 主题与字号 */}
              <div className="aa-group-title">主题与字号</div>

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
                  onClick={() => onOpenFontSettings()}
                  title="配置字体与导入字体"
                >
                  <span className="aa-font-name">
                    {customFontName || "系统 / 书籍默认"}
                  </span>
                  <ChevronRightIcon size={13} className="aa-chevron" />
                </button>
              </div>

              {/* Group 2: 排版与版式 */}
              <div className="aa-group-title">排版与版式</div>

              {/* Row 4: 行高与页边距 (双向联动，若处于自定义值则清晰提示) */}
              <div className="aa-section aa-control-row">
                <span className="aa-section-label">
                  行高
                  {currentLineHeightLevel === null && lineHeight !== undefined && (
                    <span className="aa-custom-pill" title="当前处于自定义微调值">
                      {lineHeight.toFixed(1)}
                    </span>
                  )}
                </span>
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
                  <span className="aa-section-label">
                    边距
                    {currentMarginLevel === null && (
                      <span className="aa-custom-pill" title="已启用独立四向微调边距">
                        微调
                      </span>
                    )}
                  </span>
                  <div className="aa-segmented-capsule" role="group" aria-label="页边距">
                    <button
                      type="button"
                      className={`aa-segmented-btn${currentMarginLevel === "自动" ? " active" : ""}`}
                      onClick={() => onPageMarginsChange({})}
                    >
                      自动
                    </button>
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

              {/* Group 3: 翻页与高级选项 */}
              <div className="aa-group-title">翻页与进阶</div>

              {/* 分页翻页动画；滚动模式没有翻页，不显示 */}
              {onTurnAnimationChange && presentation !== "scroll" && (
                <div className="aa-section aa-control-row">
                  <span className="aa-section-label">翻页动画</span>
                  <div className="aa-segmented-capsule" role="radiogroup" aria-label="翻页动画">
                    {TURN_ANIMATION_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={turnAnimation === option.value}
                        className={`aa-segmented-btn${turnAnimation === option.value ? " active" : ""}`}
                        onClick={() => onTurnAnimationChange(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 直达详细参数切换按钮 */}
              <button
                type="button"
                className="aa-switch-to-detail-btn"
                onClick={() => setActiveTab("detailed")}
                title="展开详细排版参数设置"
              >
                <span>详细排版微调（字重/间距/四向边距）</span>
                <ChevronRightIcon size={12} />
              </button>

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
                          <span>高性能预读</span>
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
            </>
          )}

          {/* =========================================================
           * TAB 2: 详细排版工作台 (Detailed Typography & Layout)
           * ========================================================= */}
          {activeTab === "detailed" && (
            <div className="aa-detailed-view" role="tabpanel" aria-label="详细排版参数">
              {/* 分组 1: 正文微调 */}
              <div className="aa-detail-group-title">正文精细排版</div>

              {/* 1. 精确行高 (0.1 步进 + 重置) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">行高倍率</span>
                  <span className="aa-detail-sub">
                    {lineHeight !== undefined ? `${lineHeight.toFixed(1)} 倍` : "自动 (1.7)"}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => {
                      if (onResetLineHeight) onResetLineHeight();
                      else onLineHeightChange(1.7);
                    }}
                    title="重置为默认行高 (1.7)"
                    aria-label="重置行高"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleLineHeightDec}
                    disabled={(lineHeight ?? 1.7) <= 1.2}
                    title="减小行高"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {lineHeight !== undefined ? lineHeight.toFixed(1) : "1.7"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleLineHeightInc}
                    disabled={(lineHeight ?? 1.7) >= 2.4}
                    title="增大行高"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 2. 字重 (300 ~ 700 或跟随书籍) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">正文字重</span>
                  <span className="aa-detail-sub">{formatFontWeight(fontWeight)}</span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => onFontWeightChange?.(undefined)}
                    title="恢复为书籍默认字重"
                    aria-label="重置字重"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleWeightDec}
                    disabled={fontWeight === undefined}
                    title="调细字重"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {fontWeight ?? "默认"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleWeightInc}
                    disabled={fontWeight !== undefined && fontWeight >= 700}
                    title="调粗字重"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 3. 字间距 (0 ~ 8px 或跟随书籍) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">字间距</span>
                  <span className="aa-detail-sub">
                    {letterSpacingPx !== undefined ? `${letterSpacingPx}px` : "跟随书籍"}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => onLetterSpacingChange?.(undefined)}
                    title="恢复为书籍默认字间距"
                    aria-label="重置字间距"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleLetterSpacingDec}
                    disabled={letterSpacingPx === undefined || letterSpacingPx <= 0}
                    title="减小字间距"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {letterSpacingPx !== undefined ? `${letterSpacingPx}px` : "默认"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleLetterSpacingInc}
                    disabled={letterSpacingPx !== undefined && letterSpacingPx >= 8}
                    title="增大字间距"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 4. 词/字符间距 (0 ~ 16px 或跟随书籍) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">词间距</span>
                  <span className="aa-detail-sub">
                    {wordSpacingPx !== undefined ? `${wordSpacingPx}px` : "跟随书籍"}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => onWordSpacingChange?.(undefined)}
                    title="恢复为书籍默认词间距"
                    aria-label="重置词间距"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleWordSpacingDec}
                    disabled={wordSpacingPx === undefined || wordSpacingPx <= 0}
                    title="减小词间距"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {wordSpacingPx !== undefined ? `${wordSpacingPx}px` : "默认"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleWordSpacingInc}
                    disabled={wordSpacingPx !== undefined && wordSpacingPx >= 16}
                    title="增大词间距"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 分组 2: 版心与页边距 (四向独立精确步进) */}
              <div className="aa-detail-group-title">版心与四向留白</div>

              {/* 上边距 */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">上边距</span>
                  <span className="aa-detail-sub">
                    {topVal !== undefined ? `${topVal}px` : "自动 (2.2em)"}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => setMarginSide("top", undefined)}
                    title="重置为自动顶部黄金留白"
                    aria-label="重置上边距"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => {
                      const cur = topVal ?? 28;
                      setMarginSide("top", Math.max(0, cur - 4));
                    }}
                    disabled={(topVal ?? 28) <= 0}
                    title="减小上边距"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {topVal !== undefined ? `${topVal}px` : "自动"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => {
                      const cur = topVal ?? 28;
                      setMarginSide("top", Math.min(120, cur + 4));
                    }}
                    disabled={(topVal ?? 28) >= 120}
                    title="增大上边距"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 下边距 */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">下边距</span>
                  <span className="aa-detail-sub">
                    {bottomVal !== undefined ? `${bottomVal}px` : "自动 (1.6em)"}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => setMarginSide("bottom", undefined)}
                    title="重置为自动底部留白"
                    aria-label="重置下边距"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => {
                      const cur = bottomVal ?? 20;
                      setMarginSide("bottom", Math.max(0, cur - 4));
                    }}
                    disabled={(bottomVal ?? 20) <= 0}
                    title="减小下边距"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {bottomVal !== undefined ? `${bottomVal}px` : "自动"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => {
                      const cur = bottomVal ?? 20;
                      setMarginSide("bottom", Math.min(120, cur + 4));
                    }}
                    disabled={(bottomVal ?? 20) >= 120}
                    title="增大下边距"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 左边距 */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">左边距</span>
                  <span className="aa-detail-sub">{leftValueText}</span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => setMarginSide("left", undefined)}
                    title="重置为自动"
                    aria-label="重置左边距"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => setMarginSide("left", Math.max(0, leftVal - 4))}
                    disabled={leftVal <= 0}
                    title="减小左边距"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val" title={leftValueText}>
                    {leftExplicit !== undefined ? `${leftExplicit}px` : "自动"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => setMarginSide("left", Math.min(120, leftVal + 4))}
                    disabled={leftVal >= 120}
                    title="增大左边距"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 右边距 */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">右边距</span>
                  <span className="aa-detail-sub">{rightValueText}</span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => setMarginSide("right", undefined)}
                    title="重置为自动"
                    aria-label="重置右边距"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => setMarginSide("right", Math.max(0, rightVal - 4))}
                    disabled={rightVal <= 0}
                    title="减小右边距"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val" title={rightValueText}>
                    {rightExplicit !== undefined ? `${rightExplicit}px` : "自动"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => setMarginSide("right", Math.min(120, rightVal + 4))}
                    disabled={rightVal >= 120}
                    title="增大右边距"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 双栏列间距 (中缝) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">双栏中缝</span>
                  <span className="aa-detail-sub">
                    {presentation === "spread" ? gapValueText : `${gapValueText}（双页生效）`}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() =>
                      onSpreadGapModeChange
                        ? onSpreadGapModeChange("auto")
                        : onGapPxChange?.(24)
                    }
                    title="重置为自动中缝（保留手动数值）"
                    aria-label="重置列间距"
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => onGapPxChange?.(Math.max(0, gapBasePx - 4))}
                    disabled={gapBasePx <= 0}
                    title="减小双栏中缝"
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val" title={gapValueText}>
                    {gapMode === "manual" ? `${gapPx}px` : "自动"}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => onGapPxChange?.(Math.min(PAGE_GAP_MAX_PX, gapBasePx + 4))}
                    disabled={gapBasePx >= PAGE_GAP_MAX_PX}
                    title="增大双栏中缝"
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 分组 3: 引擎与系统 */}
              <div className="aa-detail-group-title">界面与引擎</div>

              {/* 界面缩放 */}
              {onUiScaleChange && (
                <div className="aa-section aa-control-row">
                  <span className="aa-section-label">界面缩放</span>
                  <div className="aa-segmented-capsule" role="radiogroup" aria-label="界面缩放">
                    {UI_SCALES.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`aa-segmented-btn${Math.abs((uiScale ?? 1) - opt.value) < 0.05 ? " active" : ""}`}
                        onClick={() => onUiScaleChange(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 强制横排 */}
              {onForceHorizontalChange && (
                <div className="aa-section aa-control-row aa-toggle-row">
                  <span className="aa-section-label">强制竖排转横排</span>
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

              {/* 高性能预加载 */}
              {onPreloadNextChapterChange && (
                <div className="aa-section aa-control-row aa-toggle-row">
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span className="aa-section-label">高性能预读</span>
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

              {/* 自定义 CSS */}
              {onCustomCssChange && (
                <div className="aa-css-editor-section">
                  <span className="aa-css-label">自定义 CSS 样式注入</span>
                  <textarea
                    className="aa-css-textarea"
                    rows={4}
                    placeholder="/* 自定义注入 CSS，例：body { text-align: justify !important; } */"
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

              {/* 底部操作工具行 */}
              <div className="aa-advanced-actions" style={{ marginTop: 6, borderTop: "1px solid color-mix(in srgb, var(--panel-border) 40%, transparent)", paddingTop: 8 }}>
                {onResetDefaults && (
                  <button
                    type="button"
                    className="aa-mini-action-btn"
                    onClick={onResetDefaults}
                    title="恢复全部设置默认值"
                  >
                    <RotateCcwIcon size={13} />
                    <span>恢复默认设置</span>
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
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
