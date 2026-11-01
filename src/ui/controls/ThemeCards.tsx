import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { READER_PALETTES } from "../../config/readerPalette";
import { MAX_CUSTOM_THEMES, customReaderPalette, type CustomTheme } from "../../config/customThemes";
import type { BuiltinTheme, Theme } from "../../render/settings";
import type { PlainMessageKey } from "../localization/core";
import { useUiText } from "../localization/UiLanguageProvider";
import type { CustomThemeControls } from "../useCustomThemes";

/** The four themes in display order, named as paper colors (白底 / 羊皮纸 / 深灰 / 暗夜). */
export const THEME_CHOICES: ReadonlyArray<{ id: BuiltinTheme; nameKey: PlainMessageKey }> = [
  { id: "light", nameKey: "aa.theme.light" },
  { id: "sepia", nameKey: "aa.theme.sepia" },
  { id: "gray", nameKey: "aa.theme.gray" },
  { id: "dark", nameKey: "aa.theme.dark" },
];

/** A custom theme's shown name; an empty one reads as the default name. */
export function customThemeName(theme: CustomTheme, fallback: string): string {
  return theme.name.trim() || fallback;
}

/** Which sides of a horizontal scroller still hide cards ("left", "right", both or neither). */
function useHorizontalEdgeFade(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const left = element.scrollLeft > 1;
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      const state = [left ? "left" : "", right ? "right" : ""].filter(Boolean).join(" ");
      if (element.getAttribute("data-hfade") !== state) element.setAttribute("data-hfade", state);
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(update); };
    update();
    element.addEventListener("scroll", schedule, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(element);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
      resize?.disconnect();
      element.removeAttribute("data-hfade");
    };
  }, [enabled]);
  return ref;
}

/** A press that moves this far is a drag of the row, not a click on a card. */
const ROW_DRAG_THRESHOLD_PX = 5;

/**
 * A mouse reaches the cards a sideways row hides: the wheel scrolls the row
 * until its end, then the page around it scrolls on; a press-and-drag pans it
 * and the card under the release is not chosen. Touch keeps native scrolling.
 */
function useRowMouseScroll(ref: { current: HTMLDivElement | null }, enabled: boolean) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const room = delta > 0
        ? element.scrollWidth - element.clientWidth - element.scrollLeft
        : element.scrollLeft;
      if (room <= 1) return;
      event.preventDefault();
      // A wheel notch glides; a touchpad's small steps follow the fingers.
      element.scrollBy({ left: delta, behavior: Math.abs(delta) >= 50 ? "smooth" : "auto" });
    };
    let press: { pointerId: number; x: number; scrollLeft: number; dragging: boolean } | null = null;
    let swallowClick = false;
    const onPointerDown = (event: PointerEvent) => {
      swallowClick = false;
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (element.scrollWidth <= element.clientWidth + 1) return;
      press = { pointerId: event.pointerId, x: event.clientX, scrollLeft: element.scrollLeft, dragging: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return;
      const dx = event.clientX - press.x;
      if (!press.dragging) {
        if (Math.abs(dx) < ROW_DRAG_THRESHOLD_PX) return;
        press.dragging = true;
        element.setPointerCapture?.(event.pointerId);
        element.classList.add("is-dragging");
      }
      element.scrollLeft = press.scrollLeft - dx;
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return;
      swallowClick = press.dragging;
      press = null;
      // The click, if any, follows the release at once; a later one is real.
      if (swallowClick) setTimeout(() => { swallowClick = false; }, 0);
      element.classList.remove("is-dragging");
    };
    const onClickCapture = (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerEnd);
    element.addEventListener("pointercancel", onPointerEnd);
    element.addEventListener("click", onClickCapture, true);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
      element.removeEventListener("click", onClickCapture, true);
      element.classList.remove("is-dragging");
    };
  }, [ref, enabled]);
}

/**
 * One theme picker for Settings › Appearance and Aa: an "Aa" sample on each
 * paper, with its name. With custom themes the row ("row") scrolls sideways
 * and the grid ("grid") wraps; the selected custom theme carries a pencil
 * that opens its editor, and the last card creates one (up to the limit).
 */
