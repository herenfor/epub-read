import React, { useEffect, useState } from "react";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import { subscribeBattery, type BatteryStatus } from "../platform/batteryStatus";
import "./batteryIndicator.css";
import { useUiText } from "./localization/UiLanguageProvider";

export interface BatteryIndicatorProps {
  /**
   * Integration-owned user switch. Defaults to enabled, but this component
   * still renders nothing outside an actual Android app platform.
   */
  enabled?: boolean;
  className?: string;
}

export const BatteryIndicator: React.FC<BatteryIndicatorProps> = ({
  enabled = true,
  className,
}) => {
  const { t } = useUiText();
  const runtime = getRuntimeCapabilities();
  const shouldRender = enabled && runtime.platform === "android";
  const [status, setStatus] = useState<BatteryStatus | null>(null);

  useEffect(() => {
    if (!shouldRender) {
      setStatus(null);
      return;
    }
    return subscribeBattery((next) => setStatus(next));
  }, [shouldRender]);

  if (!shouldRender) return null;

  const levelPct = status?.levelPct ?? null;
  const charging = status?.charging === true;
  const levelLabel = levelPct === null ? "—" : `${levelPct}%`;
  const label =
    levelPct === null
      ? charging
        ? t("readerMisc.battery.chargingUnknown")
        : t("readerMisc.battery.unknown")
      : t(charging ? "readerMisc.battery.chargingLevel" : "readerMisc.battery.level", { percent: levelPct });

  const fillWidth =
    levelPct === null ? 0 : Math.max(0, Math.min(17.3, (levelPct / 100) * 17.3));

  return (
    <span
      className={`battery-indicator${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <svg
        className="battery-indicator__icon"
        viewBox="0 0 26 14"
        aria-hidden="true"
        focusable="false"
      >
        <rect className="battery-indicator__shell" x="1" y="1" width="21.5" height="12" rx="3" />
        <rect className="battery-indicator__terminal" x="23.5" y="4.5" width="2.25" height="5" rx="1" />
        {levelPct !== null && (
          <rect
            className="battery-indicator__fill"
            x="3.2"
            y="3.2"
            width={fillWidth}
            height="7.6"
            rx="1.8"
          />
        )}
        {charging && (
          <path
            className="battery-indicator__bolt"
            d="M13.8 1.8 9.2 8.1h3.1l-1 4.1 4.8-6.7h-3.2l1-3.7Z"
          />
        )}
      </svg>
      <span className="battery-indicator__level" aria-hidden="true">
        {levelLabel}
      </span>
    </span>
  );
};
