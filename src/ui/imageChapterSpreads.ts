import { nextLinearIndex, spineItemPath } from "../core/book";
import { hasParserError, parseXmlText } from "../core/parseXml";
import type { Book } from "../core/types";
import { findElements } from "../core/xml";
import { isImageChapterLeaf } from "../render/fullPageImage";

export interface ImageChapterSpread {
  left: number;
  right: number | null;
}

/** Metadata only: inspect XHTML on demand, never decode all pictures to find a pair. */
export class ImageChapterSpreads {
  private pages = new Map<number, boolean>();
  private runStarts = new Map<number, number>();
  private spreads = new Map<number, ImageChapterSpread | null>();

  constructor(
    private book: Book,
    private readText: (path: string, signal: AbortSignal) => Promise<string>,
  ) {}

  peek(index: number): ImageChapterSpread | null | undefined {
    return this.spreads.get(index);
  }

  reject(spread: ImageChapterSpread): void {
    this.spreads.set(spread.left, null);
    if (spread.right !== null) this.spreads.set(spread.right, null);
  }

  private async isImage(index: number, signal: AbortSignal): Promise<boolean> {
    if (index < 0 || !this.book.spine[index].linear) return false;
    const cached = this.pages.get(index);
    if (cached !== undefined) return cached;
    const path = spineItemPath(this.book, index);
    if (!path) return false;
    const html = await this.readText(path, signal);
    if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
    let doc = await parseXmlText(html, this.book.version === 2 ? "application/xml" : "text/html");
    if (hasParserError(doc)) doc = await parseXmlText(html, "text/html");
    const body = findElements(doc, "body")[0];
    const image = body !== undefined && isImageChapterLeaf(body);
    this.pages.set(index, image);
    return image;
  }

  async resolve(index: number, signal: AbortSignal): Promise<ImageChapterSpread | null> {
    if (this.spreads.has(index)) return this.spreads.get(index)!;
    if (!await this.isImage(index, signal)) {
      this.spreads.set(index, null);
      return null;
    }
    // Stable run parity: jumping to the right image or reversing must show
    // the same pair, including an odd final image before a text chapter.
    let start = index;
    const walked: number[] = [];
    while (!this.runStarts.has(start)) {
      walked.push(start);
      const previous = nextLinearIndex(this.book, start, -1);
      if (!await this.isImage(previous, signal)) break;
      start = previous;
    }
    start = this.runStarts.get(start) ?? start;
    for (const item of walked) this.runStarts.set(item, start);
    let distance = 0;
    for (let i = start; i < index; i++) if (this.book.spine[i].linear) distance++;
    const left = distance % 2 === 0 ? index : nextLinearIndex(this.book, index, -1);
    const next = nextLinearIndex(this.book, left, 1);
    const spread = { left, right: await this.isImage(next, signal) ? next : null };
    this.spreads.set(left, spread);
    if (spread.right !== null) this.spreads.set(spread.right, spread);
    return spread;
  }
}
