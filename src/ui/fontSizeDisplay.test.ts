import { describe, expect, it } from "vitest";
import { formatFontSizePx } from "./fontSizeDisplay";

describe("formatFontSizePx", () => {
  it("drops floating-point tails but keeps meaningful decimals", () => {
    expect(formatFontSizePx(20)).toBe("20");
    expect(formatFontSizePx(20.5)).toBe("20.5");
    expect(formatFontSizePx(20.600000000000003)).toBe("20.6");
    expect(formatFontSizePx(18.125)).toBe("18.13");
  });
});
