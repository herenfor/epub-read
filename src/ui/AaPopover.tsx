import { READER_PALETTES } from "../config/readerPalette";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMenuClose } from "./menuMotion";
import { useSheetDrag } from "./sheetDrag";
import type { PageDirectionSetting, Theme, TurnAnimation } from "../render/settings";
import type { AppliedTextInsets, PageMarginsPx, ReadingMode, SpreadGapMode } from "../render/pageLayout";
import {
  presentationPatch,
  readingPresentation,
  type ReadingPresentation,
} from "../render/pagedSpread";
import { ArrowLeftIcon, ChevronRightIcon, RotateCcwIcon } from "./readerIcons";
import { CustomThemeEditor } from "./controls/CustomThemeEditor";
import type { CustomThemeControls } from "./useCustomThemes";
import "./aaPopover.css";
import { useUiText } from "./localization/UiLanguageProvider";
import { formatFontSizePx } from "./fontSizeDisplay";
import type { PlainMessageKey } from "./localization/core";
import {
  FONT_SIZE_STOPS,
  FONT_WEIGHT_STOPS,
  LETTER_SPACING_STOPS,
  LINE_HEIGHT_STOPS,
  MARGIN_LEVELS,
  MARGIN_LEVEL_COUNT,
  SIDE_MARGIN_STOPS,
  SPREAD_GAP_STOPS,
  WORD_SPACING_STOPS,
  clampFontSize,
  marginLevelPosition,
  marginsForLevel,
  stopIndex,
  stopValue,
  withMarginSide,
  type SettingStops,
} from "./typographyScales";
import { useScrollEdgeFade } from "./scrollEdgeFade";
import { useSliderFocus } from "./sliderFocus";
import { readerTextBox, type ScreenBox } from "./readerPageBox";
import { SliderDragContext, TouchSlider } from "./TouchSlider";
import { Switch } from "./controls/Switch";
import { ThemeCards } from "./controls/ThemeCards";

const TURN_ANIMATION_OPTIONS: ReadonlyArray<{ value: TurnAnimation; labelKey: PlainMessageKey }> = [
  { value: "slide", labelKey: "aa.turn.slide" },
  { value: "fade", labelKey: "aa.turn.fade" },
  { value: "none", labelKey: "aa.turn.none" },
];

/** Local preference: the Advanced typography group is expanded. */
const ADVANCED_OPEN_KEY = "epub-reader:aa-advanced-open";

function readAdvancedOpen(): boolean {
  try { return localStorage.getItem(ADVANCED_OPEN_KEY) === "1"; } catch { return false; }
}

function writeAdvancedOpen(open: boolean): void {
  try { localStorage.setItem(ADVANCED_OPEN_KEY, open ? "1" : "0"); } catch { /* storage unavailable */ }
}

export interface AaPopoverProps {
  fontSize: number;
  onFontSizeChange: (v: number) => void;
  onFontDec: () => void;
  onFontInc: () => void;

  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  /** Custom themes: shown after the built-in ones; their editor opens in this panel. */
  customThemes?: CustomThemeControls;

  // 字体设置
  customFontName?: string;
  onOpenFontSettings: () => void;
  onOpenDisplaySettings?: () => void;
  /** One-line state of the display sub-page (e.g. "繁 → 简 · 滤镜"); empty hides it. */
  displaySummary?: string;

  // 行高 1.2–2.4（undefined 跟随书籍）
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

  // 边距：一个联动滑块（自动 + 九档），高级排版里四边各自调
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

  forceHorizontal?: boolean;
  onForceHorizontalChange?: (enabled: boolean) => void;
  /** 翻页方向：跟随书籍 / 始终从左往右 */
  pageDirection?: PageDirectionSetting;
  onPageDirectionChange?: (value: PageDirectionSetting) => void;
  customCss?: string;
  onCustomCssChange?: (css: string) => void;
  onResetDefaults?: () => void;
  onToggleLog?: () => void;
  issueCount?: number;
  onOpenFile?: () => void;
  /** Phone bottom sheet (fixed height, drag down to close). */
  phoneLayout?: boolean;

