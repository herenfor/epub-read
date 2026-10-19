import { describe, expect, it } from "vitest";
import fixture from "./fixtures/appUpdate-v032.json";
import { compareVersions, launchNotice, noticeFor, parseLatestRelease, pickUpdateAsset,
  recordCheck, shouldAutoCheck, type UpdateState } from "./appUpdate";

const HOUR = 3_600_000;

describe("application update policy", () => {
  it("compares numeric and prerelease versions without guessing malformed versions", () => {
    for (const [a, b] of [["0.3.10", "0.3.9"], ["v0.4.0", "0.3.99"],
      ["0.4.0", "0.4.0-beta.1"], ["0.4.0-beta.10", "0.4.0-beta.2"],
      ["9007199254740993.0.0", "9007199254740992.0.0"]]) {
      expect(compareVersions(a, b)).toBe(1);
      expect(compareVersions(b, a)).toBe(-1);
    }
    expect(compareVersions("v0.3.4+local", "0.3.4")).toBe(0);
    for (const bad of ["", "latest", "0.3", "01.2.3", "1.2.3-beta.01", "1.2.3.4"]) {
      expect(compareVersions(bad, "0.3.4")).toBe(0);
      expect(compareVersions("0.3.4", bad)).toBe(0);
    }
  });

  it("parses the trimmed real v0.3.2 release and selects exact platform artifacts", () => {
    const release = parseLatestRelease(fixture)!;
    expect(release.version).toBe("0.3.2");
    expect(release.important).toBe(false);
    expect(pickUpdateAsset(release, "installer")?.name).toBe("EPUB.Reader_0.3.2_x64-setup.exe");
    expect(pickUpdateAsset(release, "portable")?.name).toBe("epub-reader_0.3.2_portable.exe");
    expect(pickUpdateAsset(release, "android")?.sha256).toBe(fixture.assets[0].digest.slice(7));
    expect(pickUpdateAsset(release, "unsupported")).toBeNull();
    expect(parseLatestRelease({ ...fixture, body: "<!-- epub-reader:update important -->" })?.important).toBe(true);
  });

  it("does not download a wrong-version asset or an Android artifact without its digest", () => {
    const release = parseLatestRelease(fixture)!;
    const wrong = { ...release, assets: release.assets.map(asset => ({ ...asset, name: asset.name.replace("0.3.2", "0.3.1") })) };
    expect(pickUpdateAsset(wrong, "android")).toBeNull();
    const noDigest = parseLatestRelease({ ...fixture, assets: fixture.assets.map(a => ({ ...a, digest: null })) })!;
    expect(pickUpdateAsset(noDigest, "android")).toBeNull();
    expect(pickUpdateAsset(noDigest, "installer")).not.toBeNull(); // Windows verifies the updater signature.
  });

  it("rejects draft, prerelease, malformed metadata and foreign download origins", () => {
    for (const input of [null, {}, { ...fixture, draft: true }, { ...fixture, prerelease: true },
      { ...fixture, tag_name: "v0.3.2-beta.1" }, { ...fixture, published_at: "invalid" },
      { ...fixture, html_url: "https://example.com" },
      { ...fixture, assets: [{ ...fixture.assets[0], size: -1 }] },
      { ...fixture, assets: [{ ...fixture.assets[0], browser_download_url: "https://example.com/book.apk" }] }]) {
      expect(parseLatestRelease(input)).toBeNull();
    }
  });

  it("throttles successful checks and backs failures off for 1, 6, then 24 hours", () => {
    let state: UpdateState = { autoCheck: true };
    expect(shouldAutoCheck(state, 0, "android")).toBe(true);
    expect(shouldAutoCheck(state, 0, "unsupported")).toBe(false);
    expect(shouldAutoCheck({ autoCheck: false }, 0, "portable")).toBe(false);
    for (const hours of [1, 6, 24, 24]) {
      state = recordCheck(state, 0, "failed");
      expect(shouldAutoCheck(state, hours * HOUR - 1, "installer")).toBe(false);
      expect(shouldAutoCheck(state, hours * HOUR, "installer")).toBe(true);
    }
    state = recordCheck(state, 0, parseLatestRelease(fixture)!);
    expect(state.lastFailureAt).toBeUndefined();
    expect(shouldAutoCheck(state, 23 * HOUR, "portable")).toBe(false);
    expect(shouldAutoCheck(state, 25 * HOUR, "portable")).toBe(true);
  });

  it("keeps a cached notice on failure and skips only the chosen version", () => {
    const source = Object.freeze({ autoCheck: true, skippedVersion: "v0.3.2" });
    const next = recordCheck(source, 100, parseLatestRelease(fixture)!);
    expect(noticeFor(next, "0.3.1", "android")).toEqual({ kind: "none" });
    const newer = { ...next, cachedLatest: { ...next.cachedLatest!, version: "0.3.4" } };
    expect(noticeFor(newer, "0.3.1", "android").kind).toBe("available");
    expect(noticeFor(next, "0.3.3", "android").kind).toBe("none");
    const failed = recordCheck(next, 200, "failed");
    expect(failed.cachedLatest).toEqual(next.cachedLatest);
    expect(source).toEqual({ autoCheck: true, skippedVersion: "v0.3.2" });
    expect(next.lastFailureAt).toBeUndefined();
  });

  it("records first launch and downgrade silently, and announces only an actual upgrade", () => {
    expect(launchNotice({ autoCheck: true }, "0.3.4")).toEqual({ show: false,
      next: { autoCheck: true, lastLaunchedVersion: "0.3.4" } });
    const previous = Object.freeze({ autoCheck: true, lastLaunchedVersion: "0.3.3" });
    expect(launchNotice(previous, "0.3.4")).toMatchObject({ show: true, from: "0.3.3" });
    expect(launchNotice(previous, "0.3.2")).toMatchObject({ show: false });
    expect(launchNotice(previous, "0.3.3")).toMatchObject({ show: false });
    expect(previous.lastLaunchedVersion).toBe("0.3.3");
  });
});
