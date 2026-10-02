import { describe, expect, it } from "vitest";
import { classifyViewport } from "./responsiveEnvironment";

describe("responsive viewport classification", () => {
  it("classifies phone, tablet and wide windows by available CSS pixels", () => {
    expect(classifyViewport(390, 844)).toEqual({ layout: "compact", shortViewport: false });
    expect(classifyViewport(600, 800)).toEqual({ layout: "medium", shortViewport: false });
    expect(classifyViewport(839, 800)).toEqual({ layout: "medium", shortViewport: false });
    expect(classifyViewport(840, 800)).toEqual({ layout: "wide", shortViewport: false });
  });

  it("marks short landscape/input windows for full-height panels", () => {
    expect(classifyViewport(800, 420)).toEqual({ layout: "medium", shortViewport: true });
    expect(classifyViewport(1024, 479)).toEqual({ layout: "wide", shortViewport: true });
  });

  it("falls back to a usable desktop viewport for invalid measurements", () => {
    expect(classifyViewport(Number.NaN, 0)).toEqual({ layout: "wide", shortViewport: false });
  });
});
