import { describe, expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import type { ReaderViewProps } from "./ReaderView";
import type { SingleLeafSpread } from "./singleLeafSpreads";
import { planPresentationLayers, standbyReaderProps, STANDBY_START, STANDBY_END } from "./presentationStack";

// Front matter: cover+plate, contents+credits as A13 pairs, then ordinary chapters.
const book = { spine: Array.from({ length: 7 }, (_, i) => ({ idref: String(i), linear: true })) } as unknown as Book;
const cover: SingleLeafSpread = { left: 0, right: 1 };
const contents: SingleLeafSpread = { left: 2, right: 3 };
const peek = (index: number) => (index <= 1 ? cover : index <= 3 ? contents : null);

const summary = (spineIndex: number, current: SingleLeafSpread | null) => {
  const plan = planPresentationLayers(book, spineIndex, current, peek);
  return {
    layers: plan.layers.map((layer) => `${layer.key}@${layer.spineIndex}:${layer.role}`),
    next: [plan.nextKey, plan.nextIndex],
    prev: [plan.prevKey, plan.prevIndex],
  };
};

describe("planPresentationLayers", () => {
  it("prepares both ordinary edges around a pair and preserves the returning paged identity", () => {
    // The observed book: an ordinary page at 2, pair 3/4, then pair 5/6.
    const first = { left: 3, right: 4 }, next = { left: 5, right: 6 };
    const classify = (i: number) => i === 3 || i === 4 ? first : i === 5 || i === 6 ? next : null;
    const plan = planPresentationLayers(book, 3, first, classify);
    expect(plan.prevIndex).toBe(2);
    expect(plan.prevKey).toBe("paged");
    expect(plan.layers.find(layer => layer.key === plan.prevKey)).toMatchObject({ spineIndex: 2, edge: "end" });
    expect(plan.nextKey).toBe("pair:5:6");
    // An isolated pair needs both ordinary neighbors, not a single layer
    // parked at the next chapter and falsely reused for the previous one.
    const isolated = (i: number) => i === 3 || i === 4 ? first : null;
    const between = planPresentationLayers(book, 3, first, isolated);
    expect(between.layers).toHaveLength(3);
    expect(between.layers.find(layer => layer.key === between.nextKey)).toMatchObject({ spineIndex: 5, edge: "start" });
    expect(between.layers.find(layer => layer.key === between.prevKey)).toMatchObject({ spineIndex: 2, edge: "end" });
    expect(between.nextKey).not.toBe(between.prevKey);
    const returned = planPresentationLayers(book, 2, null, isolated, { key: "paged-return", spineIndex: 2 });
    expect(returned.mainKey).toBe(between.prevKey);
    expect(returned.layers.find(layer => layer.key === returned.mainKey)).toMatchObject({ spineIndex: 2, role: "main" });
    const fromPrevious = planPresentationLayers(book, 3, first, isolated, { key: "paged", spineIndex: 2 });
    expect(fromPrevious.prevKey).toBe("paged");
    expect(fromPrevious.nextKey).toBe("paged-return");
    const fromNext = planPresentationLayers(book, 3, first, isolated, { key: "paged", spineIndex: 5 });
    expect(fromNext.nextKey).toBe("paged");
    expect(fromNext.prevKey).toBe("paged-return");
  });
  it("prepares the next pair and parks the paged view on the first ordinary chapter after the run", () => {
    expect(summary(0, cover)).toEqual({
      layers: ["paged@4:standby", "pair:0:1@0:main", "pair:2:3@2:standby"],
      next: ["pair:2:3", 2],
      prev: [null, -1],
    });
  });

  it("slides from the last pair into the parked paged view and back into the previous pair", () => {
    expect(summary(2, contents)).toEqual({
      layers: ["paged@4:standby", "pair:0:1@1:standby", "pair:2:3@2:main"],
      next: ["paged", 4],
      prev: ["pair:0:1", 1],
    });
  });

  it("keeps the paged view current in ordinary text and prepares the pair before it", () => {
    expect(summary(4, null)).toEqual({
      layers: ["paged@4:main", "pair:2:3@3:standby"],
      next: [null, 5],
      prev: ["pair:2:3", 3],
    });
  });
});

describe("standbyReaderProps", () => {
  it("prepares both ordinary edges without publishing state or starting another cache window", () => {
    const onPageState = vi.fn();
    const props = { book, onPageState, startAtEnd: STANDBY_START } as unknown as ReaderViewProps;
    const previous = standbyReaderProps(props, 2, "end");
    const next = standbyReaderProps(props, 5);
    expect(previous.startAtEnd).toBe(STANDBY_END);
    expect(next.startAtEnd).toBe(STANDBY_START);
    expect(previous.presentationStandby).toBe(true);
    previous.onPageState({ status: "loading" });
    expect(onPageState).not.toHaveBeenCalled();
  });
  it("silences every report to the app and parks the layer without navigation intent", () => {
    const onPageState = vi.fn();
    const onUserReadingPositionChange = vi.fn();
    const notesForChapter = vi.fn(() => []);
    const props = {
      book, spineIndex: 4, anchor: "#x", anchorNonce: 7, startAtEnd: { nonce: 3, atEnd: true }, restoreTicket: { id: 1 },
      onPageState, onUserReadingPositionChange, notesForChapter, notes: [{ id: "n" }], inputPaused: false,
    } as unknown as ReaderViewProps;
    const standby = standbyReaderProps(props, 2);
    expect(standby.spineIndex).toBe(2);
    expect(standby.anchor).toBeUndefined();
    expect(standby.anchorNonce).toBe(7);
    expect(standby.startAtEnd).toBe(STANDBY_START);
    expect(standby.restoreTicket).toBeNull();
    expect(standby.inputPaused).toBe(true);
    standby.onPageState({ status: "loading" });
    standby.onUserReadingPositionChange?.(null);
    expect(onPageState).not.toHaveBeenCalled();
    expect(onUserReadingPositionChange).not.toHaveBeenCalled();
    expect(standby.notesForChapter).toBe(notesForChapter);
    expect(notesForChapter).toHaveBeenCalledWith(2);
  });
});
