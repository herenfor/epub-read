import {
  DEFAULT_PAGE_GAP_PX,
  PAGE_GAP_MAX_PX,
  PAGE_GAP_STEP_PX,
  PAGE_MARGIN_MAX_PX,
  PAGE_MARGIN_STEP_PX,
  autoPageMarginsPx,
  type PageMarginsPx,
  type PageOptionsValue,
} from "../render/pageLayout";
import { MinusIcon, PlusIcon, RotateCcwIcon } from "./readerIcons";
import { stepSettingValue } from "./settingsStepper";
import "./pageOptions.css";

export interface PageOptionsPanelProps {
  value: PageOptionsValue;
  /** 当前窗口实际可用的栏数（窄窗回退后）；只用于提示，不回写保存值 */
  effectiveColumns: 1 | 2;
  /** 固定版式书籍：禁用页面重排控件并显示“不适用” */
  fixedLayout: boolean;
  /** 用于显示“自动”上下留白：2.2em / 1.6em × 字号 */
  fontSizePx: number;
  onChange(value: PageOptionsValue): void;
}

type MarginSide = keyof PageMarginsPx;

interface PagePatch {
  pageMarginsPx?: PageMarginsPx;
  gapPx?: number;
  columnsPerView?: 1 | 2;
}

function buildSteps(max: number, step: number): number[] {
  const steps: number[] = [];
  for (let value = 0; value <= max; value += step) steps.push(value);
  return steps;
}

const MARGIN_STEPS = buildSteps(PAGE_MARGIN_MAX_PX, PAGE_MARGIN_STEP_PX);
const GAP_STEPS = buildSteps(PAGE_GAP_MAX_PX, PAGE_GAP_STEP_PX);

const MARGIN_LABELS: Record<MarginSide, string> = {
  top: "上边距",
  bottom: "下边距",
  left: "左边距",
  right: "右边距",
};

const GAP_LABEL = "额外边距（列间距）";
const COLUMNS_LABEL = "分栏数";

interface PageOptionRowProps {
  label: string;
  valueText: string;
  hint?: string;
  canDec: boolean;
  canInc: boolean;
  onDec(): void;
  onInc(): void;
  onReset?(): void;
}

/** 受控步进行：原生按钮 + aria-label，边界由调用方禁用，不持有本地状态。 */
function PageOptionRow(props: PageOptionRowProps) {
  return (
    <div className="page-options-row">
      <div className="page-options-row-text">
        <span className="page-options-label">{props.label}</span>
        {props.hint && <span className="page-options-hint">{props.hint}</span>}
      </div>
      <span className="page-options-value">{props.valueText}</span>
      {props.onReset && (
        <button
          className="page-options-reset"
          onClick={props.onReset}
          title={`重置${props.label}为自动`}
          aria-label={`重置${props.label}`}
        >
          <RotateCcwIcon size={13} />
        </button>
      )}
      <div className="page-options-steppers">
        <button
          className="page-options-step"
          onClick={props.onDec}
          disabled={!props.canDec}
          title={`减小${props.label}`}
          aria-label={`减小${props.label}`}
        >
          <MinusIcon size={15} />
        </button>
        <button
          className="page-options-step"
          onClick={props.onInc}
          disabled={!props.canInc}
          title={`增大${props.label}`}
          aria-label={`增大${props.label}`}
        >
          <PlusIcon size={15} />
        </button>
      </div>
    </div>
  );
}

/**
 * 页面设置面板（四边距 / 列间距 / 分栏数）。
 *
 * 完全受控：每次操作都返回完整 {@link PageOptionsValue}，由父组件合并到现有
 * settings 并用已有的 settingsReloadDebouncer 统一提交；本组件不做第二套
 * 持久化或延迟。`readingMode` 只用于禁用滚动模式下不生效的控件，并原样保留。
 */
