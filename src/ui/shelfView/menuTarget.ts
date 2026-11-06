import type { ShelfMenuAnchorRect } from "../shelfMenuPlacement";

/** Which shelf object a menu is for; identity is the stable id, never a captured entry object. */
export type ShelfMenuTarget =
  | { kind: "book"; id: string; surface: "grid" | "list" | "folderModal" }
  | { kind: "folder"; id: string; surface?: "folderModal" };

/** How a card asked for its menu. */
export interface ShelfMenuOpener {
  trigger: HTMLElement | null;
  /** Right-click position; absent anchors at the trigger. */
  point?: { x: number; y: number };
  pointerType: string;
  keyboard: boolean;
  /** The three-dot of an already open menu closes it instead of reopening. */
  toggle: boolean;
}

export interface ShelfMenuSession {
  /** Every opening gets a new token; async results only land on the menu that started them. */
  token: number;
  target: ShelfMenuTarget;
  presentation: "sheet" | "popover";
  anchor: ShelfMenuAnchorRect;
  trigger: HTMLElement | null;
  focusFirstItem: boolean;
}

export function sameShelfMenuTarget(a: ShelfMenuTarget, b: ShelfMenuTarget): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  return a.kind !== "book" || b.kind !== "book" || a.surface === b.surface;
}

export function buttonMenuOpener(event: React.MouseEvent<HTMLElement>, pressedWith: string): ShelfMenuOpener {
  const keyboard = event.detail === 0;
  const pointerType = keyboard ? "" : ((event.nativeEvent as Partial<PointerEvent>).pointerType || pressedWith);
  return { trigger: event.currentTarget, pointerType, keyboard, toggle: true };
}

export function contextMenuOpener(event: React.MouseEvent<HTMLElement>, trigger: HTMLElement | null): ShelfMenuOpener {
  // Touch long press never gets here (the press recognizer owns it). A right button is the mouse;
  // the context-menu key / Shift+F10 arrives without it and anchors at the card's own button.
  const keyboard = event.button !== 2;
  const pointerType = keyboard ? "" : ((event.nativeEvent as Partial<PointerEvent>).pointerType || "mouse");
  return {
    trigger,
    point: keyboard ? undefined : { x: event.clientX, y: event.clientY },
    pointerType,
    keyboard,
    toggle: false,
  };
}
