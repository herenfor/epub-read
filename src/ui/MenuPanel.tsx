import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Theme } from "../render/settings";
import type { PageOptionsValue, ReadingMode } from "../render/pageLayout";
import { PageOptionsPanel } from "./PageOptionsPanel";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  WrenchIcon,
} from "./readerIcons";

export interface MenuPanelProps {
  fontSize: number;
  uiScale: number;
  theme: Theme;
  lineHeight?: number;
  fontWeight?: number;
  letterSpacingPx?: number;
  wordSpacingPx?: number;
  /** 当前选择的用户自定义字体 family */
  customFontName?: string;
  /** 用户自定义 CSS 文本 */
  customCss?: string;
  /** 可重排章节是否强制覆盖为横排 */
  forceHorizontal: boolean;
  /** 是否预先准备下一章以加快顺序切换；由上层决定固定版式是否禁用 */
  preloadNextChapter?: boolean;
  /** 固定版式等场景由上层决定是否禁用此开关 */
  preloadNextChapterDisabled?: boolean;
  /** 阅读方式：翻页 / 当前章纵向滚动（App 持有状态） */
  readingMode: ReadingMode;
  onReadingModeChange(mode: ReadingMode): void;
  /** 页面选项（B 的受控面板；C 负责合并到设置并持久化） */
  pageOptions: PageOptionsValue;
  /** 当前窗口实际可用栏数；窄窗回退只提示，不回写保存值 */
  pageEffectiveColumns: 1 | 2;
  /** 固定版式：页面重排控件显示“不适用” */
  pageFixedLayout: boolean;
  onPageOptionsChange(value: PageOptionsValue): void;
  userFonts: Array<{ id: string; fileName: string; family: string }>;
  fontBusy: boolean;
  onImportFont(file: File): void;
  onDeleteFont(id: string): void;
  onCustomFontNameChange(name: string): void;
  onCustomCssChange(css: string): void;
  onOpenFontSettings(): void;
  onForceHorizontalChange(enabled: boolean): void;
  onPreloadNextChapterChange?(enabled: boolean): void;
  onOpenFile(): void;
  onFontDec(): void;
  onFontInc(): void;
  onFontSizeChange(v: number): void;
  onLineHeightDec(): void;
  onLineHeightInc(): void;
  onLineHeightChange(v: number): void;
  onWeightDec(): void;
  onWeightInc(): void;
  onWeightChange(v: number): void;
  onLetterSpacingDec(): void;
  onLetterSpacingInc(): void;
  onLetterSpacingChange(v: number): void;
  onWordSpacingDec(): void;
  onWordSpacingInc(): void;
  onWordSpacingChange(v: number): void;
  onUiScaleChange(v: number): void;
  onThemeChange(theme: Theme): void;
  onResetDefaults(): void;
  onClose(): void;
  issueCount?: number;
  onToggleLog?(): void;
}

/** 只有草稿与已保存值不同才允许触发一次整章重载。 */
export function isCustomCssDraftDirty(draft: string, saved: string): boolean {
  return draft !== saved;
}

/** 开关的辅助文案保持和实际行为一致，供菜单与纯逻辑测试复用。 */
export function forceHorizontalModeDescription(enabled: boolean): string {
  return enabled ? "竖排转横排" : "跟随书籍";
}

/** 快速章节切换开关的辅助文案，供菜单与纯逻辑测试复用。 */
export function preloadNextChapterModeDescription(enabled: boolean, disabled = false): string {
  if (disabled) return "当前不可用";
  return enabled ? "预先准备相邻章节" : "按需加载";
}

const UI_SCALES: Array<{ value: number; label: string }> = [
  { value: 0.85, label: "小" },
  { value: 1, label: "标准" },
  { value: 1.15, label: "大" },
  { value: 1.3, label: "特大" },
];

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "sepia", label: "纸色" },
];

const READING_MODE_OPTIONS: Array<{ value: ReadingMode; label: string; title: string }> = [
  { value: "paginated", label: "翻页", title: "按页翻页阅读" },
  { value: "scroll", label: "滚动", title: "当前章节纵向滚动" },
];

function fmtLineHeight(v?: number): string {
  return v === undefined ? "自动" : v.toFixed(1);
}

function fmtWeight(v?: number): string {
  if (v === undefined) return "自动";
  if (v <= 300) return "细体";
  if (v <= 400) return "常规";
  if (v <= 500) return "中等";
  if (v <= 600) return "半粗";
  return "粗体";
}

function fmtPx(v?: number): string {
  return v === undefined ? "自动" : `${v}px`;
}

