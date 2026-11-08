import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useUiText } from "./localization/UiLanguageProvider";
import { NOTE_COLOR_NAMES, NOTE_STYLES, type NoteColor, type NoteStyle } from "./notes";
import { highlightColorProps, type HighlightTarget } from "./highlightModel";
import type { HighlightPreferences } from "./highlightPreferences";
import { HighlightColorPicker } from "./HighlightColorPicker";
import "./highlightMenu.css";

export interface ReaderSelectionPayload {
  text: string;
  /** Optional canonical original quote for the explicit "copy original" action. */
  originalText?: string;
  /** Optional caller-owned anchor information; the menu does not interpret it. */
  start?: number;
  end?: number;
  [key: string]: unknown;
}

export interface ContextMenuPoint {
  x: number;
  y: number;
}

export interface ContextMenuViewport {
  width: number;
  height: number;
}

export interface ContextMenuSize {
  width: number;
  height: number;
}

export interface ContextMenuPlacement extends ContextMenuPoint {
  horizontal: "left" | "right";
  vertical: "above" | "below";
}

const MENU_MARGIN = 8;
const DEFAULT_SIZE: ContextMenuSize = { width: 176, height: 48 };

export function isUsableSelection(selection: ReaderSelectionPayload | null | undefined): selection is ReaderSelectionPayload {
  return Boolean(selection && selection.text.trim().length > 0);
}

/** Clamp a popup to the viewport and choose the least-obstructive direction. */
export function getContextMenuPlacement(
  point: ContextMenuPoint,
  viewport: ContextMenuViewport,
  size: ContextMenuSize = DEFAULT_SIZE,
  margin = MENU_MARGIN,
): ContextMenuPlacement {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const maxX = Math.max(margin, viewport.width - width - margin);
  const maxY = Math.max(margin, viewport.height - height - margin);
  const horizontal = point.x + width + margin > viewport.width ? "left" : "right";
  const vertical = point.y + height + margin > viewport.height ? "above" : "below";
  const desiredX = horizontal === "left" ? point.x - width : point.x;
  const desiredY = vertical === "above" ? point.y - height : point.y;
  const x = Math.min(Math.max(margin, desiredX), maxX);
  const y = Math.min(Math.max(margin, desiredY), maxY);
  return { x, y, horizontal, vertical };
}

/** Highlight actions of the menu (ER-0106); without it the menu offers copy and add note only. */
export interface ReaderHighlightMenu {
  /** The highlight the selection lies entirely inside, or null for plain text. */
  target: HighlightTarget | null;
  preferences: HighlightPreferences;
  /** Plain text: highlight now with this style and color. */
  onHighlight(style: NoteStyle, color: NoteColor): void;
  /** On a highlight: change its color and/or style at once; the menu stays. */
  onRestyle(target: HighlightTarget, patch: { style?: NoteStyle; color?: NoteColor }): void;
  onSetCustomColor(hex: string): void;
  onEditNote(target: HighlightTarget): void;
  onDelete(target: HighlightTarget): void;
}

export interface ReaderContextMenuProps {
  selection: ReaderSelectionPayload | null;
  position: ContextMenuPoint;
  /** Coordinates are viewport-relative; the component itself is position: fixed. */
  onCopy?(text: string): void;
  onCopyOriginal?(text: string): void;
  onAddNote(selection: ReaderSelectionPayload): void;
  /** Opens the share card for the selection; on a highlight, with its note and colour (ER-0119). */
  onShare?(selection: ReaderSelectionPayload, target: HighlightTarget | null): void;
  onClose(): void;
  highlight?: ReaderHighlightMenu;
}

/** Long press on the custom slot opens its panel, like right click on desktop. */
const CUSTOM_LONG_PRESS_MS = 500;

