/**
 * One owner for a bottom sheet's vertical position. Drag, release and the
 * height change of collapse/expand all go through here, so no two phases
 * write the same transform and every phase starts from the frame on screen.
 *
 * Offsets are the sheet's visual translateY in px relative to its current
 * layout (0 = resting, positive = lower).
 */
export type SheetSettle = "stay" | "collapse" | "expand" | "dismiss";

export interface SheetDriver {
  /** Visual offset now, including a running animation. */
  readOffset(): number;
  /** Cancel any running motion and pin the sheet at `offset`. */
  hold(offset: number): void;
  /** Animate from → to; `done` runs only if this animation finished (not canceled). */
  animate(from: number, to: number, kind: SheetSettle, done: () => void): void;
  /** Back at rest: drop the motion's own styles and animations. */
  rest(): void;
  /** Offset that puts the sheet's top where the collapsed layout will put it (measured on the current layout). */
  collapsedOffset(): number;
  /**
   * Commit the expanded state; after React has committed that layout, call
   * `ready` with the offset that keeps the sheet's top where it was on screen.
   */
  commitLayout(expanded: boolean, ready: (offset: number) => void): void;
  /** Start the logical close (closing state, backdrop) and play the exit from `from`. */
  dismiss(from: number): void;
  /** Stop everything for good (unmount): cancel animations and clear styles. */
  release(): void;
}

export class SheetMotion {
  private generation = 0;
  private dragging = false;
  private origin = 0;

  constructor(private readonly driver: SheetDriver) {}

  get isDragging(): boolean {
    return this.dragging;
  }

  /** A new drag takes over from whatever is on screen, including a settle still running. */
  begin(): number {
    const ticket = ++this.generation;
    this.origin = this.driver.readOffset();
    this.driver.hold(this.origin);
    this.dragging = true;
    return ticket;
  }

  /** `offset` is the drag's displacement (already resisted by the caller) from where it began. */
  move(ticket: number, offset: number): void {
    if (ticket !== this.generation || !this.dragging) return;
    this.driver.hold(this.origin + offset);
  }

  settle(ticket: number, kind: SheetSettle): void {
    if (ticket !== this.generation || !this.dragging) return;
    this.dragging = false;
    const from = this.driver.readOffset();
    this.driver.hold(from);
    const completion = ++this.generation;
    const current = () => completion === this.generation;
    const springTo0 = (offset: number) => {
      if (!current()) return;
      if (Math.abs(offset) < 0.5) {
        this.driver.rest();
        return;
      }
      this.driver.hold(offset);
      this.driver.animate(offset, 0, kind, () => { if (current()) this.driver.rest(); });
    };
    switch (kind) {
      case "stay":
        springTo0(from);
        return;
      case "dismiss":
        this.driver.dismiss(from);
        return;
      case "expand":
        // Taller layout first; it is held at the old visual top and eased up.
        this.driver.commitLayout(true, springTo0);
        return;
      case "collapse": {
        // Move down on the tall layout, then commit the short one where it already is;
        // the sheet never lifts off the bottom edge in between.
        const target = this.driver.collapsedOffset();
        this.driver.animate(from, target, kind, () => {
          if (current()) this.driver.commitLayout(false, springTo0);
        });
        return;
      }
    }
  }

  /**
   * The gesture was cut off (cancel, lost capture, backgrounding, disabled):
   * the sheet goes back to rest from its current frame and waits for a new
   * drag. Nothing happens when no drag is active, so a running dismiss or
   * settle is left alone.
   */
  interrupt(): void {
    if (!this.dragging) return;
    this.dragging = false;
    const completion = ++this.generation;
    const from = this.driver.readOffset();
    this.driver.hold(from);
    if (Math.abs(from) < 0.5) {
      this.driver.rest();
      return;
    }
    this.driver.animate(from, 0, "stay", () => { if (completion === this.generation) this.driver.rest(); });
  }

  /** Unmount: no late completion may touch the sheet again. */
  terminate(): void {
    ++this.generation;
    this.dragging = false;
    this.driver.release();
  }
}