  /**
   * A typography slider is held (true) or released (false). The reader then
   * relayouts at once for each value and holds its background preparation.
   */
  onLivePreviewChange?: (active: boolean) => void;
  /**
   * Changes each time the reader publishes a laid-out page (null while it is
   * laying out); the margin guide re-reads the applied text box then.
   */
  layoutStamp?: { textInsets?: AppliedTextInsets } | null;

  /**
   * False keeps the panel mounted but closed: prepared while a book opens,
   * laid out at its real size and theme, hidden, inert and without motion.
   * Each opening then starts like a fresh one (scrolled to the top).
   */
  open?: boolean;
  /** Called once after the first closed (prepared) layout. */
  onPrepared?: () => void;
  /**
   * While closed: draw the panel once, practically invisible (panelPaintWarmup).
   * "quick" is the top of the page; "detailed" the lower part with Advanced open.
   */
  paintWarm?: "quick" | "detailed";
  /**
   * Hidden behind one of its own sub-pages (fonts, display): keeps its page,
   * height and scroll, and comes back in place without an entrance.
   */
  suspended?: boolean;
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
}> = ([
  { id: "light", name: "白底", nameKey: "aa.theme.light" },
  { id: "sepia", name: "羊皮纸", nameKey: "aa.theme.sepia" },
  { id: "gray", name: "深灰", nameKey: "aa.theme.gray" },
  { id: "dark", name: "暗夜", nameKey: "aa.theme.dark" },
] as const).map((choice) => {
  const palette = READER_PALETTES[choice.id];
  return {
    ...choice,
    bg: palette.background,
    fg: palette.foreground,
    border: palette.previewBorder,
  };
});

/** Named line heights; the slider shows the name beside the number when it lands on one. */
export const LINE_HEIGHT_PRESETS: Array<{ id: "compact" | "standard" | "loose"; labelKey: PlainMessageKey; value: number }> = [
  { id: "compact", labelKey: "aa.lineHeight.compact", value: 1.4 },
  { id: "standard", labelKey: "aa.lineHeight.standard", value: 1.7 },
  { id: "loose", labelKey: "aa.lineHeight.loose", value: 2.0 },
];

/** Preset the line height matches, or null (unset follows the book, a custom value has no name). */
export function lineHeightPresetId(lineHeight: number | undefined): (typeof LINE_HEIGHT_PRESETS)[number]["id"] | null {
  if (lineHeight === undefined) return null;
  return LINE_HEIGHT_PRESETS.find((preset) => Math.abs(lineHeight - preset.value) < 0.05)?.id ?? null;
}

const MARGIN_PRESET_KEYS: Record<"narrow" | "medium" | "wide", PlainMessageKey> = {
  narrow: "aa.margin.narrow",
  medium: "aa.margin.medium",
  wide: "aa.margin.wide",
};

/** A slider over a list of stops; it only ever reports values from that list. */
function StopSlider({ stops, value, onChange, label, valueText, disabled }: {
  stops: SettingStops;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  label: string;
  valueText: string;
  disabled?: boolean;
}) {
  const index = stopIndex(stops, value);
  return (
    <TouchSlider
      className="aa-slider"
      min={0}
      max={stops.length - 1}
      step={1}
      value={index}
      auto={stopValue(stops, index) === undefined}
      disabled={disabled}
      label={label}
      valueText={valueText}
      onChange={(next) => {
        if (next !== index) onChange(stopValue(stops, next));
      }}
    />
  );
}

