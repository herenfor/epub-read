import { describe, expect, it } from "vitest";
import {
  CONTINUOUS_READING_LINE_RATIO,
  continuousReadingLine,
  bookmarkLanding,
  commitExplicitPosition,
  acceptPositionSample,
  releaseExplicitPosition,
  rebasePosition,
  type ReadingPositionSnapshot,
} from "./bookmarkReadingPosition";

describe("bookmarkReadingPosition core invariants", () => {
  it("calculates continuousReadingLine as exactly 20% of viewport height", () => {
    expect(CONTINUOUS_READING_LINE_RATIO).toBe(0.2);
    expect(continuousReadingLine(800)).toBe(160);
    expect(continuousReadingLine(1000)).toBe(200);
  });

  it("calculates bookmark landing with reading line offset and preserves actual screenY when clamped", () => {
    // Normal middle of book
    const normal = bookmarkLanding({
      chapterTop: 1000,
      contentY: 500,
      viewportHeight: 800,
      maxScrollTop: 5000,
    });
    // documentY = 1500, readingLine = 160 -> scrollTop = 1340
    expect(normal.scrollTop).toBe(1340);
    // screenY = 1500 - 1340 = 160 (exactly at reading line)
    expect(normal.screenY).toBe(160);

    // Near book top: clamped to 0
    const topClamped = bookmarkLanding({
      chapterTop: 0,
      contentY: 80,
      viewportHeight: 800,
      maxScrollTop: 5000,
    });
    // documentY = 80, readingLine = 160 -> desired = -80 -> clamped scrollTop = 0
    expect(topClamped.scrollTop).toBe(0);
    // screenY = 80 - 0 = 80px (actual screen position preserved, not forced to 160)
    expect(topClamped.screenY).toBe(80);

    // Near book end: clamped to maxScrollTop
    const endClamped = bookmarkLanding({
      chapterTop: 4500,
      contentY: 600,
      viewportHeight: 800,
      maxScrollTop: 4800,
    });
    // documentY = 5100, readingLine = 160 -> desired = 4940 -> clamped to 4800
    expect(endClamped.scrollTop).toBe(4800);
    expect(endClamped.screenY).toBe(300);
  });

  it("commitExplicitPosition creates an explicit snapshot for current session", () => {
    const spot = { offset: 500, screenY: 160, textOffset: 1234 };
    const snapshot = commitExplicitPosition(1, "0:c1.xhtml", spot);
    expect(snapshot.session).toBe(1);
    expect(snapshot.chapterKey).toBe("0:c1.xhtml");
    expect(snapshot.source).toBe("explicit");
    expect(snapshot.value).toEqual(spot);
  });

  it("acceptPositionSample ignores samples while explicit position is active in same session", () => {
    const explicitSpot = { offset: 500, screenY: 160, textOffset: 1234 };
    const explicitSnapshot = commitExplicitPosition(1, "0:c1.xhtml", explicitSpot);

    const randomSampleSpot = { offset: 550, screenY: 160, textOffset: 1300 };
    const sampleSnapshot: ReadingPositionSnapshot<typeof randomSampleSpot> = {
      session: 1,
      chapterKey: "0:c1.xhtml",
      source: "sampled",
      value: randomSampleSpot,
    };

    // The explicit position MUST hold
    const result = acceptPositionSample(explicitSnapshot, sampleSnapshot);
    expect(result.source).toBe("explicit");
    expect(result.value).toEqual(explicitSpot);
  });

  it("acceptPositionSample accepts samples once explicit position is released or from a new session", () => {
    const explicitSpot = { offset: 500, screenY: 160, textOffset: 1234 };
    const explicitSnapshot = commitExplicitPosition(1, "0:c1.xhtml", explicitSpot);

    // Release explicit ownership
    const released = releaseExplicitPosition(explicitSnapshot);
    expect(released?.source).toBe("sampled");

    // New sample arrives
    const newSampleSpot = { offset: 550, screenY: 160, textOffset: 1300 };
    const sampleSnapshot: ReadingPositionSnapshot<typeof newSampleSpot> = {
      session: 1,
      chapterKey: "0:c1.xhtml",
      source: "sampled",
      value: newSampleSpot,
    };

    const resultAfterRelease = acceptPositionSample(released, sampleSnapshot);
    expect(resultAfterRelease.source).toBe("sampled");
    expect(resultAfterRelease.value.textOffset).toBe(1300);

    // Different session also overrides
    const newSessionSample: ReadingPositionSnapshot<typeof newSampleSpot> = {
      session: 2,
      chapterKey: "0:c1.xhtml",
      source: "sampled",
      value: newSampleSpot,
    };
    const resultNewSession = acceptPositionSample(explicitSnapshot, newSessionSample);
    expect(resultNewSession.source).toBe("sampled");
    expect(resultNewSession.session).toBe(2);
    expect(resultNewSession.value.textOffset).toBe(1300);
  });

  it("rebasePosition updates geometry on reflow while maintaining explicit ownership", () => {
    const explicitSpot = { offset: 500, screenY: 160, textOffset: 1234 };
    const snapshot = commitExplicitPosition(1, "0:c1.xhtml", explicitSpot);

    const rebasedSpot = { offset: 620, screenY: 160, textOffset: 1234 };
    const rebased = rebasePosition(snapshot, rebasedSpot);

    expect(rebased.session).toBe(1);
    expect(rebased.chapterKey).toBe("0:c1.xhtml");
    expect(rebased.source).toBe("explicit");
    expect(rebased.value.offset).toBe(620);
    expect(rebased.value.textOffset).toBe(1234);
  });

  it("handles pure image (media) anchor lifecycle, matching, and reflow rebase", () => {
    const mediaAnchor = {
      index: 0,
      tag: "img",
      signature: "cover.jpg#100x200",
      ratio: 0.45,
    };
    const mediaSpot = {
      offset: 350,
      screenY: 160,
      scrollTop: 190,
      text: null,
      media: mediaAnchor,
    };
    const snapshot = commitExplicitPosition(1, "0:c1.xhtml", mediaSpot);
    expect(snapshot.source).toBe("explicit");
    expect(snapshot.value.media).toEqual(mediaAnchor);

    // Matching check (sameMediaReadingAnchor semantics)
    const matching =
      snapshot.value.media?.signature === mediaAnchor.signature &&
      snapshot.value.media?.index === mediaAnchor.index &&
      Math.abs(snapshot.value.media?.ratio - mediaAnchor.ratio) <= 0.001;
    expect(matching).toBe(true);

    // Reflow rebase preserves media anchor and explicit source
    const rebasedMediaSpot = {
      ...mediaSpot,
      offset: 420,
      screenY: 160,
      scrollTop: 260,
    };
    const rebased = rebasePosition(snapshot, rebasedMediaSpot);
    expect(rebased.source).toBe("explicit");
    expect(rebased.value.offset).toBe(420);
    expect(rebased.value.media?.ratio).toBe(0.45);
  });

  it("simulates full bookmark lifecycle: create at reading line -> restore -> matches without scroll -> toggle removes -> scroll releases", () => {
    // 1. User captures spot at 20% reading line
    const originalTextOffset = 4520;
    const originalSnippet = "This is bookmarked paragraph text.";
    const createdBookmark = {
      id: "bm_12345",
      spineIndex: 2,
      chapterPath: "chapter2.xhtml",
      anchorTextOffset: originalTextOffset,
      anchorTextSnippet: originalSnippet,
      createdAtMs: 1727418600000,
    };

    let bookmarks = [createdBookmark];

    // 2. User navigates away to chapter 3
    let currentSession = 1;
    let currentReadingPosition: ReadingPositionSnapshot<any> | null = {
      session: currentSession,
      chapterKey: "3:chapter3.xhtml",
      source: "sampled",
      value: { offset: 100, screenY: 160, textOffset: 200 },
    };

    // Helper to evaluate isCurrentPageBookmarked
    const isBookmarked = (pos: ReadingPositionSnapshot<any> | null, activeSpineIndex: number) => {
      if (!pos) return false;
      return bookmarks.some(
        (b) => b.spineIndex === activeSpineIndex && b.anchorTextOffset === pos.value.textOffset,
      );
    };

    expect(isBookmarked(currentReadingPosition, 3)).toBe(false);

    // 3. User selects bookmark from menu -> restored via reading-line alignment
    // Target chapter 2 resolves target contentY = 1200
    const chapterTop = 3000;
    const contentY = 1200;
    const V = 800;
    const maxScrollTop = 10000;

    const landing = bookmarkLanding({
      chapterTop,
      contentY,
      viewportHeight: V,
      maxScrollTop,
    });
    // Landed at documentY - 160 = 4200 - 160 = 4040
    expect(landing.scrollTop).toBe(4040);
    expect(landing.screenY).toBe(160);

    // Commit explicit position
    currentReadingPosition = commitExplicitPosition(currentSession, "2:chapter2.xhtml", {
      offset: contentY,
      screenY: landing.screenY,
      scrollTop: landing.scrollTop,
      textOffset: createdBookmark.anchorTextOffset,
      textSnippet: createdBookmark.anchorTextSnippet,
    });

    // 4. Immediately matches bookmark (red active) WITHOUT any user scrolling
    expect(isBookmarked(currentReadingPosition, 2)).toBe(true);

    // 5. Subsequent RAF / frame sampling attempts to sample nearby text (e.g. at offset 1250)
    const ordinarySample = {
      session: currentSession,
      chapterKey: "2:chapter2.xhtml",
      source: "sampled" as const,
      value: { offset: 1250, screenY: 160, scrollTop: 4040, textOffset: 4600 },
    };
    currentReadingPosition = acceptPositionSample(currentReadingPosition, ordinarySample);

    // Explicit position is protected against overwriting; still matches!
    expect(currentReadingPosition.source).toBe("explicit");
    expect(currentReadingPosition.value.textOffset).toBe(originalTextOffset);
    expect(isBookmarked(currentReadingPosition, 2)).toBe(true);

    // 6. Clicking toggle bookmark when red deletes the bookmark
    const existing = bookmarks.find(
      (b) => b.spineIndex === 2 && b.anchorTextOffset === currentReadingPosition?.value.textOffset,
    );
    expect(existing).toBeDefined();
    bookmarks = bookmarks.filter((b) => b.id !== existing!.id);
    expect(bookmarks.length).toBe(0);
    expect(isBookmarked(currentReadingPosition, 2)).toBe(false);

    // 7. User scrolls manually (movedByUser = true) -> explicit position is released
    currentReadingPosition = releaseExplicitPosition(currentReadingPosition);
    expect(currentReadingPosition?.source).toBe("sampled");

    // Next sample from scroll takes effect
    const scrolledSample = {
      session: currentSession,
      chapterKey: "2:chapter2.xhtml",
      source: "sampled" as const,
      value: { offset: 1800, screenY: 160, scrollTop: 4600, textOffset: 5200 },
    };
    currentReadingPosition = acceptPositionSample(currentReadingPosition, scrolledSample);
    expect(currentReadingPosition.value.textOffset).toBe(5200);
  });
});