export function PageOptionsPanel(props: PageOptionsPanelProps) {
  const { value } = props;
  const scrollMode = value.readingMode === "scroll";
  const reflowDisabled = props.fixedLayout;
  const columnControlsDisabled = reflowDisabled || scrollMode;
  const auto = autoPageMarginsPx(props.fontSizePx);

  const commit = (patch: PagePatch): void => {
    const next: PageOptionsValue = { gapPx: patch.gapPx ?? value.gapPx };
    if (value.readingMode) next.readingMode = value.readingMode;

    const margins = "pageMarginsPx" in patch ? patch.pageMarginsPx : value.pageMarginsPx;
    if (margins && Object.keys(margins).length > 0) next.pageMarginsPx = margins;

    const columns = "columnsPerView" in patch ? patch.columnsPerView : value.columnsPerView;
    if (columns !== undefined) next.columnsPerView = columns;

    props.onChange(next);
  };

  const marginValue = (side: MarginSide): number | undefined => value.pageMarginsPx?.[side];
  const marginAutoValue = (side: MarginSide): number =>
    side === "top" ? auto.top : side === "bottom" ? auto.bottom : 0;

  const setMargin = (side: MarginSide, next: number | undefined): void => {
    const margins: PageMarginsPx = { ...(value.pageMarginsPx ?? {}) };
    if (next === undefined) delete margins[side];
    else margins[side] = next;
    commit({ pageMarginsPx: margins });
  };

  const marginValueText = (side: MarginSide): string => {
    const explicit = marginValue(side);
    if (explicit !== undefined) return `${explicit}px`;
    return marginAutoValue(side) > 0 ? `自动（${marginAutoValue(side)}px）` : "自动";
  };

  const marginRow = (side: MarginSide) => (
    <PageOptionRow
      key={side}
      label={MARGIN_LABELS[side]}
      valueText={marginValueText(side)}
      canDec={!reflowDisabled && (marginValue(side) ?? marginAutoValue(side)) > 0}
      canInc={!reflowDisabled && (marginValue(side) ?? marginAutoValue(side)) < PAGE_MARGIN_MAX_PX}
      onDec={() => setMargin(side, stepSettingValue(MARGIN_STEPS, marginValue(side), -1, marginAutoValue(side)))}
      onInc={() => setMargin(side, stepSettingValue(MARGIN_STEPS, marginValue(side), 1, marginAutoValue(side)))}
      onReset={marginValue(side) === undefined ? undefined : () => setMargin(side, undefined)}
    />
  );

  const requestedColumns = value.columnsPerView ?? 1;
  const columnsHint = scrollMode
    ? "滚动模式不可用"
    : value.columnsPerView === 2 && props.effectiveColumns === 1
      ? "当前窗口使用单栏"
      : undefined;

  return (
    <div className="page-options-panel" role="group" aria-label="页面设置">
      <div className="menu-section">页面</div>
      <div className="page-options-card">
        {marginRow("top")}
        {marginRow("bottom")}
        {marginRow("left")}
        {marginRow("right")}
        <PageOptionRow
          label={GAP_LABEL}
          valueText={`${value.gapPx}px`}
          hint={scrollMode ? "滚动模式不可用" : undefined}
          canDec={!columnControlsDisabled && value.gapPx > 0}
          canInc={!columnControlsDisabled && value.gapPx < PAGE_GAP_MAX_PX}
          onDec={() => commit({ gapPx: stepSettingValue(GAP_STEPS, value.gapPx, -1, value.gapPx) })}
          onInc={() => commit({ gapPx: stepSettingValue(GAP_STEPS, value.gapPx, 1, value.gapPx) })}
        />
        <PageOptionRow
          label={COLUMNS_LABEL}
          valueText={`${requestedColumns}`}
          hint={columnsHint}
          canDec={!columnControlsDisabled && requestedColumns === 2}
          canInc={!columnControlsDisabled && requestedColumns === 1}
          onDec={() => commit({ columnsPerView: 1 })}
          onInc={() => commit({ columnsPerView: 2 })}
        />
      </div>
      {reflowDisabled && (
        <div className="page-options-note" role="status">
          固定版式书籍不适用页面设置
        </div>
      )}
      {!reflowDisabled && scrollMode && (
        <div className="page-options-note" role="status">
          滚动模式下分栏与列间距不生效，设置已保留
        </div>
      )}
      <button
        className="page-options-reset-all"
        onClick={() => commit({ pageMarginsPx: undefined, gapPx: DEFAULT_PAGE_GAP_PX, columnsPerView: undefined })}
        title="恢复页面默认（不影响字号、字体、主题与阅读模式）"
        aria-label="恢复页面默认"
      >
        恢复页面默认
      </button>
    </div>
  );
}
