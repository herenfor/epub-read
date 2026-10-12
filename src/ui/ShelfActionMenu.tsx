import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { placeShelfMenu, type ShelfMenuAnchorRect, type ShelfMenuPlacementResult } from "./shelfMenuPlacement";
import type { ShelfActionGroup, ShelfActionId } from "./shelfActions";
import { useSheetDrag } from "./sheetDrag";

export interface ShelfActionMenuItem {
  id: ShelfActionId;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  pending: boolean;
}

export interface ShelfActionMenuProps {
  presentation: "sheet" | "popover";
  closing: boolean;
  /** Accessible name of the menu/sheet. */
  label: string;
  header: ReactNode;
  groups: Array<{ group: ShelfActionGroup; items: ShelfActionMenuItem[] }>;
  error?: string | null;
  /** Popover anchor in viewport coordinates. */
  anchor: ShelfMenuAnchorRect;
  /** Keyboard opening moves focus to the first item; pointer opening focuses the menu itself. */
  focusFirstItem: boolean;
  onAction(id: ShelfActionId): void;
  onDismiss(): void;
}

function enabledItems(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>(".shelf-action-item:not(:disabled)")] : [];
}

function moveFocus(root: HTMLElement | null, key: string): boolean {
  const items = enabledItems(root);
  if (items.length === 0) return false;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
  else if (key === "ArrowUp") next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
  else if (key === "Home") next = 0;
  else if (key === "End") next = items.length - 1;
  else return false;
  items[next].focus();
  return true;
}

/**
 * A click only counts when its press began after this menu appeared. The finger that long-pressed
 * a card is still down when the sheet slides in; its release must not hit the backdrop or a row
 * that moved under it. Keyboard/programmatic clicks (detail 0) are always fine.
 */
function useFreshPress() {
  const pressed = useRef(false);
  return {
    arm: () => { pressed.current = true; },
    accepts: (event: React.MouseEvent) => !(event.detail > 0) || pressed.current,
  };
}

function ActionList(props: Pick<ShelfActionMenuProps, "groups" | "onAction" | "closing"> & {
  accepts(event: React.MouseEvent): boolean;
}) {
  return <>
    {props.groups.map(({ group, items }, index) => <div key={group}
      className={`shelf-action-group is-${group}`} role="group">
      {index > 0 && <div className="shelf-action-separator" role="separator" />}
      {items.map((item) => <button key={item.id} type="button" role="menuitem"
        className={`shelf-action-item${group === "danger" ? " danger" : ""}${item.pending ? " is-pending" : ""}`}
        disabled={item.disabled || item.pending || props.closing}
        aria-busy={item.pending || undefined}
        onClick={(event) => { if (props.accepts(event)) props.onAction(item.id); }}>
        <span className="shelf-action-icon" aria-hidden="true">{item.icon}</span>
        <span className="shelf-action-label">{item.label}</span>
      </button>)}
    </div>)}
  </>;
}

/**
 * Presentation of the shelf's single action menu. The shelf owns which
 * target is open; this component only renders, positions and reports
 * dismissal. Both shells use the same groups and items.
 */
export function ShelfActionMenu(props: ShelfActionMenuProps) {
  return props.presentation === "sheet" ? <ShelfActionSheet {...props} /> : <ShelfActionPopover {...props} />;
}

/** Focus once per opening, after the shell is actually visible (a hidden element cannot take focus). */
function useInitialFocus(root: React.RefObject<HTMLElement>, focusFirstItem: boolean, ready: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    const element = root.current;
    if (!ready || done.current || !element) return;
    done.current = true;
    const first = focusFirstItem ? enabledItems(element)[0] : null;
    (first ?? element).focus({ preventScroll: true });
  }, [focusFirstItem, ready, root]);
}

/** The menu is the top layer: Escape closes it before any dialog below sees the key, wherever focus is. */
function useEscapeDismiss(closing: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (closing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closing, onDismiss]);
}

