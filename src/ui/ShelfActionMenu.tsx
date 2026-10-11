import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { placeShelfMenu, type ShelfMenuAnchorRect, type ShelfMenuPlacementResult } from "./shelfMenuPlacement";
import type { ShelfActionGroup, ShelfActionId } from "./shelfActions";

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

/** Sheet drag distance or fling speed that closes it. */
const SHEET_CLOSE_DISTANCE_PX = 72;
const SHEET_CLOSE_VELOCITY = 0.5;

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

function ActionList(props: Pick<ShelfActionMenuProps, "groups" | "onAction" | "closing">) {
  return <>
    {props.groups.map(({ group, items }, index) => <div key={group}
      className={`shelf-action-group is-${group}`} role="group">
      {index > 0 && <div className="shelf-action-separator" role="separator" />}
      {items.map((item) => <button key={item.id} type="button" role="menuitem"
        className={`shelf-action-item${group === "danger" ? " danger" : ""}${item.pending ? " is-pending" : ""}`}
        disabled={item.disabled || item.pending || props.closing}
        aria-busy={item.pending || undefined}
        onClick={() => props.onAction(item.id)}>
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

function useInitialFocus(root: React.RefObject<HTMLElement>, focusFirstItem: boolean): void {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const first = focusFirstItem ? enabledItems(element)[0] : null;
    (first ?? element).focus({ preventScroll: true });
    // Focus once per opening; re-renders of the same menu keep the user's position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function ShelfActionPopover(props: ShelfActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ShelfMenuPlacementResult | null>(null);
  useInitialFocus(ref, props.focusFirstItem);

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
    }));
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
      className={`shelf-action-popover${place?.placement === "up" ? " placement-up" : " placement-down"}${props.closing ? " is-closing" : ""}`}
      style={place
        ? { left: place.left, top: place.top, maxWidth: place.width, maxHeight: place.maxHeight }
        : { left: -9999, top: -9999, visibility: "hidden" }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
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
      <ActionList groups={props.groups} onAction={props.onAction} closing={props.closing} />
    </div>
  </>;
}

function ShelfActionSheet(props: ShelfActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; lastY: number; lastAt: number; velocity: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useInitialFocus(ref, props.focusFirstItem);

  const endDrag = (close: boolean) => {
    const sheet = ref.current;
    drag.current = null;
    setDragging(false);
    if (sheet) sheet.style.transform = "";
    if (close) props.onDismiss();
  };

  // Backgrounding drops a half-finished drag; the sheet itself stays open.
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;
  useEffect(() => {
    if (!dragging) return;
    const onHidden = () => { if (document.visibilityState === "hidden") endDragRef.current(false); };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [dragging]);

  const grip = {
    onPointerDown(event: React.PointerEvent<HTMLElement>) {
      if (props.closing || event.button !== 0 || !event.isPrimary) return;
      drag.current = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastAt: event.timeStamp, velocity: 0 };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
      setDragging(true);
    },
    onPointerMove(event: React.PointerEvent<HTMLElement>) {
      const state = drag.current;
      const sheet = ref.current;
      if (!state || !sheet || state.pointerId !== event.pointerId) return;
      const dt = Math.max(1, event.timeStamp - state.lastAt);
      state.velocity = (event.clientY - state.lastY) / dt;
      state.lastY = event.clientY;
      state.lastAt = event.timeStamp;
      const dy = event.clientY - state.startY;
      // Upward pull only gives a little; the sheet never detaches from the bottom.
      sheet.style.transform = `translateY(${dy >= 0 ? dy : dy / 4}px)`;
    },
    onPointerUp(event: React.PointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const dy = event.clientY - state.startY;
      endDrag(dy > SHEET_CLOSE_DISTANCE_PX || (dy > 16 && state.velocity > SHEET_CLOSE_VELOCITY));
    },
    onPointerCancel(event: React.PointerEvent<HTMLElement>) {
      if (drag.current?.pointerId === event.pointerId) endDrag(false);
    },
  };

  return <>
    <div className={`shelf-action-sheet-backdrop${props.closing ? " is-closing" : ""}`}
      aria-hidden="true"
      onClick={() => props.onDismiss()}
      onContextMenu={(event) => event.preventDefault()} />
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.label}
      className={`shelf-action-sheet${props.closing ? " is-closing" : ""}${dragging ? " is-dragging" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
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
      <div className="shelf-action-sheet-grip" aria-hidden="true" {...grip}>
        <span className="shelf-action-sheet-handle" />
      </div>
      <div className="shelf-action-sheet-head" {...grip}>{props.header}</div>
      {props.error && <div className="shelf-action-error" role="alert">{props.error}</div>}
      <div className="shelf-action-sheet-list" role="menu" aria-label={props.label}>
        <ActionList groups={props.groups} onAction={props.onAction} closing={props.closing} />
      </div>
    </div>
  </>;
}