export function ThemeCards(props: {
  value: Theme;
  onChange(theme: Theme): void;
  label: string;
  disabled?: boolean;
  custom?: CustomThemeControls;
  /** Opens the editor for a custom theme (also right after creating one). */
  onEditCustom?(id: string): void;
  layout?: "row" | "grid";
}) {
  const { t } = useUiText();
  const custom = props.custom;
  const scrolls = Boolean(custom) && props.layout !== "grid";
  const rowRef = useHorizontalEdgeFade(scrolls);
  useRowMouseScroll(rowRef, scrolls);
  const activeId = custom?.activeId ?? null;
  // Keep the selected card in view when the row opens or the selection moves.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!scrolls || !row) return;
    const active = row.querySelector<HTMLElement>('[aria-checked="true"]');
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrolls, activeId, props.value, rowRef]);

  const swatch = (bg: string, fg: string, border: string) => ({
    "--swatch-bg": bg,
    "--swatch-fg": fg,
    "--swatch-border": border,
  } as CSSProperties);

  return <div ref={rowRef} className={`ui-theme-cards${scrolls ? " is-row" : ""}${custom && !scrolls ? " is-grid" : ""}`}
    role="radiogroup" aria-label={props.label}>
    {THEME_CHOICES.map((choice) => {
      const palette = READER_PALETTES[choice.id];
      const active = props.value === choice.id;
      return <span key={choice.id} className="ui-theme-slot">
        <button type="button" role="radio" aria-checked={active}
          className={`ui-theme-card${active ? " active" : ""}`}
          style={swatch(palette.background, palette.uiForeground, palette.previewBorder)}
          title={t("aa.theme.tip", { name: t(choice.nameKey) })}
          disabled={props.disabled} onClick={() => props.onChange(choice.id)}>
          <span className="ui-theme-card-sample" aria-hidden="true">Aa</span>
          <span className="ui-theme-card-name">{t(choice.nameKey)}</span>
        </button>
      </span>;
    })}
    {custom?.themes.map((theme, index) => {
      const palette = customReaderPalette(theme);
      const active = custom.activeId === theme.id;
      const name = customThemeName(theme, t("aa.customTheme.defaultName", { n: index + 1 }));
      return <span key={theme.id} className="ui-theme-slot">
        <button type="button" role="radio" aria-checked={active}
          className={`ui-theme-card${active ? " active" : ""}`}
          style={swatch(palette.background, palette.foreground, palette.previewBorder)}
          title={t("aa.theme.tip", { name })}
          disabled={props.disabled}
          onClick={() => { if (active) props.onEditCustom?.(theme.id); else custom.select(theme.id); }}>
          <span className="ui-theme-card-sample" aria-hidden="true">Aa</span>
          <span className="ui-theme-card-name">{name}</span>
        </button>
        {active && props.onEditCustom && (
          <button type="button" className="ui-theme-card-edit" disabled={props.disabled}
            title={t("aa.customTheme.edit.tip", { name })} aria-label={t("aa.customTheme.edit.tip", { name })}
            onClick={() => props.onEditCustom?.(theme.id)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
          </button>
        )}
      </span>;
    })}
    {custom && (
      <span className="ui-theme-slot">
        <button type="button" className="ui-theme-card is-new"
          disabled={props.disabled || !custom.canCreate}
          title={custom.canCreate ? t("aa.customTheme.new.tip") : t("aa.customTheme.full.tip", { max: MAX_CUSTOM_THEMES })}
          aria-label={custom.canCreate ? t("aa.customTheme.new.tip") : t("aa.customTheme.full.tip", { max: MAX_CUSTOM_THEMES })}
          onClick={() => {
            const id = custom.create();
            if (id) props.onEditCustom?.(id);
          }}>
          <span className="ui-theme-card-sample" aria-hidden="true">+</span>
          <span className="ui-theme-card-name">{t("aa.customTheme.new")}</span>
        </button>
      </span>
    )}
  </div>;
}
