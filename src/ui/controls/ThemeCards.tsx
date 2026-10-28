import type { CSSProperties } from "react";
import { READER_PALETTES } from "../../config/readerPalette";
import type { Theme } from "../../render/settings";
import type { PlainMessageKey } from "../localization/core";
import { useUiText } from "../localization/UiLanguageProvider";

/** The four themes in display order, named as paper colors (白底 / 羊皮纸 / 深灰 / 暗夜). */
export const THEME_CHOICES: ReadonlyArray<{ id: Theme; nameKey: PlainMessageKey }> = [
  { id: "light", nameKey: "aa.theme.light" },
  { id: "sepia", nameKey: "aa.theme.sepia" },
  { id: "gray", nameKey: "aa.theme.gray" },
  { id: "dark", nameKey: "aa.theme.dark" },
];

/** One theme picker for Settings › Appearance and Aa: an "Aa" sample on each paper, with its name. */
export function ThemeCards(props: { value: Theme; onChange(theme: Theme): void; label: string; disabled?: boolean }) {
  const { t } = useUiText();
  return <div className="ui-theme-cards" role="radiogroup" aria-label={props.label}>
    {THEME_CHOICES.map((choice) => {
      const palette = READER_PALETTES[choice.id];
      const active = props.value === choice.id;
      return <button key={choice.id} type="button" role="radio" aria-checked={active}
        className={`ui-theme-card${active ? " active" : ""}`}
        style={{
          "--swatch-bg": palette.background,
          "--swatch-fg": palette.uiForeground,
          "--swatch-border": palette.previewBorder,
        } as CSSProperties}
        title={t("aa.theme.tip", { name: t(choice.nameKey) })}
        disabled={props.disabled} onClick={() => props.onChange(choice.id)}>
        <span className="ui-theme-card-sample" aria-hidden="true">Aa</span>
        <span>{t(choice.nameKey)}</span>
      </button>;
    })}
  </div>;
}
