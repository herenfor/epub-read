import { useRef, type ReactNode } from "react";
import { ArrowLeftIcon } from "./readerIcons";
import { useSheetDrag } from "./sheetDrag";
import { useScrollEdgeFade } from "./scrollEdgeFade";
import { useSliderFocus } from "./sliderFocus";
import { SliderDragContext } from "./TouchSlider";
import "./aaPopover.css";
import "./readerDisplaySettings.css";
import { useUiText } from "./localization/UiLanguageProvider";

export interface ReaderDisplaySettingsPopoverProps {
  /** 回到 Aa 主面板（Aa 原位恢复，不重放入场）。 */
  onBack(): void;
  children: ReactNode;
}

/**
 * “字符与滤镜”是 Aa 的子页，与字体页同一外壳（font-settings-panel）：同样的
 * 位置、高度、把手与标题栏。把手下拉和左上返回都回到 Aa 主页，不关闭整个 Aa；
 * 遮罩用 Aa 菜单共用的那层。
 */
export function ReaderDisplaySettingsPopover({ onBack, children }: ReaderDisplaySettingsPopoverProps) {
  const { t } = useUiText();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { dragging, grip } = useSheetDrag({ sheetRef: panelRef, onDismiss: onBack });
  useScrollEdgeFade(bodyRef);
  // Brightness, dim and the other filter sliders: hold one and only its row stays.
  const sliderHost = useSliderFocus(panelRef);

  return (
    <div
      ref={panelRef}
      className={`font-settings-panel aa-display-panel${dragging ? " is-dragging" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("display.dialog")}
    >
      <div className="drawer-drag-handle font-settings-grip" aria-hidden="true" {...grip} />
      <div className="menu-head font-settings-head">
        <button className="tb-btn tb-close" onClick={onBack} title={t("display.back.tip")} aria-label={t("display.back")}>
          <ArrowLeftIcon size={14} />
        </button>
        <div className="drawer-title-wrap">
          <span>{t("display.title")}</span>
        </div>
      </div>
      <SliderDragContext.Provider value={sliderHost}>
        <div className="aa-display-body scrollbar-hidden" ref={bodyRef}>{children}</div>
      </SliderDragContext.Provider>
    </div>
  );
}
