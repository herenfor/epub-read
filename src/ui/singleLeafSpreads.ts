import { nextLinearIndex } from "../core/book";
import type { Book } from "../core/types";

/** One screen of a two-page spread: two original chapters, each exactly one leaf. */
export interface SingleLeafSpread {
  left: number;
  right: number | null;
}

/** Linear chapters whose ordinal is a multiple of this always start a run (A13). */
export const SINGLE_LEAF_RUN_CAP = 32;

/**
 * A13 小范围版：连续“一页章”（整图章、实测只有一页的短文字章）两两成屏。
 *
 * 判断由外部注入，结果只属于创建本实例的那一份版式身份；版式变了由调用方换实例。
 * 段起点只由章节判断与线性序号决定：从哪里打开、顺读还是倒翻，同一章总在同一组。
 * linear="no" 的章不参与也不打断配对，与原图片双页一致。
 */
export class SingleLeafSpreads {
  private single = new Map<number, boolean>();
  private runStarts = new Map<number, number>();
  private spreads = new Map<number, SingleLeafSpread | null>();
  private readonly ordinals: number[];

  constructor(
    private book: Book,
    private classify: (index: number, signal: AbortSignal) => Promise<boolean>,
    private runCap = SINGLE_LEAF_RUN_CAP,
  ) {
    let ordinal = 0;
    this.ordinals = book.spine.map((item) => (item.linear ? ordinal++ : -1));
  }

  peek(index: number): SingleLeafSpread | null | undefined {
    return this.spreads.get(index);
  }

  /** The leaf no longer fits (e.g. the window shrank): show these chapters on their own. */
  reject(spread: SingleLeafSpread): void {
    this.spreads.set(spread.left, null);
    if (spread.right !== null) this.spreads.set(spread.right, null);
  }

  private forcedStart(index: number): boolean {
    return this.ordinals[index] % this.runCap === 0;
  }

  private async isSingle(index: number, signal: AbortSignal): Promise<boolean> {
    if (index < 0 || !this.book.spine[index].linear) return false;
    const cached = this.single.get(index);
    if (cached !== undefined) return cached;
    const single = await this.classify(index, signal);
    if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
    this.single.set(index, single);
    return single;
  }

  async resolve(index: number, signal: AbortSignal): Promise<SingleLeafSpread | null> {
    if (this.spreads.has(index)) return this.spreads.get(index)!;
    if (!await this.isSingle(index, signal)) {
      this.spreads.set(index, null);
      return null;
    }
    let start = index;
    const walked: number[] = [];
    while (!this.runStarts.has(start)) {
      walked.push(start);
      if (this.forcedStart(start)) break;
      const previous = nextLinearIndex(this.book, start, -1);
      if (!await this.isSingle(previous, signal)) break;
      start = previous;
    }
    start = this.runStarts.get(start) ?? start;
    for (const item of walked) this.runStarts.set(item, start);
    const distance = this.ordinals[index] - this.ordinals[start];
    const left = distance % 2 === 0 ? index : nextLinearIndex(this.book, index, -1);
    const next = nextLinearIndex(this.book, left, 1);
    const right = next >= 0 && !this.forcedStart(next) && await this.isSingle(next, signal) ? next : null;
    const spread = { left, right };
    this.spreads.set(left, spread);
    if (right !== null) this.spreads.set(right, spread);
    return spread;
  }
}
