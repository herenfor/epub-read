import { describe, expect, it } from "vitest";
import { findReleaseNote, RELEASES_PAGE_URL } from "./releaseNotes";

describe("release notes", () => {
  it("matches the shipped version with an optional leading v", () => {
    expect(findReleaseNote("0.3.0")).toMatchObject({ version: "0.3.0", status: "released" });
    expect(findReleaseNote("v0.3.0")?.items.length).toBeGreaterThan(0);
  });

  it("does not use other notes for an unknown installed version", () => {
    expect(findReleaseNote("9.9.9")).toBeNull();
    expect(findReleaseNote("0.2.9")).toBeNull();
  });

  it("points users at the GitHub releases page", () => {
    expect(RELEASES_PAGE_URL).toBe("https://github.com/herenfor/epub-read/releases");
  });
});
