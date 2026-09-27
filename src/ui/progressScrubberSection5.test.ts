import { describe, expect, it } from "vitest";
import {
  createContentAxis,
  reduceScrubUi,
  initialScrubUi,
  displayedScrubRatio,
  labelProgressPct,
  type AxisInput,
  type ScrubToken,
} from "./readerProgressAxis";

describe("Section 5 Check 2: Progress Scrubber Lifecycle and Web Entry Chain", () => {
  const threeChapters: AxisInput[] = [
    { key: "0:intro.xhtml", spineIndex: 0, weight: 200 },
    { key: "1:body.xhtml", spineIndex: 1, weight: 500 },
    { key: "2:epilogue.xhtml", spineIndex: 2, weight: 300 },
  ];
  const axis = createContentAxis(threeChapters);

  it("Step 1: click ~65% on unloaded distant chapter -> wait ready -> hover away and back", () => {
    let session = 1;
    let uiState = initialScrubUi(session);

    // Initial state: no actual, no preview, no pending
    expect(displayedScrubRatio(uiState)).toBeNull();

    // User clicks ~65%
    const ratio = 0.65;
    const target = axis.locate(ratio);
    expect(target).not.toBeNull();
    // 0:intro is [0, 0.2), 1:body is [0.2, 0.7), 2:epilogue is [0.7, 1.0]
    expect(target!.spineIndex).toBe(1);
    expect(target!.key).toBe("1:body.xhtml");
    // (0.65 - 0.20) / 0.50 = 0.90
    expect(target!.fraction).toBeCloseTo(0.9, 5);

    // Commit seek
    const token1: ScrubToken = { session, request: 1 };
    uiState = reduceScrubUi(uiState, { type: "begin", token: token1, ratio });
    expect(uiState.pending).toEqual({ session: 1, request: 1, ratio: 0.65 });
    expect(displayedScrubRatio(uiState)).toBe(0.65);

    // Hover away and back while pending: preview changes, but does not wipe pending
    uiState = reduceScrubUi(uiState, { type: "preview", session, ratio: 0.4 });
    expect(uiState.preview).toBe(0.4);
    expect(displayedScrubRatio(uiState)).toBe(0.4); // Preview takes precedence during hover

    uiState = reduceScrubUi(uiState, { type: "preview", session, ratio: null });
    expect(uiState.preview).toBeNull();
    // Hover leave restores pending ratio
    expect(displayedScrubRatio(uiState)).toBe(0.65);

    // Target finishes loading and settles
    uiState = reduceScrubUi(uiState, {
      type: "settled",
      token: token1,
      actual: { ratio: 0.65, atEnd: false },
    });
    expect(uiState.pending).toBeNull();
    expect(uiState.actual).toEqual({ ratio: 0.65, atEnd: false });
    expect(displayedScrubRatio(uiState)).toBe(0.65);
    expect(labelProgressPct(uiState.actual!)).toBe(65);
  });

  it("Step 2: rapid two requests -> only the last settles (token isolation)", () => {
    let session = 1;
    let uiState = initialScrubUi(session);

    const token2: ScrubToken = { session, request: 2 };
    uiState = reduceScrubUi(uiState, { type: "begin", token: token2, ratio: 0.3 });
    expect(uiState.pending?.request).toBe(2);

    // Immediate second seek before request 2 arrives
    const token3: ScrubToken = { session, request: 3 };
    uiState = reduceScrubUi(uiState, { type: "begin", token: token3, ratio: 0.8 });
    expect(uiState.pending?.request).toBe(3);
    expect(displayedScrubRatio(uiState)).toBe(0.8);

    // Outdated request 2 settles -> MUST be ignored
    uiState = reduceScrubUi(uiState, {
      type: "settled",
      token: token2,
      actual: { ratio: 0.3, atEnd: false },
    });
    expect(uiState.pending?.request).toBe(3);
    expect(uiState.actual).toBeNull();

    // Outdated request 2 failure/cancellation -> MUST be ignored
    uiState = reduceScrubUi(uiState, { type: "cancelled", token: token2 });
    expect(uiState.pending?.request).toBe(3);

    // Request 3 settles -> accepted
    uiState = reduceScrubUi(uiState, {
      type: "settled",
      token: token3,
      actual: { ratio: 0.8, atEnd: false },
    });
    expect(uiState.pending).toBeNull();
    expect(uiState.actual).toEqual({ ratio: 0.8, atEnd: false });
    expect(displayedScrubRatio(uiState)).toBe(0.8);
  });

  it("Step 3: seek back to start (legal 0) -> commits and settles accurately", () => {
    let session = 1;
    let uiState = initialScrubUi(session);

    // Seek to 0
    const token4: ScrubToken = { session, request: 4 };
    uiState = reduceScrubUi(uiState, { type: "begin", token: token4, ratio: 0 });
    expect(uiState.pending).toEqual({ session: 1, request: 4, ratio: 0 });
    expect(displayedScrubRatio(uiState)).toBe(0);

    // Settled at 0
    uiState = reduceScrubUi(uiState, {
      type: "settled",
      token: token4,
      actual: { ratio: 0, atEnd: false },
    });
    expect(uiState.actual).toEqual({ ratio: 0, atEnd: false });
    expect(displayedScrubRatio(uiState)).toBe(0);
    expect(labelProgressPct(uiState.actual!)).toBe(0);
  });

  it("Step 4: middle of last chapter does not write 100%, 99% cap holds unless atEnd: true", () => {
    // Chapter 2 is epilogue (last chapter: 0.70 to 1.00)
    // Middle of chapter 2: ratio 0.85
    const midLastChapter = { ratio: 0.85, atEnd: false };
    expect(labelProgressPct(midLastChapter)).toBe(85);

    // Near the end of last chapter (99.8%), but atEnd is still false
    const nearEndNotAtEnd = { ratio: 0.998, atEnd: false };
    expect(labelProgressPct(nearEndNotAtEnd)).toBe(99); // Capped at 99%, never 100%!

    // Exactly at end of last chapter: atEnd is true
    const confirmedEnd = { ratio: 1.0, atEnd: true };
    expect(labelProgressPct(confirmedEnd)).toBe(100);
  });

  it("Step 5: close book and reopen -> session increment invalidates past requests and restores confirmed position", () => {
    let session = 1;
    let uiState = initialScrubUi(session);
    const tokenOld: ScrubToken = { session, request: 99 };
    uiState = reduceScrubUi(uiState, { type: "begin", token: tokenOld, ratio: 0.5 });

    // Close reader: session increment + reset
    session = 2;
    uiState = reduceScrubUi(uiState, { type: "reset", session });
    expect(uiState.session).toBe(2);
    expect(uiState.pending).toBeNull();
    expect(uiState.actual).toBeNull();

    // Late message from old session arrives -> MUST be dropped
    uiState = reduceScrubUi(uiState, {
      type: "settled",
      token: tokenOld,
      actual: { ratio: 0.5, atEnd: false },
    });
    expect(uiState.actual).toBeNull();

    // Restoring persisted position on reopening
    uiState = reduceScrubUi(uiState, {
      type: "sample",
      session: 2,
      actual: { ratio: 0.35, atEnd: false },
    });
    expect(uiState.actual).toEqual({ ratio: 0.35, atEnd: false });
    expect(displayedScrubRatio(uiState)).toBe(0.35);
    expect(labelProgressPct(uiState.actual!)).toBe(35);
  });
});
