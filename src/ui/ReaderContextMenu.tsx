import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface ReaderSelectionPayload {
  text: string;
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

export interface ReaderContextMenuProps {
  selection: ReaderSelectionPayload | null;
  position: ContextMenuPoint;
  /** Coordinates are viewport-relative; the component itself is position: fixed. */
  onCopy?(text: string): void;
  onAddNote(selection: ReaderSelectionPayload): void;
  onClose(): void;
}

export function ReaderContextMenu(props: ReaderContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
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
  }, [props.position.x, props.position.y, props.selection]);

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

  return (
    <div
      ref={menuRef}
      className={`reader-context-menu is-${placement.horizontal} is-${placement.vertical}`}
      role="menu"
      aria-label="选区操作"
      style={{ left: placement.x, top: placement.y }}
      onPointerDown={handlePointerDown}
    >
      <button type="button" role="menuitem" onClick={copy}>复制</button>
      <button type="button" role="menuitem" onClick={() => { props.onClose(); props.onAddNote(selection); }}>添加笔记</button>
    </div>
  );
}
