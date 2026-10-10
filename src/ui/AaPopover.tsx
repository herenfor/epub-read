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
import { useUiLanguageChoice } from "./localization/useUiLanguageChoice";
import { useUiText } from "./localization/UiLanguageProvider";
import type { PlainMessageKey } from "./localization/core";

const TURN_ANIMATION_OPTIONS: ReadonlyArray<{ value: TurnAnimation; labelKey: PlainMessageKey }> = [
  { value: "slide", labelKey: "aa.turn.slide" },
  { value: "fade", labelKey: "aa.turn.fade" },
  { value: "none", labelKey: "aa.turn.none" },
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
  onOpenDisplaySettings?: () => void;

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
  /** Stable Chinese name; display text comes from nameKey. */
  name: string;
  nameKey: PlainMessageKey;
  bg: string;
  fg: string;
  border: string;
}> = [
  { id: "light", name: "白底", nameKey: "aa.theme.light", bg: "#ffffff", fg: "#1a1a1a", border: "#e2e8f0" },
  { id: "sepia", name: "羊皮纸", nameKey: "aa.theme.sepia", bg: "#fbf0d9", fg: "#5f4b32", border: "#e8dac0" },
  { id: "gray", name: "深灰", nameKey: "aa.theme.gray", bg: "#2d2d30", fg: "#cccccc", border: "#3e3e42" },
  { id: "dark", name: "暗夜", nameKey: "aa.theme.dark", bg: "#18181b", fg: "#e4e4e7", border: "#27272a" },
];

/** label is the internal preset id; labelKey is what the UI shows. */
export const LINE_HEIGHT_PRESETS: Array<{ label: string; labelKey: PlainMessageKey; value: number }> = [
  { label: "紧凑", labelKey: "aa.lineHeight.compact", value: 1.4 },
  { label: "标准", labelKey: "aa.lineHeight.standard", value: 1.7 },
  { label: "宽松", labelKey: "aa.lineHeight.loose", value: 2.0 },
];

