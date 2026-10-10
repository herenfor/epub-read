import { useCallback, useState, type ReactNode } from "react";
import { MENU_CLOSE_MS } from "./menuMotion";
import { ArrowLeftIcon, CloseIcon } from "./readerIcons";
import "./aaPopover.css";
import "./readerDisplaySettings.css";
import { useUiText } from "./localization/UiLanguageProvider";

export interface ReaderDisplaySettingsPopoverProps {
  /** 回到 Aa 主面板（不播放退场，主面板自带入场）。 */
  onBack(): void;
  onClose(): void;
  children: ReactNode;
}

/**
 * “字符与画面”是 Aa 面板的子页：沿用同一外壳（位置、材质、遮罩、入退场、
 * 手机底部面板与触摸尺寸），只替换头部与内容。
 */
export function ReaderDisplaySettingsPopover({ onBack, onClose, children }: ReaderDisplaySettingsPopoverProps) {
  const { t } = useUiText();
  const [isClosing, setIsClosing] = useState(false);
  const requestClose = useCallback(() => {
    setIsClosing(true);
    // 与 aaPopover.css 退场动画（--menu-close）一致；遮罩随 .is-closing 同步淡出。
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, MENU_CLOSE_MS);
  }, [onClose]);

  return (
    <>
      <div
        className={`aa-popover-backdrop${isClosing ? " is-closing" : ""}`}
        onClick={requestClose}
        aria-hidden="true"
      />
      <div
        className={`aa-popover aa-display-popover${isClosing ? " is-closing" : ""}`}
        role="dialog"
        aria-label={t("display.dialog")}
      >
        <div className="aa-popover-header aa-display-header">
          <button
            type="button"
            className="aa-popover-close-btn"
            onClick={onBack}
            title={t("display.back.tip")}
            aria-label={t("display.back")}
          >
            <ArrowLeftIcon size={14} />
          </button>
          <span className="aa-popover-title">{t("display.title")}</span>
          <button
            type="button"
            className="aa-popover-close-btn"
            onClick={requestClose}
            title={t("display.close.tip")}
            aria-label={t("display.close")}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="aa-popover-body aa-display-body">{children}</div>
      </div>
    </>
  );
}
