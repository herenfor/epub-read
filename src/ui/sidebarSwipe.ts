/** Navigation drawer motion is local UI state; it never calls the reader's page executor. */
export const SIDEBAR_TABS = ["toc", "bookmarks", "notes"] as const;
export type SidebarNavigationMemory = { scrollTop: Partial<Record<typeof SIDEBAR_TABS[number], number>>; tocFilter?: string };
export function createSidebarNavigationMemory(): SidebarNavigationMemory { return { scrollTop: {} }; }

export interface SidebarMotionDriver {
  read(): number;
  stop(): void;
  write(position: number): void;
  animate(position: number, done: () => void): void;
}

/** One owner, interrupt at the visible position, invalidate every old completion/drag. */
export class SidebarSwipeMotion {
  private generation = 0;
  private origin = 0;
  private originIndex = 0;
  private dragging = false;
  private settling = false;
  constructor(private driver: SidebarMotionDriver, private width: number, public index: number,
    private onSelect: (index: number) => void) { driver.write(index * width); }

  begin(): number {
    this.origin = this.driver.read();
    this.driver.stop();
    this.driver.write(this.origin);
    this.originIndex = this.index;
    this.dragging = true;
    this.settling = false;
    return ++this.generation;
  }
  move(ticket: number, dx: number): void {
    if (!this.dragging || ticket !== this.generation) return;
    const raw = this.origin - dx, end = 2 * this.width;
    // Bounded rubber band: even an enormous outward drag reveals no imaginary fourth pane.
    const limit = this.width * 0.16;
    const resist = (distance: number) => limit * distance / (limit + distance);
    this.driver.write(raw < 0 ? -resist(-raw) : raw > end ? end + resist(raw - end) : raw);
  }
  end(ticket: number, dx: number, cancelled = false): void {
    if (!this.dragging || ticket !== this.generation) return;
    let next = this.originIndex;
    // One gesture advances one tab; short drag-back/cancel keeps its original destination.
    if (!cancelled && Math.abs(dx) >= Math.min(64, this.width * 0.2)) {
      next = Math.max(0, Math.min(2, this.originIndex + (dx < 0 ? 1 : -1)));
    }
    this.select(cancelled ? this.originIndex : next, true);
  }
  select(index: number, force = false, notify = true): void {
    if (!force && index === this.index && !this.dragging) return;
    const position = this.driver.read();
    this.driver.stop();
    this.driver.write(position);
    const ticket = ++this.generation;
    this.dragging = false;
    this.settling = true;
    const changed = index !== this.index;
    this.index = index;
    if (changed && notify) this.onSelect(index);
    this.driver.animate(index * this.width, () => {
      if (ticket !== this.generation) return;
      this.settling = false;
      this.driver.write(this.index * this.width);
    });
  }
  resize(width: number): void {
    ++this.generation;
    this.dragging = this.settling = false;
    this.driver.stop();
    this.width = width;
    this.driver.write(this.index * width);
  }
  dispose(): void { ++this.generation; this.dragging = this.settling = false; this.driver.stop(); }
  get moving(): boolean { return this.dragging || this.settling; }
}

/** Compositor animation, not per-frame React rendering. read() samples the interrupted frame. */
export function installSidebarSwipe(viewport: HTMLElement, track: HTMLElement, index: number,
  onSelect: (index: number) => void): { motion: SidebarSwipeMotion; dispose(): void } {
  let animation: Animation | undefined;
  const window = viewport.ownerDocument.defaultView!;
  const driver: SidebarMotionDriver = {
    read: () => -new window.DOMMatrixReadOnly(window.getComputedStyle(track).transform).m41,
    stop: () => { animation?.cancel(); animation = undefined; },
    write: position => { track.style.transform = `translate3d(${-position}px, 0, 0)`; },
    animate: (position, done) => {
      const from = window.getComputedStyle(track).transform;
      driver.write(position);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { done(); return; }
      const current = track.animate([{ transform: from }, { transform: track.style.transform }],
        { duration: 210, easing: "cubic-bezier(.2,.75,.25,1)" });
      animation = current;
      current.onfinish = () => { if (animation === current) { animation = undefined; done(); } };
    },
  };
  const motion = new SidebarSwipeMotion(driver, viewport.clientWidth, index, onSelect);
  let start: { x: number; y: number } | undefined;
  let ticket: number | undefined;
  let dx = 0;
  let suppressClick = false;
  const point = (touch: Touch) => ({ x: touch.clientX, y: touch.clientY });
  const reset = () => { start = undefined; ticket = undefined; dx = 0; };
  const onStart = (event: TouchEvent) => {
    if (ticket !== undefined) motion.end(ticket, dx, true);
    reset(); suppressClick = false;
    if (event.touches.length !== 1 || window.getSelection()?.toString() ||
        (event.target as Element).closest("input,textarea,select,[contenteditable='true']")) return;
    start = point(event.touches[0]);
  };
  const onMove = (event: TouchEvent) => {
    if (!start) return;
    if (event.touches.length !== 1) { onCancel(); return; }
    const current = point(event.touches[0]);
    dx = current.x - start.x;
    const dy = current.y - start.y;
    if (ticket === undefined) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2) { reset(); return; }
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
      ticket = motion.begin();
    }
    event.preventDefault();
    suppressClick = true;
    motion.move(ticket, dx);
  };
  const onEnd = (event: TouchEvent) => {
    if (event.touches.length) { onCancel(); return; }
    if (ticket !== undefined) {
      if (start && event.changedTouches[0]) dx = event.changedTouches[0].clientX - start.x;
      motion.move(ticket, dx);
      motion.end(ticket, dx);
    }
    reset();
  };
  const onCancel = () => { if (ticket !== undefined) motion.end(ticket, dx, true); reset(); };
  const onClick = (event: Event) => {
    // A horizontal drag, including a boundary bounce, must not open a chapter/bookmark/note.
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
  };
  viewport.addEventListener("touchstart", onStart, { passive: true });
  viewport.addEventListener("touchmove", onMove, { passive: false });
  viewport.addEventListener("touchend", onEnd);
  viewport.addEventListener("touchcancel", onCancel);
  viewport.addEventListener("click", onClick, true);
  // Touch cancellation is authoritative; Android pointercancel may precede valid touchmove.
  let width = viewport.clientWidth;
  const observer = new ResizeObserver(() => {
    if (viewport.clientWidth !== width) { width = viewport.clientWidth; reset(); motion.resize(width); }
  });
  observer.observe(viewport);
  return { motion, dispose: () => {
    observer.disconnect(); motion.dispose();
    viewport.removeEventListener("touchstart", onStart);
    viewport.removeEventListener("touchmove", onMove);
    viewport.removeEventListener("touchend", onEnd);
    viewport.removeEventListener("touchcancel", onCancel);
    viewport.removeEventListener("click", onClick, true);
  } };
}