function ShelfActionPopover(props: ShelfActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ShelfMenuPlacementResult | null>(null);
  const fresh = useFreshPress();
  useInitialFocus(ref, props.focusFirstItem, place !== null);
  useEscapeDismiss(props.closing, props.onDismiss);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const vv = window.visualViewport;
    setPlace(placeShelfMenu(props.anchor, {
      width: element.offsetWidth || 220,
      height: element.offsetHeight || 240,
    }, {
      left: vv ? vv.offsetLeft : 0,
      top: vv ? vv.offsetTop : 0,
      width: vv ? vv.width : window.innerWidth,
      height: vv ? vv.height : window.innerHeight,
    }, props.anchor.left === props.anchor.right && props.anchor.top === props.anchor.bottom ? "start" : "end"));
  }, [props.anchor]);

  // The page moved under the anchor: the popover would point at nothing.
  useEffect(() => {
    if (props.closing) return;
    const dismiss = props.onDismiss;
    const onScroll = (event: Event) => {
      if (ref.current?.contains(event.target as Node)) return;
      dismiss();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("resize", dismiss);
    };
  }, [props.closing, props.onDismiss]);

  return <>
    {/* Transparent: an outside click only closes the menu, it never also opens what is underneath. */}
    <div className={`shelf-action-popover-scrim${props.closing ? " is-closing" : ""}`} aria-hidden="true"
      onPointerDown={(event) => { event.preventDefault(); props.onDismiss(); }}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={() => props.onDismiss()} />
    <div ref={ref} tabIndex={-1} role="menu" aria-label={props.label}
      onPointerDownCapture={fresh.arm}
      className={`shelf-action-popover${place?.placement === "up" ? " placement-up" : " placement-down"}${props.closing ? " is-closing" : ""}`}
      style={place
        ? { left: place.left, top: place.top, maxWidth: place.width, maxHeight: place.maxHeight }
        : { left: -9999, top: -9999, visibility: "hidden" }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.stopPropagation();
          props.onDismiss();
          return;
        }
        if (moveFocus(ref.current, event.key)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenu={(event) => event.preventDefault()}>
      <div className="shelf-action-popover-title">{props.header}</div>
      {props.error && <div className="shelf-action-error" role="alert">{props.error}</div>}
      <ActionList groups={props.groups} onAction={props.onAction} closing={props.closing} accepts={fresh.accepts} />
    </div>
  </>;
}

function ShelfActionSheet(props: ShelfActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const fresh = useFreshPress();
  useInitialFocus(ref, props.focusFirstItem, true);
  useEscapeDismiss(props.closing, props.onDismiss);
  const { dragging, grip } = useSheetDrag({ sheetRef: ref, disabled: props.closing, onDismiss: props.onDismiss });

  return <>
    <div className={`shelf-action-sheet-backdrop${props.closing ? " is-closing" : ""}`}
      aria-hidden="true"
      onPointerDown={fresh.arm}
      onClick={(event) => { if (fresh.accepts(event)) props.onDismiss(); }}
      onContextMenu={(event) => event.preventDefault()} />
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.label}
      onPointerDownCapture={fresh.arm}
      className={`shelf-action-sheet${props.closing ? " is-closing" : ""}${dragging ? " is-dragging" : ""}`}
      onKeyDown={(event) => {
        if (moveFocus(ref.current, event.key)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenu={(event) => event.preventDefault()}>
      <div className="shelf-action-sheet-grip" aria-hidden="true" {...grip}>
        <span className="shelf-action-sheet-handle" />
      </div>
      <div className="shelf-action-sheet-head" {...grip}>{props.header}</div>
      {props.error && <div className="shelf-action-error" role="alert">{props.error}</div>}
      <div className="shelf-action-sheet-list" role="menu" aria-label={props.label}>
        <ActionList groups={props.groups} onAction={props.onAction} closing={props.closing} accepts={fresh.accepts} />
      </div>
    </div>
  </>;
}
