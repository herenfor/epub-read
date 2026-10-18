import { pageAxisSign, type PageProgression } from "../render/pagedDirection";
import { releaseVelocity } from "./pagedSlide";
import type { ChapterSeam, SeamInputPort, SeamTurnResult } from "./chapterSeam";

interface Options {
  live(): { seam: ChapterSeam; landed: boolean; pending: 1 | -1 | null } | null;
  progression(): PageProgression;
  previewCurrent(dx: number | null): void;
  turnCurrent(direction: 1 | -1): void;
  pending(direction: 1 | -1 | null): void;
}

/** Shared input ownership while two prepared readers move as one screen.
 * The stationary input surface outlives the moving leaves. A gesture that
 * straddles promotion continues on the new reader, without a timed lock.
 */
export class SeamGestureInput implements SeamInputPort {
  private inputId = 0;
  private drag: { seam: ChapterSeam; ticket: number; samples: Array<{ t: number; x: number }> } | null = null;
  private carriedPreview: number | null = null;
  private forwarding = false;

  constructor(private readonly options: Options) {}

  preview(dx: number | null): void {
    if (this.forwarding) return;
    const live = this.options.live();
    if (!live) {
      this.drag = null;
      this.carriedPreview = null;
      if (dx !== null) this.options.pending(null);
      this.forward(dx);
      return;
    }
    if (live.landed) {
      this.carriedPreview = dx;
      return;
    }
    if (dx === null) {
      const drag = this.drag;
      // touchend clears preview before synchronously committing its turn.
      // Only an unclaimed (cancelled/short) drag springs back here.
      if (drag) queueMicrotask(() => {
        if (this.drag !== drag || this.options.live()?.seam !== drag.seam) return;
        this.drag = null;
        drag.seam.release(drag.ticket, 0, releaseVelocity(drag.samples, performance.now()));
      });
      return;
    }
    if (this.drag?.seam !== live.seam) this.drag = null;
    const logicalDx = dx * pageAxisSign(this.options.progression());
    if (!this.drag) {
      this.options.pending(null);
      const ticket = live.seam.beginDrag(logicalDx < 0 ? 1 : -1);
      if (ticket === null) return;
      this.drag = { seam: live.seam, ticket, samples: [] };
    }
    const drag = this.drag;
    drag.seam.drag(drag.ticket, logicalDx);
    drag.samples.push({ t: performance.now(), x: -logicalDx });
    if (drag.samples.length > 8) drag.samples.shift();
  }

  turn(direction: 1 | -1): SeamTurnResult {
    const live = this.options.live();
    if (!live) {
      this.options.pending(null);
      this.options.turnCurrent(direction);
      return "moving";
    }
    // A→B→C then back requests B: when C could only be reserved, the opposite
    // command withdraws that reservation instead of reversing the motion.
    if (live.pending === -direction) {
      this.options.pending(null);
      if (live.landed) this.carriedPreview = null;
      return "moving";
    }
    if (live.landed) {
      this.options.pending(direction);
      this.carriedPreview = null;
      return "moving";
    }
    const drag = this.drag;
    this.drag = null;
    if (drag?.seam === live.seam) {
      this.options.pending(live.seam.releaseWouldOverflow(drag.ticket, direction) ? direction : null);
      live.seam.release(drag.ticket, direction, releaseVelocity(drag.samples, performance.now()));
      return "moving";
    }
    const result = live.seam.turn(++this.inputId, direction);
    this.options.pending(result === "beyond" ? direction : null);
    // Beyond is accepted as one intent for the promoted reader, not a reason
    // for a leaf to fall back to the old chapter-transition path.
    return result === "beyond" ? "moving" : result;
  }

  promoted(): void {
    this.drag = null;
    const dx = this.carriedPreview;
    this.carriedPreview = null;
    if (dx !== null) this.forward(dx);
  }

  cancel(): void {
    this.drag = null;
    this.carriedPreview = null;
  }

  private forward(dx: number | null): void {
    this.forwarding = true;
    try { this.options.previewCurrent(dx); }
    finally { this.forwarding = false; }
  }
}