function SwitchRow({ label, hint, warning, checked, disabled, onChange }: {
  label: string;
  hint?: string;
  warning?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`aa-switch-row${disabled ? " aa-row-disabled" : ""}`} aria-disabled={disabled || undefined}>
      <span className="aa-toggle-text">
        <span className="aa-switch-name">{label}</span>
        {hint && <span className="aa-detail-sub">{hint}</span>}
        {warning && <span className="aa-detail-warning">{warning}</span>}
      </span>
      <Switch inRow checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

export const AaPopover = React.memo(function AaPopover({
  fontSize,
  onFontSizeChange,
  theme,
  onThemeChange,
  customThemes,
  customFontName,
  onOpenFontSettings,
  onOpenDisplaySettings,
  displaySummary,
  lineHeight,
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
  pageDirection = "book",
  onPageDirectionChange,
  customCss = "",
  onCustomCssChange,
  onResetDefaults,
  onToggleLog,
  issueCount = 0,
  onOpenFile,
  onLivePreviewChange,
  layoutStamp,
  open = true,
  onPrepared,
  paintWarm,
  suspended = false,
  onClose,
}: AaPopoverProps) {
  const { t } = useUiText();
  const [cssDraft, setCssDraft] = useState(customCss);
  const [cssOpen, setCssOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(readAdvancedOpen);
  // The theme editor replaces the page in place, like the font sub-page.
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
  const editingIndex = editingThemeId && customThemes ? customThemes.themes.findIndex((item) => item.id === editingThemeId) : -1;
  const editingTheme = editingIndex >= 0 ? customThemes!.themes[editingIndex] : null;
  useEffect(() => {
    if (!open) setEditingThemeId(null);
  }, [open]);
  const { isClosing, requestClose } = useMenuClose(onClose, open);
  const visible = open || isClosing;
  // The closed "detailed" warm-up draws Advanced open; it is not a choice the reader made.
  const warmDetailed = !visible && !suspended && paintWarm === "detailed";
  const advancedShown = advancedOpen || warmDetailed;
  const toggleAdvanced = () => {
    setAdvancedOpen((current) => {
      writeAdvancedOpen(!current);
      return !current;
    });
  };

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

  // ---- 显示文字 ----
  const lineHeightText = (() => {
    if (lineHeight === undefined) return t("aa.followBook");
    const preset = LINE_HEIGHT_PRESETS.find((item) => item.id === lineHeightPresetId(lineHeight));
    return preset ? `${t(preset.labelKey)} ${lineHeight.toFixed(1)}` : lineHeight.toFixed(1);
  })();
  const marginPosition = marginLevelPosition(pageMargins);
  const marginText = (() => {
    if (marginPosition.index === 0) return t("aa.margin.auto");
    if (!marginPosition.exact) return t("aa.margins.custom");
    const level = MARGIN_LEVELS[marginPosition.index - 1];
    return level.preset ? t(MARGIN_PRESET_KEYS[level.preset]) : `${level.side}px`;
  })();
  const shortDefault = t("aa.default");
  const letterSpacingText = letterSpacingPx === undefined ? shortDefault : String(letterSpacingPx);
  const fontWeightText = fontWeight === undefined ? shortDefault : String(fontWeight);
  const wordSpacingText = wordSpacingPx === undefined ? t("aa.followBook") : `${wordSpacingPx}px`;
  const autoSideText = (side: "left" | "right"): string => spreadArea
    ? t("aa.autoPx", { px: Math.round(side === "left" ? spreadArea.baseLeftPx : spreadArea.baseRightPx) })
    : readingMode === "scroll" ? t("aa.autoPx", { px: 16 }) : t("aa.auto");
  const sideText = (side: keyof PageMarginsPx): string => {
    const value = pageMargins?.[side];
    if (value !== undefined) return `${value}px`;
    return side === "left" || side === "right" ? autoSideText(side) : t("aa.auto");
  };
  const gapText = spreadGapMode === "manual"
    ? `${gapPx}px`
    : spreadArea?.gapPx !== undefined
      ? t("aa.autoPx", { px: Math.round(spreadArea.gapPx) })
      : t("aa.auto");

  // ---- 拖动聚焦：按住滑块时面板隐去，正文跟着变 ----
  const dialogRef = useRef<HTMLDivElement>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const onLivePreviewChangeRef = useRef(onLivePreviewChange);
  onLivePreviewChangeRef.current = onLivePreviewChange;
  // Closing Aa or covering it with a sub-page ends a drag through the same
  // path as lifting the finger (attributes, focus state and live preview).
  const sliderHost = useSliderFocus(dialogRef, (row) => {
    setFocusRow(row);
    onLivePreviewChangeRef.current?.(row !== null);
  }, open);

  // 边距参考线：拖边距时，画阅读器实际排出的正文框（读当前显示的已排版几何，
  // 不在这里推算自动边距）；每次重排发布就绪后重读，拿不到就不画。
  const marginFocus = focusRow !== null && focusRow.startsWith("margin");
  const [guideBox, setGuideBox] = useState<ScreenBox | null>(null);
  useLayoutEffect(() => {
    if (!marginFocus || readingMode === "scroll") {
      setGuideBox(null);
      return;
    }
    if (layoutStamp === null) return;
    setGuideBox(readerTextBox(layoutStamp?.textInsets));
  }, [marginFocus, readingMode, layoutStamp]);
  const guide = guideBox ? {
    left: guideBox.left,
    right: window.innerWidth - guideBox.right,
    top: guideBox.top,
    bottom: window.innerHeight - guideBox.bottom,
  } : null;

  // 打开即把焦点交给面板：Tab 从面板内开始，方向键不再落到背后的正文。
  useEffect(() => {
    if (open) dialogRef.current?.focus({ preventScroll: true });
  }, [open]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useScrollEdgeFade(bodyRef);
  // 手机：固定高度的底部面板；把手或内容在顶部时下拉关闭（不再上拉展开）。
  const { dragging, grip, reset: resetSheet } = useSheetDrag({
    sheetRef: dialogRef,
    disabled: isClosing || !open || focusRow !== null,
    onDismiss: requestClose,
    contentRef: bodyRef,
    contentDragEnabled: () => Boolean(dialogRef.current?.closest('.app[data-mobile-chrome="true"][data-layout="compact"]')),
  });

  // Closed but mounted (prepared, or after a close): back to what a fresh
  // opening shows — the page at its top — while still hidden, so the
  // opening itself is one class change. A sub-page only suspends the panel:
  // it keeps its place and returns as is.
  const [resumed, setResumed] = useState(false);
  // The saved CSS changed under the editor (reset to defaults, another
  // device): the draft follows it. Typing alone never changes customCss, so
  // an unsaved draft survives ordinary re-renders.
  const committedCssRef = useRef(customCss);
  useLayoutEffect(() => {
    if (committedCssRef.current === customCss) return;
    committedCssRef.current = customCss;
    setCssDraft(customCss);
  }, [customCss]);
  useLayoutEffect(() => {
    if (open) {
      setCssDraft((draft) => (draft === customCss ? draft : customCss));
      return;
    }
    setResumed(suspended);
    if (suspended) return;
    resetSheet();
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, suspended]);
  // The "detailed" warm-up draws the lower part of the page, then puts it back.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && !visible && !suspended) body.scrollTop = warmDetailed ? body.scrollHeight : 0;
  }, [warmDetailed, visible, suspended]);
  const onPreparedRef = useRef(onPrepared);
  onPreparedRef.current = onPrepared;
  const prepared = useRef(false);
  useLayoutEffect(() => {
    if (open || prepared.current) return;
    prepared.current = true;
    // Style and layout at the real size and theme. visibility:hidden is not
    // painted, so this prepares DOM and layout only, not the first raster.
    dialogRef.current?.getBoundingClientRect();
    onPreparedRef.current?.();
  }, [open]);

  const sliderRow = (key: string, label: string, slider: React.ReactNode, value: string, extra?: { before?: React.ReactNode; after?: React.ReactNode; className?: string }) => (
    <div className={`aa-slider-row${extra?.className ? ` ${extra.className}` : ""}`} data-slider-row={key}>
      <span className="aa-row-label">{label}</span>
      {extra?.before}
      {slider}
      {extra?.after}
      <span className="aa-row-value">{value}</span>
    </div>
  );

  const fontSizeIndex = stopIndex(FONT_SIZE_STOPS, fontSize);
  const stepFont = (direction: 1 | -1) => {
    const next = stopValue(FONT_SIZE_STOPS, fontSizeIndex + direction);
    if (next !== undefined && next !== fontSize) onFontSizeChange(clampFontSize(next));
  };

  const sideRow = (side: keyof PageMarginsPx, labelKey: PlainMessageKey) => onPageMarginsChange && sliderRow(
    `margin-${side}`, t(labelKey),
    <StopSlider stops={SIDE_MARGIN_STOPS} value={pageMargins?.[side]} label={t(labelKey)} valueText={sideText(side)}
      onChange={(next) => onPageMarginsChange(withMarginSide(pageMargins, side, next))} />,
    pageMargins?.[side] !== undefined ? `${pageMargins[side]}px` : t("aa.auto"),
  );

  const segmented = <T extends string>(label: string, value: T, options: ReadonlyArray<{ value: T; label: string }>, onChange: (value: T) => void) => (
    <div className="aa-segmented-capsule" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
          className={`aa-segmented-btn${value === option.value ? " active" : ""}`}
          onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );

  // One scrolling page: themes, the two sub-pages, text, layout and turning,
  // Advanced (expands in place), reset, and two quiet links.
  const body = (
    <div className="aa-page-body aa-main-body scrollbar-hidden" ref={bodyRef}>
      <ThemeCards value={theme} onChange={onThemeChange} label={t("aa.themes")}
        custom={customThemes} onEditCustom={setEditingThemeId} />

      <div className="aa-card is-list">
        <button type="button" className="aa-nav-row" onClick={() => onOpenFontSettings()} title={t("aa.font.tip")}>
          <span className="aa-nav-label">{t("aa.font")}</span>
          <span className="aa-nav-value">{customFontName || t("aa.font.default")}</span>
          <ChevronRightIcon size={14} className="aa-chevron" />
        </button>
        {onOpenDisplaySettings && (
          <button type="button" className="aa-nav-row" onClick={onOpenDisplaySettings} title={t("aa.display.tip")}>
            <span className="aa-nav-label">{t("aa.display.entry")}</span>
            <span className="aa-nav-value">{displaySummary ?? ""}</span>
            <ChevronRightIcon size={14} className="aa-chevron" />
          </button>
        )}
      </div>

      <div className="aa-group-title">{t("aa.group.text")}</div>
      <div className="aa-card">
        {sliderRow("font-size", t("aa.fontSize"),
          <StopSlider stops={FONT_SIZE_STOPS} value={fontSize} label={t("aa.fontSize")}
            valueText={`${formatFontSizePx(fontSize)}px`}
            onChange={(next) => { if (next !== undefined) onFontSizeChange(clampFontSize(next)); }} />,
          formatFontSizePx(fontSize),
          {
            before: (
              <button type="button" className="aa-size-btn is-small" onClick={() => stepFont(-1)}
                disabled={fontSizeIndex <= 0} title={t("aa.fontSize.dec.tip")} aria-label={t("aa.fontSize.dec")}>A</button>
            ),
            after: (
              <button type="button" className="aa-size-btn is-large" onClick={() => stepFont(1)}
                disabled={fontSizeIndex >= FONT_SIZE_STOPS.length - 1} title={t("aa.fontSize.inc.tip")} aria-label={t("aa.fontSize.inc")}>A</button>
            ),
            className: "has-steps",
          })}
        {sliderRow("line-height", t("aa.lineHeight"),
          <StopSlider stops={LINE_HEIGHT_STOPS} value={lineHeight} label={t("aa.lineHeight")} valueText={lineHeightText}
            onChange={(next) => {
              if (next === undefined) {
                if (onResetLineHeight) onResetLineHeight();
                else onLineHeightChange(1.7);
              } else onLineHeightChange(next);
            }} />,
          lineHeightText)}
        {onPageMarginsChange && sliderRow("margin-linked", t("aa.margins"),
          <TouchSlider
            className="aa-slider"
            min={0}
            max={MARGIN_LEVEL_COUNT - 1}
            step={1}
            value={marginPosition.index}
            auto={marginPosition.index === 0}
            label={t("aa.margins")}
            valueText={marginText}
            onChange={(next) => {
              if (next !== marginPosition.index || !marginPosition.exact) onPageMarginsChange(marginsForLevel(next));
            }}
          />,
          marginText)}
        {onLetterSpacingChange && sliderRow("letter-spacing", t("aa.letterSpacing.short"),
          <StopSlider stops={LETTER_SPACING_STOPS} value={letterSpacingPx} label={t("aa.letterSpacing")}
            valueText={letterSpacingPx === undefined ? t("aa.followBook") : `${letterSpacingPx}px`}
            onChange={(next) => onLetterSpacingChange(next)} />,
          letterSpacingText)}
        {onFontWeightChange && sliderRow("font-weight", t("aa.weight.short"),
          <StopSlider stops={FONT_WEIGHT_STOPS} value={fontWeight} label={t("aa.weight")}
            valueText={fontWeight === undefined ? t("aa.followBook") : String(fontWeight)}
            onChange={(next) => onFontWeightChange(next)} />,
          fontWeightText)}
      </div>

      <div className="aa-group-title">{t("aa.group.layoutTurning")}</div>
      <div className="aa-card">
        <div className="aa-control-row">
          {segmented(t("aa.presentation.group"), presentation,
            (["single", "spread", "scroll"] as const).map((choice) => ({ value: choice, label: t(`aa.presentation.${choice}` as PlainMessageKey) })),
            handlePresentationClick)}
        </div>
        {presentation === "spread" && effectiveColumns === 1 && (
          <div className="aa-section-note" role="status">{t("aa.presentation.narrow")}</div>
        )}
        {onTurnAnimationChange && presentation !== "scroll" && (
          <div className="aa-control-row">
            <span className="aa-row-label">{t("aa.turnAnimation")}</span>
            {segmented(t("aa.turnAnimation"), turnAnimation,
              TURN_ANIMATION_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
              onTurnAnimationChange)}
          </div>
        )}
        {onPageDirectionChange && (
          <SwitchRow label={t("aa.pageDirectionLtr")} hint={t("aa.pageDirectionLtr.hint")}
            checked={pageDirection === "ltr"} onChange={(checked) => onPageDirectionChange(checked ? "ltr" : "book")} />
        )}
      </div>

      <button type="button" className="aa-group-toggle" aria-expanded={advancedShown} onClick={toggleAdvanced}>
        <span>{t("aa.group.advancedType")}</span>
        <ChevronRightIcon size={14} className="aa-chevron" />
      </button>
      <div className="aa-card" hidden={!advancedShown}>
        {sideRow("top", "aa.margin.top")}
        {sideRow("bottom", "aa.margin.bottom")}
        {sideRow("left", "aa.margin.left")}
        {sideRow("right", "aa.margin.right")}
        {onWordSpacingChange && sliderRow("word-spacing", t("aa.wordSpacing"),
          <StopSlider stops={WORD_SPACING_STOPS} value={wordSpacingPx} label={t("aa.wordSpacing")} valueText={wordSpacingText}
            onChange={(next) => onWordSpacingChange(next)} />,
          wordSpacingPx === undefined ? shortDefault : `${wordSpacingPx}px`)}
        {(onGapPxChange || onSpreadGapModeChange) && (
          <>
            {sliderRow("gap", t("aa.gap"),
              <StopSlider stops={SPREAD_GAP_STOPS} value={spreadGapMode === "manual" ? gapPx : undefined}
                label={t("aa.gap")} valueText={gapText}
                onChange={(next) => {
                  if (next === undefined) {
                    if (onSpreadGapModeChange) onSpreadGapModeChange("auto");
                    else onGapPxChange?.(24);
                  } else onGapPxChange?.(next);
                }} />,
              spreadGapMode === "manual" ? `${gapPx}px` : t("aa.auto"))}
            {presentation !== "spread" && <div className="aa-section-note">{t("aa.gap.spreadOnlyNote")}</div>}
          </>
        )}
        {onForceHorizontalChange && (
          <SwitchRow label={t("aa.forceHorizontal")} hint={t("aa.forceHorizontal.hint")}
            checked={forceHorizontal} onChange={onForceHorizontalChange} />
        )}
        {onCustomCssChange && (
          <>
            <button type="button" className="aa-nav-row is-disclosure" aria-expanded={cssOpen} onClick={() => setCssOpen((value) => !value)}>
              <span className="aa-nav-label">{t("aa.css.inject")}</span>
              <span className="aa-nav-value">{customCss.trim() ? t("aa.css.on") : ""}</span>
              <ChevronRightIcon size={14} className="aa-chevron" />
            </button>
            {cssOpen && (
              <div className="aa-css-editor-section">
                <span className="aa-css-hint">{t("aa.css.hint")}</span>
                <textarea
                  className="aa-css-textarea"
                  rows={3}
                  aria-label={t("aa.css.inject")}
                  placeholder={t("aa.css.placeholderLong")}
                  value={cssDraft}
                  onChange={(e) => setCssDraft(e.target.value)}
                />
                {cssDraft !== customCss && (
                  <button type="button" className="ui-btn is-primary aa-btn-save-css" onClick={() => onCustomCssChange(cssDraft)}>
                    {t("aa.css.save")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {onResetDefaults && (
        <button type="button" className="ui-btn aa-reset-btn" onClick={onResetDefaults} title={t("aa.reset.tip")}>
          <RotateCcwIcon size={13} />
          <span>{t("aa.resetAll")}</span>
        </button>
      )}
      {(onOpenFile || onToggleLog) && (
        <div className="aa-footer-links">
          {onOpenFile && (
            <button type="button" className="ui-text-btn is-muted" onClick={onOpenFile} title={t("aa.importBooks.tip")}>
              {t("aa.importBooks")}
            </button>
          )}
          {onOpenFile && onToggleLog && <span aria-hidden="true">·</span>}
          {onToggleLog && (
            <button type="button" className="ui-text-btn is-muted" onClick={onToggleLog} title={t("aa.log.tip")}>
              {issueCount > 0 ? t("aa.log.count", { count: issueCount }) : t("aa.log")}
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      {visible && (
        <div
          className={`aa-popover-backdrop${isClosing ? " is-closing" : ""}${resumed ? " is-resumed" : ""}`}
          onClick={requestClose}
          aria-hidden="true"
        />
      )}
      {guide && (
        <div className="aa-margin-guide" aria-hidden="true"
          style={{ left: guide.left, right: guide.right, top: guide.top, bottom: guide.bottom }} />
      )}
      <div
        ref={dialogRef}
        className={`aa-popover${visible ? "" : " is-warm"}${!visible && paintWarm ? " is-paint-warm" : ""}${visible && resumed ? " is-resumed" : ""}${isClosing ? " is-closing" : ""}${dragging ? " is-dragging" : ""}`}
        role="dialog"
        tabIndex={-1}
        aria-label={t("aa.dialog")}
        aria-hidden={visible ? undefined : true}
        {...(visible ? {} : { inert: "" })}
      >
        {/* 手机底部面板把手（桌面隐藏） */}
        <div className="aa-sheet-grip" aria-hidden="true" {...grip}>
          <span className="aa-sheet-handle" />
        </div>
        <SliderDragContext.Provider value={sliderHost}>
          {editingTheme && customThemes ? (
            <div className="aa-page-body aa-theme-editor-body scrollbar-hidden">
              <CustomThemeEditor theme={editingTheme} index={editingIndex} controls={customThemes}
                onDone={() => setEditingThemeId(null)}
                head={(
                  <div className="aa-subpage-head">
                    <button type="button" className="aa-back-btn" onClick={() => setEditingThemeId(null)} title={t("aa.back")} aria-label={t("aa.back")}>
                      <ArrowLeftIcon size={14} />
                      <span>{t("aa.back.short")}</span>
                    </button>
                    <span className="aa-subpage-title">{t("aa.customTheme.edit")}</span>
                  </div>
                )} />
            </div>
          ) : body}
        </SliderDragContext.Provider>
      </div>
    </>
  );
});
