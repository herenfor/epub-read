import { describe, expect, it } from "vitest";
import { shouldShowAiFoundationEntry } from "./aiEntry";

describe("AI foundation toolbar entry", () => {
  it("is visible for every AI reader build, including production", () => {
    expect(shouldShowAiFoundationEntry("ai", "reader")).toBe(true);
    expect(shouldShowAiFoundationEntry("ai", "shelf")).toBe(false);
    expect(shouldShowAiFoundationEntry("core", "reader")).toBe(false);
    expect(shouldShowAiFoundationEntry("core", "shelf")).toBe(false);
  });
});
