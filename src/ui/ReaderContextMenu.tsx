import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useUiText } from "./localization/UiLanguageProvider";
import { NOTE_COLOR_NAMES, NOTE_STYLES, type NoteColor, type NoteStyle } from "./notes";
import { highlightColorProps, type HighlightTarget } from "./highlightModel";
import type { HighlightPreferences } from "./highlightPreferences";
import { HighlightColorPicker } from "./HighlightColorPicker";
import { ChevronDownIcon, CopyIcon, CopyOriginalIcon, GlobeIcon, HighlighterIcon, NoteIcon, ShareIcon, TrashIcon } from "./readerIcons";
import { useMenuTip } from "./useMenuTip";
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
  /** Looks the selected text up in the system browser (ER-0181). */
  onWebSearch?(text: string): void;
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
  const tips = useMenuTip(menuRef);
  const hideTip = tips.hide;
  const hasTarget = Boolean(props.highlight?.target);
  // The button a description points at may be gone once the menu changes shape.
  useEffect(() => hideTip(), [hideTip, expanded, picking, hasTarget]);
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

  /** An icon-only action: the label is its accessible name and its description bubble (ER-0166). */
  const action = (label: string, icon: ReactNode, run: () => void, className = "") => (
    <button type="button" role="menuitem" className={`sm-btn ${className}`.trim()} aria-label={label}
      {...tips.bind(label)} onClick={() => { if (!tips.consumePress()) run(); }}>
      {icon}
    </button>
  );
  const bubble = tips.tip ? <span ref={tips.tipRef} className="sm-tip" aria-hidden="true">{tips.tip.label}</span> : null;

  // Only when the shown text differs from the book (e.g. after character conversion).
  const copyOriginal = props.onCopyOriginal && selection.originalText && selection.originalText !== selection.text
    ? action(t("readerMisc.copyOriginal"), <CopyOriginalIcon />, () => {
        if (selection.originalText) props.onCopyOriginal?.(selection.originalText);
        props.onClose();
      })
    : null;
  const copyButton = action(t("readerMisc.copy"), <CopyIcon />, copy);
  const addNote = action(t("readerMisc.addNote"), <NoteIcon />, () => { props.onClose(); props.onAddNote(selection); });
  const shareButton = (target: HighlightTarget | null) => props.onShare
    ? action(t("share.menu"), <ShareIcon size={20} />, () => { props.onClose(); props.onShare?.(selection, target); })
    : null;

  const webSearch = props.onWebSearch
    ? action(t("readerMisc.webSearch"), <GlobeIcon size={20} />, () => { props.onClose(); props.onWebSearch?.(selection.text); })
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
        {copyOriginal}
        {addNote}
        {webSearch}
        {shareButton(null)}
        {bubble}
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
  const customLabel = preferences.custom ? t("readerMisc.highlight.customUse") : t("readerMisc.highlight.customSet");
  // The custom slot keeps its own long press (reset the color), so a held finger gets no description here.
  const customTip = tips.bind(customLabel, { press: false });
  const colorName = (color: NoteColor) => t(`readerMisc.highlight.color.${color}` as "readerMisc.highlight.color.red");
  const styleName = (style: NoteStyle) => t(`readerMisc.highlight.style.${style}` as "readerMisc.highlight.style.highlight");
  const sampleColor = highlightColorProps(currentColor ?? (target ? undefined : preferences.color));

  const swatches = (
    <div className="hl-menu-row" role="group" aria-label={t("readerMisc.highlight.colors")}>
      {NOTE_COLOR_NAMES.map((color) => (
        <button key={color} type="button" role="menuitemradio" aria-checked={currentColor === color}
          className={`hl-swatch${currentColor === color ? " is-current" : ""}`}
          aria-label={colorName(color)} {...tips.bind(colorName(color))}
          onClick={() => { if (!tips.consumePress()) chooseColor(color); }}>
          <span className={`hl-dot ${highlightColorProps(color).className}`} />
        </button>
      ))}
      <button type="button" role="menuitemradio"
        aria-checked={Boolean(preferences.custom && currentColor === preferences.custom)}
        className={`hl-swatch${preferences.custom && currentColor === preferences.custom ? " is-current" : ""}`}
        aria-label={customLabel}
        onPointerEnter={customTip.onPointerEnter}
        onFocus={customTip.onFocus}
        onBlur={customTip.onBlur}
        onPointerDown={(event) => {
          customTip.onPointerDown(event);
          longPressRef.current.fired = false;
          clearTimeout(longPressRef.current.timer);
          longPressRef.current.timer = setTimeout(() => {
            longPressRef.current.fired = true;
            setPicking(true);
          }, CUSTOM_LONG_PRESS_MS);
        }}
        onPointerUp={endLongPress}
        onPointerLeave={(event) => { endLongPress(); customTip.onPointerLeave(event); }}
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
  // A letter wearing the style, in the current color: the same in every language.
  const styles = (
    <div className="hl-menu-row" role="group" aria-label={t("readerMisc.highlight.styles")}>
      {NOTE_STYLES.map((style) => (
        <button key={style} type="button" role="menuitemradio" aria-checked={currentStyle === style}
          className={`sm-btn${currentStyle === style ? " is-on" : ""}`} aria-label={styleName(style)}
          {...tips.bind(styleName(style))} onClick={() => { if (!tips.consumePress()) chooseStyle(style); }}>
          <span className={`hl-style-sample hl-s-${style} ${sampleColor.className}`} style={sampleColor.style} aria-hidden="true">A</span>
        </button>
      ))}
    </div>
  );

  let body: ReactNode;
  if (picking) {
    body = <HighlightColorPicker initial={preferences.custom} onUse={useCustom} onCancel={() => setPicking(false)} />;
  } else if (target) {
    body = (
      <>
        {swatches}
        <div className="hl-menu-rule" />
        <div className="sm-tools">
          {styles}
          <span className="sm-divider" />
          <div className="hl-menu-row sm-actions">
            {action(target.content ? t("readerMisc.highlight.editNote") : t("readerMisc.addNote"), <NoteIcon />,
              () => { props.onClose(); highlight.onEditNote(target); })}
            {copyButton}
            {copyOriginal}
            {webSearch}
            {shareButton(target)}
            <span className="hl-menu-sep" />
            {action(t("readerMisc.highlight.delete"), <TrashIcon size={20} />,
              () => { props.onClose(); highlight.onDelete(target); }, "is-danger")}
          </div>
        </div>
      </>
    );
  } else if (expanded) {
    body = (
      <>
        {swatches}
        <div className="hl-menu-rule" />
        <div className="sm-tools">
          {styles}
          <span className="sm-divider" />
          <div className="hl-menu-row sm-actions">
            {addNote}
            {copyButton}
            {copyOriginal}
            {webSearch}
            {shareButton(null)}
          </div>
        </div>
      </>
    );
  } else {
    const prefColor = highlightColorProps(preferences.color);
    body = (
      <div className="hl-menu-row">
        <button type="button" role="menuitem" className={`sm-btn ${prefColor.className}`} style={prefColor.style}
          aria-label={t("readerMisc.highlight.apply")} {...tips.bind(t("readerMisc.highlight.apply"))}
          onClick={() => { if (!tips.consumePress()) highlight.onHighlight(preferences.style, preferences.color); }}>
          <HighlighterIcon />
        </button>
        <button type="button" className="sm-btn hl-menu-chevron" aria-expanded={false}
          aria-label={t("readerMisc.highlight.expand")} {...tips.bind(t("readerMisc.highlight.expand"))}
          onClick={() => { if (!tips.consumePress()) setExpanded(true); }}>
          <ChevronDownIcon size={16} />
        </button>
        <span className="hl-menu-sep" />
        {addNote}
        {copyButton}
        {copyOriginal}
        {webSearch}
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
      {picking ? null : bubble}
    </div>
  );
}
