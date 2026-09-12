import { describe, expect, it } from "vitest";
import { projectPercentageSpacing } from "./percentageSpacing";

describe("percentage spacing uses the reader measure", () => {
  it("projects vertical margin and padding without treating them as height percentages", () => {
    expect(projectPercentageSpacing("40%", 1280, 640)).toBe("256px");
    expect(projectPercentageSpacing("5%", 1280, 640)).toBe("32px");
    expect(projectPercentageSpacing("40%", 1280, 960)).toBe("384px");
  });
  it("preserves resolved length terms and negative percentages in computed math", () => {
    expect(projectPercentageSpacing("calc(40% + 32px)", 1280, 640)).toBe("calc(256px + 32px)");
    expect(projectPercentageSpacing("calc(-5% + 32px)", 1280, 640)).toBe("calc(-32px + 32px)");
    expect(projectPercentageSpacing("clamp(16px, 10%, 100px)", 1280, 640)).toBe("clamp(16px, 64px, 100px)");
  });
  it("leaves lengths, auto, narrow containing blocks and invalid geometry untouched", () => {
    for (const value of ["16px", "auto", "0px"]) expect(projectPercentageSpacing(value, 1280, 640)).toBeNull();
    for (const width of [500, 640, 0, NaN]) expect(projectPercentageSpacing("40%", width, 640)).toBeNull();
  });
});