export const MARGIN_PRESETS: Array<{ label: string; labelKey: PlainMessageKey; margins: PageMarginsPx }> = [
  { label: "窄", labelKey: "aa.margin.narrow", margins: { left: 20, right: 20, top: 20, bottom: 20 } },
  { label: "适中", labelKey: "aa.margin.medium", margins: { left: 40, right: 40, top: 28, bottom: 28 } },
  { label: "宽", labelKey: "aa.margin.wide", margins: { left: 64, right: 64, top: 36, bottom: 36 } },
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
  onOpenDisplaySettings,
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
  const language = useUiLanguageChoice();
  const { t } = useUiText();
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
      ? t("aa.autoEffective", { px: Math.round(effectiveGapPx) })
      : t("aa.auto");
  const leftValueText = leftExplicit !== undefined
    ? `${leftExplicit}px`
    : spreadArea
      ? t("aa.autoPx", { px: Math.round(spreadArea.baseLeftPx) })
      : readingMode === "scroll"
        ? t("aa.autoPx", { px: 16 })
        : t("aa.auto");
  const rightValueText = rightExplicit !== undefined
    ? `${rightExplicit}px`
    : spreadArea
      ? t("aa.autoPx", { px: Math.round(spreadArea.baseRightPx) })
      : readingMode === "scroll"
        ? t("aa.autoPx", { px: 16 })
        : t("aa.auto");

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
    if (w === undefined) return t("aa.followBook");
    if (w <= 300) return t("aa.weight.light");
    if (w <= 400) return t("aa.weight.regular");
    if (w <= 500) return t("aa.weight.medium");
    if (w <= 600) return t("aa.weight.semibold");
    return t("aa.weight.bold");
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
        aria-label={t("aa.dialog")}
      >
        {/* 头部：双模分段 Tab 切换与关闭按键 */}
        <div className="aa-popover-header">
          <div className="aa-popover-tabs" role="tablist" aria-label={t("aa.tabs")}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "quick"}
              className={`aa-tab-btn${activeTab === "quick" ? " active" : ""}`}
              onClick={() => setActiveTab("quick")}
            >
              {t("aa.tab.quick")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "detailed"}
              className={`aa-tab-btn${activeTab === "detailed" ? " active" : ""}`}
              onClick={() => setActiveTab("detailed")}
            >
              {t("aa.tab.detailed")}
            </button>
          </div>
          <button
            type="button"
            className="aa-popover-close-btn"
            onClick={requestClose}
            title={t("aa.close.tip")}
            aria-label={t("aa.close")}
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
              <div className="aa-group-title">{t("aa.group.themeSize")}</div>

              {/* Row 1: 4 款预设主题色块 */}
              <div className="aa-section aa-theme-section" role="radiogroup" aria-label={t("aa.themes")}>
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
                      title={t("aa.theme.tip", { name: t(palette.nameKey) })}
                    >
                      <span className="aa-theme-letter">Aa</span>
                      <span className="aa-theme-label">{t(palette.nameKey)}</span>
                    </button>
                  );
                })}
              </div>

              {/* Row 2: 字号步进调节 */}
              <div className="aa-section aa-control-row">
                <span className="aa-section-label">{t("aa.fontSize")}</span>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={onFontDec}
                    disabled={fontSize <= 12}
                    title={t("aa.fontSize.dec.tip")}
                    aria-label={t("aa.fontSize.dec")}
                  >
                    <span className="aa-stepper-text-small">{t("aa.fontSize.small")}</span>
                  </button>
                  <span className="aa-stepper-val" title={t("aa.fontSize.current", { px: fontSize })}>
                    {fontSize}px
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={onFontInc}
                    disabled={fontSize >= 32}
                    title={t("aa.fontSize.inc.tip")}
                    aria-label={t("aa.fontSize.inc")}
                  >
                    <span className="aa-stepper-text-large">{t("aa.fontSize.large")}</span>
                  </button>
                </div>
              </div>

              {/* Row 3: 字体选择 */}
              <div className="aa-section aa-control-row">
                <span className="aa-section-label">{t("aa.font")}</span>
                <button
                  type="button"
                  className="aa-font-trigger"
                  onClick={() => onOpenFontSettings()}
                  title={t("aa.font.tip")}
                >
                  <span className="aa-font-name">
                    {customFontName || t("aa.font.default")}
                  </span>
                  <ChevronRightIcon size={13} className="aa-chevron" />
                </button>
              </div>

              {onOpenDisplaySettings && (
                <div className="aa-section aa-control-row">
                  <span className="aa-section-label">{t("aa.display")}</span>
                  <button
                    type="button"
                    className="aa-font-trigger"
                    onClick={onOpenDisplaySettings}
                    title={t("aa.display.tip")}
                  >
                    <span className="aa-font-name">{t("aa.display.open")}</span>
                    <ChevronRightIcon size={13} className="aa-chevron" />
                  </button>
                </div>
              )}

              {/* Group 2: 排版与版式 */}
              <div className="aa-group-title">{t("aa.group.layout")}</div>

              {/* Row 4: 行高与页边距 (双向联动，若处于自定义值则清晰提示) */}
              <div className="aa-section aa-control-row">
                <span className="aa-section-label">
                  {t("aa.lineHeight")}
                  {currentLineHeightLevel === null && lineHeight !== undefined && (
                    <span className="aa-custom-pill" title={t("aa.lineHeight.custom")}>
                      {lineHeight.toFixed(1)}
                    </span>
                  )}
                </span>
                <div className="aa-segmented-capsule" role="group" aria-label={t("aa.lineHeight")}>
                  {LINE_HEIGHT_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={`aa-segmented-btn${currentLineHeightLevel === preset.label ? " active" : ""}`}
                      onClick={() => onLineHeightChange(preset.value)}
                    >
                      {t(preset.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {onPageMarginsChange && (
                <div className="aa-section aa-control-row">
                  <span className="aa-section-label">
                    {t("aa.margins")}
                    {currentMarginLevel === null && (
                      <span className="aa-custom-pill" title={t("aa.margins.custom.tip")}>
                        {t("aa.margins.custom")}
                      </span>
                    )}
                  </span>
                  <div className="aa-segmented-capsule" role="group" aria-label={t("aa.margins.group")}>
                    <button
                      type="button"
                      className={`aa-segmented-btn${currentMarginLevel === "自动" ? " active" : ""}`}
                      onClick={() => onPageMarginsChange({})}
                    >
                      {t("aa.margin.auto")}
                    </button>
                    {MARGIN_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={`aa-segmented-btn${currentMarginLevel === preset.label ? " active" : ""}`}
                        onClick={() => onPageMarginsChange(preset.margins)}
                      >
                        {t(preset.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Row 5: 唯一阅读方式选项 单页 | 双页 | 滚动 */}
              <div className="aa-section aa-control-row">
                <span className="aa-section-label">{t("aa.presentation")}</span>
                <div className="aa-segmented-capsule" role="radiogroup" aria-label={t("aa.presentation.group")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={presentation === "single"}
                    className={`aa-segmented-btn${presentation === "single" ? " active" : ""}`}
                    onClick={() => handlePresentationClick("single")}
                  >
                    {t("aa.presentation.single")}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={presentation === "spread"}
                    className={`aa-segmented-btn${presentation === "spread" ? " active" : ""}`}
                    onClick={() => handlePresentationClick("spread")}
                  >
                    {t("aa.presentation.spread")}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={presentation === "scroll"}
                    className={`aa-segmented-btn${presentation === "scroll" ? " active" : ""}`}
                    onClick={() => handlePresentationClick("scroll")}
                  >
                    {t("aa.presentation.scroll")}
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
                  {t("aa.presentation.narrow")}
                </div>
              )}

              {/* Group 3: 翻页与高级选项 */}
              <div className="aa-group-title">{t("aa.group.advanced")}</div>

              {/* 分页翻页动画；滚动模式没有翻页，不显示 */}
              {onTurnAnimationChange && presentation !== "scroll" && (
                <div className="aa-section aa-control-row">
                  <span className="aa-section-label">{t("aa.turnAnimation")}</span>
                  <div className="aa-segmented-capsule" role="radiogroup" aria-label={t("aa.turnAnimation")}>
                    {TURN_ANIMATION_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={turnAnimation === option.value}
                        className={`aa-segmented-btn${turnAnimation === option.value ? " active" : ""}`}
                        onClick={() => onTurnAnimationChange(option.value)}
                      >
                        {t(option.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="aa-section aa-control-row">
                <span className="aa-section-label">{language.label}</span>
                <div className="aa-segmented-capsule" role="radiogroup" aria-label={language.label}>
                  {language.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={language.preference === option.value}
                      className={`aa-segmented-btn${language.preference === option.value ? " active" : ""}`}
                      onClick={() => language.choose(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              {language.error && <p className="aa-section-note aa-section-error" role="alert">{language.error}</p>}

              {/* 直达详细参数切换按钮 */}
              <button
                type="button"
                className="aa-switch-to-detail-btn"
                onClick={() => setActiveTab("detailed")}
                title={t("aa.detail.open.tip")}
              >
                <span>{t("aa.detail.open")}</span>
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
                  <span>{t("aa.more")}</span>
                  {advancedOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                </button>

                {advancedOpen && (
                  <div className="aa-advanced-body">
                    {onForceHorizontalChange && (
                      <div className="aa-advanced-row">
                        <span>{t("aa.forceHorizontal")}</span>
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
                          <span>{t("aa.preload")}</span>
                          <span style={{ fontSize: 11, color: "var(--color-error, #e53935)", lineHeight: 1.2 }}>
                            {t("aa.preload.warning")}
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
                        <span className="aa-css-label">{t("aa.css")}</span>
                        <textarea
                          className="aa-css-textarea"
                          rows={3}
                          placeholder={t("aa.css.placeholder")}
                          value={cssDraft}
                          onChange={(e) => setCssDraft(e.target.value)}
                        />
                        {cssDraft !== customCss && (
                          <button
                            type="button"
                            className="aa-btn-save-css"
                            onClick={() => onCustomCssChange(cssDraft)}
                          >
                            {t("aa.css.save")}
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
                          title={t("aa.importBooks.tip")}
                        >
                          <span>{t("aa.importBooks")}</span>
                        </button>
                      )}
                      {onToggleLog && (
                        <button
                          type="button"
                          className="aa-mini-action-btn"
                          onClick={onToggleLog}
                          title={t("aa.log.tip")}
                        >
                          <WrenchIcon size={13} />
                          <span>{issueCount > 0 ? t("aa.log.count", { count: issueCount }) : t("aa.log")}</span>
                        </button>
                      )}
                      {onResetDefaults && (
                        <button
                          type="button"
                          className="aa-mini-action-btn"
                          onClick={onResetDefaults}
                          title={t("aa.reset.tip")}
                        >
                          <RotateCcwIcon size={13} />
                          <span>{t("aa.reset")}</span>
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
            <div className="aa-detailed-view" role="tabpanel" aria-label={t("aa.detail")}>
              {/* 分组 1: 正文微调 */}
              <div className="aa-detail-group-title">{t("aa.detail.text")}</div>

              {/* 1. 精确行高 (0.1 步进 + 重置) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.lineHeight.ratio")}</span>
                  <span className="aa-detail-sub">
                    {lineHeight !== undefined ? t("aa.lineHeight.times", { value: lineHeight.toFixed(1) }) : t("aa.lineHeight.auto")}
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
                    title={t("aa.lineHeight.reset.tip")}
                    aria-label={t("aa.lineHeight.reset")}
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleLineHeightDec}
                    disabled={(lineHeight ?? 1.7) <= 1.2}
                    title={t("aa.lineHeight.dec")}
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
                    title={t("aa.lineHeight.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 2. 字重 (300 ~ 700 或跟随书籍) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.weight")}</span>
                  <span className="aa-detail-sub">{formatFontWeight(fontWeight)}</span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => onFontWeightChange?.(undefined)}
                    title={t("aa.weight.reset.tip")}
                    aria-label={t("aa.weight.reset")}
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleWeightDec}
                    disabled={fontWeight === undefined}
                    title={t("aa.weight.dec")}
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {fontWeight ?? t("aa.default")}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleWeightInc}
                    disabled={fontWeight !== undefined && fontWeight >= 700}
                    title={t("aa.weight.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 3. 字间距 (0 ~ 8px 或跟随书籍) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.letterSpacing")}</span>
                  <span className="aa-detail-sub">
                    {letterSpacingPx !== undefined ? `${letterSpacingPx}px` : t("aa.followBook")}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => onLetterSpacingChange?.(undefined)}
                    title={t("aa.letterSpacing.reset.tip")}
                    aria-label={t("aa.letterSpacing.reset")}
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleLetterSpacingDec}
                    disabled={letterSpacingPx === undefined || letterSpacingPx <= 0}
                    title={t("aa.letterSpacing.dec")}
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {letterSpacingPx !== undefined ? `${letterSpacingPx}px` : t("aa.default")}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleLetterSpacingInc}
                    disabled={letterSpacingPx !== undefined && letterSpacingPx >= 8}
                    title={t("aa.letterSpacing.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 4. 词/字符间距 (0 ~ 16px 或跟随书籍) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.wordSpacing")}</span>
                  <span className="aa-detail-sub">
                    {wordSpacingPx !== undefined ? `${wordSpacingPx}px` : t("aa.followBook")}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => onWordSpacingChange?.(undefined)}
                    title={t("aa.wordSpacing.reset.tip")}
                    aria-label={t("aa.wordSpacing.reset")}
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleWordSpacingDec}
                    disabled={wordSpacingPx === undefined || wordSpacingPx <= 0}
                    title={t("aa.wordSpacing.dec")}
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {wordSpacingPx !== undefined ? `${wordSpacingPx}px` : t("aa.default")}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={handleWordSpacingInc}
                    disabled={wordSpacingPx !== undefined && wordSpacingPx >= 16}
                    title={t("aa.wordSpacing.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 分组 2: 版心与页边距 (四向独立精确步进) */}
              <div className="aa-detail-group-title">{t("aa.detail.margins")}</div>

              {/* 上边距 */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.margin.top")}</span>
                  <span className="aa-detail-sub">
                    {topVal !== undefined ? `${topVal}px` : t("aa.margin.top.auto")}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => setMarginSide("top", undefined)}
                    title={t("aa.margin.top.reset.tip")}
                    aria-label={t("aa.margin.top.reset")}
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
                    title={t("aa.margin.top.dec")}
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {topVal !== undefined ? `${topVal}px` : t("aa.auto")}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => {
                      const cur = topVal ?? 28;
                      setMarginSide("top", Math.min(120, cur + 4));
                    }}
                    disabled={(topVal ?? 28) >= 120}
                    title={t("aa.margin.top.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 下边距 */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.margin.bottom")}</span>
                  <span className="aa-detail-sub">
                    {bottomVal !== undefined ? `${bottomVal}px` : t("aa.margin.bottom.auto")}
                  </span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => setMarginSide("bottom", undefined)}
                    title={t("aa.margin.bottom.reset.tip")}
                    aria-label={t("aa.margin.bottom.reset")}
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
                    title={t("aa.margin.bottom.dec")}
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val">
                    {bottomVal !== undefined ? `${bottomVal}px` : t("aa.auto")}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => {
                      const cur = bottomVal ?? 20;
                      setMarginSide("bottom", Math.min(120, cur + 4));
                    }}
                    disabled={(bottomVal ?? 20) >= 120}
                    title={t("aa.margin.bottom.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 左边距 */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.margin.left")}</span>
                  <span className="aa-detail-sub">{leftValueText}</span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => setMarginSide("left", undefined)}
                    title={t("aa.margin.reset.tip")}
                    aria-label={t("aa.margin.left.reset")}
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => setMarginSide("left", Math.max(0, leftVal - 4))}
                    disabled={leftVal <= 0}
                    title={t("aa.margin.left.dec")}
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val" title={leftValueText}>
                    {leftExplicit !== undefined ? `${leftExplicit}px` : t("aa.auto")}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => setMarginSide("left", Math.min(120, leftVal + 4))}
                    disabled={leftVal >= 120}
                    title={t("aa.margin.left.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 右边距 */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.margin.right")}</span>
                  <span className="aa-detail-sub">{rightValueText}</span>
                </div>
                <div className="aa-stepper-capsule">
                  <button
                    type="button"
                    className="aa-step-reset-btn"
                    onClick={() => setMarginSide("right", undefined)}
                    title={t("aa.margin.reset.tip")}
                    aria-label={t("aa.margin.right.reset")}
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => setMarginSide("right", Math.max(0, rightVal - 4))}
                    disabled={rightVal <= 0}
                    title={t("aa.margin.right.dec")}
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val" title={rightValueText}>
                    {rightExplicit !== undefined ? `${rightExplicit}px` : t("aa.auto")}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => setMarginSide("right", Math.min(120, rightVal + 4))}
                    disabled={rightVal >= 120}
                    title={t("aa.margin.right.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 双栏列间距 (中缝) */}
              <div className="aa-section aa-control-row">
                <div className="aa-detail-label-wrap">
                  <span className="aa-section-label">{t("aa.gap")}</span>
                  <span className="aa-detail-sub">
                    {presentation === "spread" ? gapValueText : t("aa.gap.spreadOnly", { value: gapValueText })}
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
                    title={t("aa.gap.reset.tip")}
                    aria-label={t("aa.gap.reset")}
                  >
                    <RotateCcwIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => onGapPxChange?.(Math.max(0, gapBasePx - 4))}
                    disabled={gapBasePx <= 0}
                    title={t("aa.gap.dec")}
                  >
                    <MinusIcon size={12} />
                  </button>
                  <span className="aa-stepper-val" title={gapValueText}>
                    {gapMode === "manual" ? `${gapPx}px` : t("aa.auto")}
                  </span>
                  <button
                    type="button"
                    className="aa-step-btn"
                    onClick={() => onGapPxChange?.(Math.min(PAGE_GAP_MAX_PX, gapBasePx + 4))}
                    disabled={gapBasePx >= PAGE_GAP_MAX_PX}
                    title={t("aa.gap.inc")}
                  >
                    <PlusIcon size={12} />
                  </button>
                </div>
              </div>

              {/* 分组 3: 引擎与系统 */}
              <div className="aa-detail-group-title">{t("aa.detail.engine")}</div>

              {/* 界面缩放 */}
              {onUiScaleChange && (
                <div className="aa-section aa-control-row">
                  <span className="aa-section-label">{t("aa.uiScale")}</span>
                  <div className="aa-segmented-capsule" role="radiogroup" aria-label={t("aa.uiScale")}>
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
                  <span className="aa-section-label">{t("aa.forceHorizontal")}</span>
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
                    <span className="aa-section-label">{t("aa.preload")}</span>
                    <span style={{ fontSize: 11, color: "var(--color-error, #e53935)", lineHeight: 1.2 }}>
                      {t("aa.preload.warning")}
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
                  <span className="aa-css-label">{t("aa.css.inject")}</span>
                  <textarea
                    className="aa-css-textarea"
                    rows={4}
                    placeholder={t("aa.css.placeholderLong")}
                    value={cssDraft}
                    onChange={(e) => setCssDraft(e.target.value)}
                  />
                  {cssDraft !== customCss && (
                    <button
                      type="button"
                      className="aa-btn-save-css"
                      onClick={() => onCustomCssChange(cssDraft)}
                    >
                      {t("aa.css.save")}
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
                    title={t("aa.reset.tip")}
                  >
                    <RotateCcwIcon size={13} />
                    <span>{t("aa.resetAll")}</span>
                  </button>
                )}
                {onToggleLog && (
                  <button
                    type="button"
                    className="aa-mini-action-btn"
                    onClick={onToggleLog}
                    title={t("aa.log.tip")}
                  >
                    <WrenchIcon size={13} />
                    <span>{issueCount > 0 ? t("aa.log.count", { count: issueCount }) : t("aa.log")}</span>
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
