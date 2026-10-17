import { describe, expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import type { ReaderViewProps } from "./ReaderView";
import type { SingleLeafSpread } from "./singleLeafSpreads";
import { planPresentationLayers, standbyReaderProps, STANDBY_START } from "./presentationStack";

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