interface SliderRowProps {
  label: string;
  /** 拖动条上方数值的格式化显示（基于预览值实时更新） */
  formatValue(v: number): string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(v: number): void;
  onDec(): void;
  onInc(): void;
}

/**
 * 排版行：小 −/+ 按钮 + 中间拖动条，数值显示在拖动条上方。
 * 拖动只做本地预览；原生 change（松开鼠标/键盘确认/失焦）才提交，
 * 避免拖动过程中每次 input 都触发整章重排。
 */
function SliderRow(props: SliderRowProps) {
  const [draft, setDraft] = useState(props.value);
  const inputRef = useRef<HTMLInputElement>(null);
  const latestValueRef = useRef(props.value);
  latestValueRef.current = props.value;

  // 外部值变化（± 按钮、恢复默认等）时同步预览值
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);

  // 原生 change 事件：拖动条松开/键盘一次修改完成/失焦时各触发一次
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const commit = (): void => {
      const v = Number(el.value);
      if (Number.isFinite(v) && v !== latestValueRef.current) props.onChange(v);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [props.onChange]);

  const pct =
    ((draft - props.min) / (props.max - props.min)) * 100;

  return (
    <div className="slider-row menu-control-card">
      <span className="menu-label">{props.label}</span>
      <div className="slider-main">
        <span className="slider-value">{props.formatValue(draft)}</span>
        <div className="slider-line">
          <button className="step-btn" onClick={props.onDec} title="上一档" aria-label="上一档">
            <MinusIcon size={12} />
          </button>
          <input
            ref={inputRef}
            type="range"
            min={props.min}
            max={props.max}
            step={props.step}
            value={draft}
            style={
              {
                "--fill": `${Math.min(100, Math.max(0, pct))}%`,
              } as CSSProperties
            }
            onChange={(e) => setDraft(Number(e.target.value))}
          />
          <button className="step-btn" onClick={props.onInc} title="下一档" aria-label="下一档">
            <PlusIcon size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 左侧滑出的二级菜单：收纳文件/导航/正文排版/界面/外观等操作。 */
export function MenuPanel(props: MenuPanelProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [customCssDraft, setCustomCssDraft] = useState(props.customCss ?? "");

  // 新挂载从已保存值开始；恢复默认或其他外部设置变化也应覆盖草稿。
  useEffect(() => {
    setCustomCssDraft(props.customCss ?? "");
  }, [props.customCss]);

  const savedCustomCss = props.customCss ?? "";
  const customCssDirty = isCustomCssDraftDirty(customCssDraft, savedCustomCss);
  return (
    <div className="menu-panel" role="dialog" aria-modal="true" aria-label="设置与外观">
      <div className="drawer-drag-handle" aria-hidden="true" />
      <div className="menu-head">
        <div className="drawer-title-wrap">
          <span>设置与外观</span>
        </div>
        <button className="tb-btn tb-close" onClick={props.onClose} title="关闭设置" aria-label="关闭设置">
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="menu-section">文件</div>
      <button className="menu-item" onClick={props.onOpenFile}>
        导入新书
      </button>

      <div className="menu-section">正文</div>
      <SliderRow
        label="字号"
        formatValue={(v) => `${v}px`}
        min={12}
        max={32}
        step={2}
        value={props.fontSize}
        onChange={props.onFontSizeChange}
        onDec={props.onFontDec}
        onInc={props.onFontInc}
      />
      <button
        className={`menu-item detail-toggle${detailOpen ? " open" : ""}`}
        onClick={() => setDetailOpen((v) => !v)}
        title="展开/收起详细排版设置"
        aria-expanded={detailOpen}
      >
        <span>详细设置</span>
        <span className="detail-arrow">
          {detailOpen ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
        </span>
      </button>
      {detailOpen && (
      <div className="detail-body">
      <SliderRow
        label="行高"
        formatValue={fmtLineHeight}
        min={1.4}
        max={2.2}
        step={0.2}
        value={props.lineHeight ?? 1.6}
        onChange={props.onLineHeightChange}
        onDec={props.onLineHeightDec}
        onInc={props.onLineHeightInc}
      />
      <SliderRow
        label="字重"
        formatValue={fmtWeight}
        min={300}
        max={700}
        step={100}
        value={props.fontWeight ?? 400}
        onChange={props.onWeightChange}
        onDec={props.onWeightDec}
        onInc={props.onWeightInc}
      />
      <SliderRow
        label="字间距"
        formatValue={fmtPx}
        min={0}
        max={8}
        step={2}
        value={props.letterSpacingPx ?? 0}
        onChange={props.onLetterSpacingChange}
        onDec={props.onLetterSpacingDec}
        onInc={props.onLetterSpacingInc}
      />
      <SliderRow
        label="字符间距"
        formatValue={fmtPx}
        min={0}
        max={16}
        step={4}
        value={props.wordSpacingPx ?? 0}
        onChange={props.onWordSpacingChange}
        onDec={props.onWordSpacingDec}
        onInc={props.onWordSpacingInc}
      />

      <label className="menu-toggle-row menu-control-card">
        <span>
          <span className="menu-label">强制横排</span>
          <span className="menu-toggle-hint" id="force-horizontal-hint">
            {forceHorizontalModeDescription(props.forceHorizontal)}
          </span>
        </span>
        <span className="switch-control">
          <input
            type="checkbox"
            checked={props.forceHorizontal}
            onChange={(e) => props.onForceHorizontalChange(e.target.checked)}
            aria-label="强制横排"
            aria-describedby="force-horizontal-hint"
          />
          <span className="switch-track" aria-hidden="true" />
        </span>
      </label>

      <label className="menu-toggle-row menu-control-card">
        <span>
          <span className="menu-label">高性能模式</span>
          <span className="menu-toggle-hint" id="preload-next-chapter-hint">
            {preloadNextChapterModeDescription(props.preloadNextChapter === true, props.preloadNextChapterDisabled === true)}
          </span>
        </span>
        <span className="switch-control">
          <input
            type="checkbox"
            checked={props.preloadNextChapter === true}
            disabled={props.preloadNextChapterDisabled === true}
            onChange={(e) => props.onPreloadNextChapterChange?.(e.target.checked)}
            aria-label="高性能模式"
            aria-describedby="preload-next-chapter-hint"
          />
          <span className="switch-track" aria-hidden="true" />
        </span>
      </label>

      <div className="menu-subsection">字体</div>
      <button className="menu-item detail-action-card" onClick={props.onOpenFontSettings}>
        {props.customFontName ? `当前：${props.customFontName}` : "跟随书籍"} · 打开字体设置
      </button>

      <div className="menu-subsection">自定义 CSS</div>
      <textarea
        className="custom-css-input detail-editor-card"
        rows={5}
        placeholder="/* 这里写任意 CSS，会注入到正文顶部样式之后，可覆盖阅读器规则 */\nbody { color: red !important; }"
        value={customCssDraft}
        onChange={(e) => setCustomCssDraft(e.target.value)}
        spellCheck={false}
      />
      <button
        className="menu-item detail-action-card"
        onClick={() => props.onCustomCssChange(customCssDraft)}
        disabled={!customCssDirty}
        title={customCssDirty ? "保存草稿并重新应用自定义 CSS" : "没有未保存的 CSS 修改"}
      >
        保存并应用
      </button>
      </div>
      )}

      <div className="menu-section">阅读方式</div>
      <div className="theme-row">
        {READING_MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`theme-btn${props.readingMode === opt.value ? " active" : ""}`}
            onClick={() => props.onReadingModeChange(opt.value)}
            title={opt.title}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <PageOptionsPanel
        value={props.pageOptions}
        effectiveColumns={props.pageEffectiveColumns}
        fixedLayout={props.pageFixedLayout}
        fontSizePx={props.fontSize}
        onChange={props.onPageOptionsChange}
      />

      <div className="menu-section">界面</div>
      <div className="theme-row">
        {UI_SCALES.map((opt) => (
          <button
            key={opt.value}
            className={`theme-btn${Math.abs(props.uiScale - opt.value) < 0.001 ? " active" : ""}`}
            onClick={() => props.onUiScaleChange(opt.value)}
            title={`界面缩放 ${Math.round(opt.value * 100)}%`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="menu-section">外观</div>
      <div className="theme-row">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`theme-btn${props.theme === opt.value ? " active" : ""}`}
            onClick={() => props.onThemeChange(opt.value)}
            title={`切换到${opt.label}主题`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="menu-section">其他</div>
      {props.onToggleLog && (
        <button
          className="menu-item log-btn"
          onClick={props.onToggleLog}
          title="打开日志与诊断面板"
          aria-label="日志与诊断"
        >
          <WrenchIcon size={14} />
          <span>日志与诊断</span>
          {props.issueCount !== undefined && props.issueCount > 0 ? (
            <span className="issue-badge">{props.issueCount}</span>
          ) : null}
        </button>
      )}
      <button className="menu-item reset-btn" onClick={props.onResetDefaults} title="恢复所有设置为默认值" aria-label="恢复默认设置">
        <RotateCcwIcon size={14} />
        <span>恢复默认设置</span>
      </button>
    </div>
  );
}
