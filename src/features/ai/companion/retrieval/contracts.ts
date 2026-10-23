import type { ResolvedCrossBookSearchHit } from "../../indexing/indexStore";
import type { ReadingContext } from "../types";

export interface LibraryBook { hash: string; title: string; creator: string; spineIndex: number }
export interface ChapterPage { hits: ResolvedCrossBookSearchHit[]; offset: number; nextOffset: number | null }
export interface ReadingLibrary {
  context: ReadingContext;
  books: readonly LibraryBook[];
  canRead(bookHash: string, spineIndex: number): boolean;
  search(queries: string[], bookHash: string | undefined, signal: AbortSignal): Promise<ResolvedCrossBookSearchHit[]>;
  read(bookHash: string, chapterPath: string, offset: number, signal: AbortSignal, aroundChunkId?: string): Promise<ChapterPage>;
  chapters(): Array<{ chapterPath: string; spineIndex: number; title: string }>;
}
export interface IndexedScope { hash: string; maxSpineIndex: number | null }
