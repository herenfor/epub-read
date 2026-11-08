import { useState } from "react";
import { useUiText } from "./localization/UiLanguageProvider";
import { CUSTOM_COLOR_PRESETS, highlightColorProps, parseHexInput } from "./highlightModel";
import type { NoteColor } from "./notes";

export interface HighlightColorPickerProps {
  /** The current custom color, or null when the slot is still empty. */
  initial: string | null;
  onUse(hex: string): void;
  onCancel(): void;
}

/**
 * The custom color panel (ER-0106): drawn by the app on every platform, no
 * system color dialog. Common colors, a hex field and a light/dark paper preview.
 */
export function HighlightColorPicker({ initial, onUse, onCancel }: HighlightColorPickerProps) {
  const { t } = useUiText();
  const [text, setText] = useState(initial ?? CUSTOM_COLOR_PRESETS[0]);
  const hex = parseHexInput(text);
  const sample = highlightColorProps(hex ? hex as NoteColor : undefined);
  return (
    <div className="hl-picker" role="group" aria-label={t("readerMisc.highlight.customTitle")}>
      <div className="hl-picker-presets">
        {CUSTOM_COLOR_PRESETS.map((preset) => (
          <button key={preset} type="button" className={`hl-swatch${hex === preset ? " is-current" : ""}`}
            aria-label={preset} aria-pressed={hex === preset} onClick={() => setText(preset)}>
            <span className="hl-dot" style={{ background: preset }} />
          </button>
        ))}
      </div>
      <label className="hl-picker-hex">
        <span>{t("readerMisc.highlight.hexLabel")}</span>
        <input value={text} spellCheck={false} autoComplete="off" maxLength={7}
          aria-invalid={hex === null}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && hex) onUse(hex); }} />
      </label>
      <div className="hl-picker-preview" aria-hidden="true">
        <span className="hl-paper-light"><span className={`hl-s-highlight ${sample.className}`} style={sample.style}>{t("readerMisc.highlight.previewLight")}</span></span>
        <span className="hl-paper-dark"><span className={`hl-s-highlight ${sample.className}`} style={sample.style}>{t("readerMisc.highlight.previewDark")}</span></span>
      </div>
      <div className="hl-picker-actions">
        <button type="button" onClick={onCancel}>{t("readerMisc.highlight.cancel")}</button>
        <button type="button" className="is-primary" disabled={!hex} onClick={() => { if (hex) onUse(hex); }}>{t("readerMisc.highlight.use")}</button>
      </div>
    </div>
  );
}
