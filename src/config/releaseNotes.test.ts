import { describe, expect, it } from "vitest";
import { findReleaseNote, listPreviousReleaseNotes } from "./releaseNotes";

describe("release notes", () => {
  it("matches an exact version with an optional leading v", () => {
    expect(findReleaseNote("0.2.8")).toMatchObject({
      version: "0.2.8",
      status: "development",
    });
    expect(findReleaseNote("v0.2.7")).toMatchObject({
      version: "0.2.7",
      status: "released",
      releasedOn: "2026-10-02",
    });
  });

  it("does not use the latest source notes for an unknown installed version", () => {
    expect(findReleaseNote("9.9.9")).toBeNull();
  });

  it("lists historical notes without the currently displayed version", () => {
    const history = listPreviousReleaseNotes("0.2.8");
    expect(history.some((note) => note.version === "0.2.8")).toBe(false);
    expect(history.some((note) => note.version === "0.2.7")).toBe(true);
  });
});