export function ReaderContextMenu(props: ReaderContextMenuProps) {
  const { t } = useUiText();
  const menuRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; fired: boolean }>({ timer: undefined, fired: false });
  useEffect(() => () => clearTimeout(longPressRef.current.timer), []);
  const [placement, setPlacement] = useState<ContextMenuPlacement>(() => getContextMenuPlacement(props.position, {
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight,
  }));

  useLayoutEffect(() => {
    if (!isUsableSelection(props.selection)) return;
    const update = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      setPlacement(getContextMenuPlacement(
        props.position,
        { width: window.innerWidth, height: window.innerHeight },
        rect ? { width: rect.width, height: rect.height } : DEFAULT_SIZE,
      ));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [props.position.x, props.position.y, props.selection, expanded, picking, props.highlight?.target]);

  useEffect(() => {
    if (!isUsableSelection(props.selection)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [props.onClose, props.selection]);

  if (!isUsableSelection(props.selection)) return null;
  const selection = props.selection;
  const handlePointerDown = (event: ReactPointerEvent) => event.stopPropagation();
  const copy = () => {
    if (props.onCopy) props.onCopy(selection.text);
    else void navigator.clipboard?.writeText(selection.text);
    props.onClose();
  };

  const copyOriginal = props.onCopyOriginal && selection.originalText && selection.originalText !== selection.text
    ? (
        <button type="button" role="menuitem" onClick={() => {
          if (selection.originalText) props.onCopyOriginal?.(selection.originalText);
          props.onClose();
        }}>{t("readerMisc.copyOriginal")}</button>
      )
    : null;
  const copyButton = <button type="button" role="menuitem" onClick={copy}>{t("readerMisc.copy")}</button>;
  const addNote = <button type="button" role="menuitem" onClick={() => { props.onClose(); props.onAddNote(selection); }}>{t("readerMisc.addNote")}</button>;
  const shareButton = (target: HighlightTarget | null) => props.onShare
    ? <button type="button" role="menuitem" onClick={() => { props.onClose(); props.onShare?.(selection, target); }}>{t("share.menu")}</button>
    : null;

  const highlight = props.highlight;
  if (!highlight) {
    return (
      <div
        ref={menuRef}
        className={`reader-context-menu is-${placement.horizontal} is-${placement.vertical}`}
        role="menu"
        aria-label={t("readerMisc.selection")}
        style={{ left: placement.x, top: placement.y }}
        onPointerDown={handlePointerDown}
      >
        {copyButton}
        {/* Only when the shown text differs from the book (e.g. after character conversion). */}
        {copyOriginal}
        {addNote}
        {shareButton(null)}
      </div>
    );
  }

  const { target, preferences } = highlight;
  const currentColor = target ? target.color : preferences.color;
  const currentStyle = target ? target.style : preferences.style;
  const chooseColor = (color: NoteColor) => {
    if (target) highlight.onRestyle(target, { color, style: target.style ?? "highlight" });
    else highlight.onHighlight(preferences.style, color);
  };
  const chooseStyle = (style: NoteStyle) => {
    if (target) highlight.onRestyle(target, { style });
    else highlight.onHighlight(style, preferences.color);
  };
  const useCustom = (hex: string) => {
    setPicking(false);
    highlight.onSetCustomColor(hex);
    chooseColor(hex as NoteColor);
  };
  const endLongPress = () => clearTimeout(longPressRef.current.timer);
  const customProps = highlightColorProps(preferences.custom ? preferences.custom as NoteColor : undefined);
  const colorName = (color: NoteColor) => t(`readerMisc.highlight.color.${color}` as "readerMisc.highlight.color.red");
  const styleName = (style: NoteStyle) => t(`readerMisc.highlight.style.${style}` as "readerMisc.highlight.style.highlight");
  const sampleColor = highlightColorProps(currentColor ?? (target ? undefined : preferences.color));

  const swatches = (
    <div className="hl-menu-row" role="group" aria-label={t("readerMisc.highlight.colors")}>
      {NOTE_COLOR_NAMES.map((color) => (
        <button key={color} type="button" role="menuitemradio" aria-checked={currentColor === color}
          className={`hl-swatch${currentColor === color ? " is-current" : ""}`}
          aria-label={colorName(color)} title={colorName(color)} onClick={() => chooseColor(color)}>
          <span className={`hl-dot ${highlightColorProps(color).className}`} />
        </button>
      ))}
      <button type="button" role="menuitemradio"
        aria-checked={Boolean(preferences.custom && currentColor === preferences.custom)}
        className={`hl-swatch${preferences.custom && currentColor === preferences.custom ? " is-current" : ""}`}
        aria-label={preferences.custom ? t("readerMisc.highlight.customUse") : t("readerMisc.highlight.customSet")}
        title={preferences.custom ? t("readerMisc.highlight.customUse") : t("readerMisc.highlight.customSet")}
        onPointerDown={() => {
          longPressRef.current.fired = false;
          clearTimeout(longPressRef.current.timer);
          longPressRef.current.timer = setTimeout(() => {
            longPressRef.current.fired = true;
            setPicking(true);
          }, CUSTOM_LONG_PRESS_MS);
        }}
        onPointerUp={endLongPress}
        onPointerLeave={endLongPress}
        onPointerCancel={endLongPress}
        onContextMenu={(event) => { event.preventDefault(); endLongPress(); setPicking(true); }}
        onClick={() => {
          if (longPressRef.current.fired) { longPressRef.current.fired = false; return; }
          if (preferences.custom) chooseColor(preferences.custom as NoteColor);
          else setPicking(true);
        }}>
        {preferences.custom
          ? <span className={`hl-dot ${customProps.className}`} style={customProps.style} />
          : <span className="hl-dot hl-dot-empty" aria-hidden="true">+</span>}
      </button>
    </div>
  );
  const styles = NOTE_STYLES.map((style) => (
    <button key={style} type="button" role="menuitemradio" aria-checked={currentStyle === style}
      className={currentStyle === style ? "is-on" : undefined} onClick={() => chooseStyle(style)}>
      <span className={`hl-style-sample hl-s-${style} ${sampleColor.className}`} style={sampleColor.style}>{styleName(style)}</span>
    </button>
  ));

  let body: ReactNode;
  if (picking) {
    body = <HighlightColorPicker initial={preferences.custom} onUse={useCustom} onCancel={() => setPicking(false)} />;
  } else if (target) {
    body = (
      <>
        {swatches}
        <div className="hl-menu-rule" />
        <div className="hl-menu-row">{styles}</div>
        <div className="hl-menu-rule" />
        <div className="hl-menu-row">
          <button type="button" role="menuitem" onClick={() => { props.onClose(); highlight.onEditNote(target); }}>
            {target.content ? t("readerMisc.highlight.editNote") : t("readerMisc.addNote")}
          </button>
          {copyButton}
          {copyOriginal}
          {shareButton(target)}
          <span className="hl-menu-sep" />
          <button type="button" role="menuitem" className="is-danger" onClick={() => { props.onClose(); highlight.onDelete(target); }}>
            {t("readerMisc.highlight.delete")}
          </button>
        </div>
      </>
    );
  } else if (expanded) {
    body = (
      <>
        {swatches}
        <div className="hl-menu-rule" />
        <div className="hl-menu-row">
          {styles}
          <span className="hl-menu-sep" />
          {addNote}
          {copyButton}
          {copyOriginal}
          {shareButton(null)}
        </div>
      </>
    );
  } else {
    const prefColor = highlightColorProps(preferences.color);
    body = (
      <div className="hl-menu-row">
        <button type="button" role="menuitem" onClick={() => highlight.onHighlight(preferences.style, preferences.color)}>
          <span className={`hl-dot ${prefColor.className}`} style={prefColor.style} />
          {t("readerMisc.highlight.apply")}
        </button>
        <button type="button" className="hl-menu-chevron" aria-expanded={false}
          aria-label={t("readerMisc.highlight.expand")} title={t("readerMisc.highlight.expand")}
          onClick={() => setExpanded(true)}>▾</button>
        <span className="hl-menu-sep" />
        {addNote}
        {copyButton}
        {copyOriginal}
        {shareButton(null)}
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      className={`reader-context-menu has-highlight is-${placement.horizontal} is-${placement.vertical}`}
      role="menu"
      aria-label={t("readerMisc.selection")}
      style={{ left: placement.x, top: placement.y }}
      onPointerDown={handlePointerDown}
    >
      {body}
    </div>
  );
}
