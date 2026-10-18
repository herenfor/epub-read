import { nextLinearIndex } from "../core/book";
import type { Book } from "../core/types";
import { pairLayerKey } from "./presentationStack";
import type { SingleLeafSpread } from "./singleLeafSpreads";

export interface FrontRunUnit {
  key: string;
  kind: "pair" | "paged";
  spineIndex: number;
  chapters: readonly number[];
  edge: "start" | "end";
  estimatedBytes: number;
}

export interface FrontRunPlan {
  /** Current, then near-to-far in the reading direction, then one opposite screen. */
  units: readonly FrontRunUnit[];
  complete: boolean;
  waitingFor: number | null;
}

export interface FrontRunInput {
  book: Book;
  current: number;
  direction: 1 | -1;
  peek(index: number): SingleLeafSpread | null | undefined;
  isLeafCandidate(index: number): boolean | undefined;
  knownLeaves(index: number): number | undefined;
  imageBytes(index: number): number;
  budget: { maxScreens: number; maxBytes: number };
}

/** Classification only: no resolving, loading, DOM, timers or persistent state. */
export function planFrontRun(input: FrontRunInput): FrontRunPlan {
  const { book, direction, budget } = input;
  const units: FrontRunUnit[] = [];
  let bytes = 0;
  let complete = false;

  const classify = (index: number, dir: 1 | -1): { unit: FrontRunUnit; multiScreen: boolean } | undefined => {
    const spread = input.peek(index);
    if (spread === undefined) return undefined;
    const chapters = spread ? spread.right === null ? [spread.left] : [spread.left, spread.right] : [index];
    let multiScreen = false;
    if (!spread) {
      const candidate = input.isLeafCandidate(index);
      if (candidate === undefined) return undefined;
      const leaves = input.knownLeaves(index);
      // A cheap negative is not an exact length measurement. Wait rather than
      // treating every rejected/ordinary chapter as the end of the short run.
      if (leaves === undefined && !candidate) return undefined;
      multiScreen = leaves !== undefined && leaves > 2;
    }
    return {
      unit: {
        key: spread ? pairLayerKey(spread) : `paged:${index}`,
        kind: spread ? "pair" : "paged", spineIndex: chapters[0], chapters,
        edge: dir === 1 ? "start" : "end",
        estimatedBytes: chapters.reduce((sum, chapter) => sum + input.imageBytes(chapter), 0),
      },
      multiScreen,
    };
  };

  const adjacent = (unit: FrontRunUnit, dir: 1 | -1): number => nextLinearIndex(
    book, dir === 1 ? unit.chapters[unit.chapters.length - 1] : unit.chapters[0], dir,
  );
  const append = (unit: FrontRunUnit): void => { units.push(unit); bytes += unit.estimatedBytes; };
  const fits = (unit: FrontRunUnit): boolean => units.length < budget.maxScreens && bytes + unit.estimatedBytes <= budget.maxBytes;

  const current = book.spine[input.current]?.linear ? input.current : nextLinearIndex(book, input.current, direction);
  if (current < 0) return { units, complete: true, waitingFor: null };
  const first = classify(current, direction);
  if (!first) return { units, complete: false, waitingFor: current };
  append(first.unit);

  // The current chapter is already entered. In particular, reading backwards
  // from a long chapter's start must still prepare the front matter before it.
  let index = adjacent(first.unit, direction);
  while (index >= 0) {
    // Never spend the next resolve/measurement on a third screen past the cap.
    if (units.length >= 2 && (units.length >= budget.maxScreens || bytes > budget.maxBytes)) break;
    const next = classify(index, direction);
    if (!next) return { units, complete: false, waitingFor: index };
    if (units.length >= 2 && !fits(next.unit)) break;
    append(next.unit);
    if (next.multiScreen) { complete = true; break; }
    index = adjacent(next.unit, direction);
  }
  if (index < 0) complete = true; // The known run reaches the book boundary.

  const opposite = -direction as 1 | -1;
  const oppositeIndex = adjacent(first.unit, opposite);
  if (oppositeIndex >= 0 && units.length < budget.maxScreens && bytes <= budget.maxBytes) {
    const back = classify(oppositeIndex, opposite);
    if (!back) return { units, complete: false, waitingFor: oppositeIndex };
    if (fits(back.unit)) append(back.unit);
  }
  return { units, complete, waitingFor: null };
}
