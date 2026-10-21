import { describe, expect, it } from "vitest";
import fixture from "../../config/fixtures/appUpdate-v032.json";
import { parseLatestRelease, recordCheck } from "../../config/appUpdate";
import { resolveAppUpdateSource, updateDownloadUrl } from "../../config/appUpdateSourceValue";
import { UPDATE_CHECK_URL, UPDATE_MANIFEST_URL } from "../../config/appUpdate";
import { readStoredUpdateState } from "./appUpdateStore";

describe("stored update state", () => {
  it("falls back to defaults for missing or malformed storage", () => {
    for (const raw of [null, "", "not json", "[]", "42", "null"]) {
      expect(readStoredUpdateState(raw)).toEqual({ autoCheck: true });
    }
    expect(readStoredUpdateState(JSON.stringify({ autoCheck: false, lastSuccessAt: "yesterday", skippedVersion: 3 })))
      .toEqual({ autoCheck: false });
  });

  it("keeps a cached release through a round trip and re-validates it", () => {
    const release = parseLatestRelease(fixture)!;
    const state = recordCheck({ autoCheck: true, skippedVersion: "0.3.1", lastLaunchedVersion: "0.3.2" }, 1_000, release);
    const restored = readStoredUpdateState(JSON.stringify(state));
    expect(restored).toEqual(state);
    expect(restored.cachedLatest?.assets.length).toBe(release.assets.length);
  });

  it("drops a cached release that points outside this repository but keeps the rest", () => {
    const state = recordCheck({ autoCheck: true }, 1_000, parseLatestRelease(fixture)!);
    const tampered = JSON.parse(JSON.stringify(state));
    tampered.cachedLatest.assets[0].url = "https://example.com/epub-reader.apk";
    const restored = readStoredUpdateState(JSON.stringify(tampered));
    expect(restored.cachedLatest).toBeUndefined();
    expect(restored.lastSuccessAt).toBe(1_000);
    const renamed = JSON.parse(JSON.stringify(state));
    renamed.cachedLatest.version = "9.9.9";
    expect(readStoredUpdateState(JSON.stringify(renamed)).cachedLatest).toBeUndefined();
  });
});

describe("update source of a build", () => {
  it("uses the GitHub endpoints unless the update test switch is on", () => {
    const production = { checkUrl: UPDATE_CHECK_URL, manifestUrl: UPDATE_MANIFEST_URL, testMode: false };
    expect(resolveAppUpdateSource({})).toEqual(production);
    expect(resolveAppUpdateSource({ EPUB_READER_UPDATE_CHECK_URL: "https://test.local/latest" })).toEqual(production);
  });

  it("requires both test endpoints and marks the build as a test build", () => {
    expect(() => resolveAppUpdateSource({ EPUB_READER_UPDATE_TEST: "1" })).toThrow();
    expect(resolveAppUpdateSource({
      EPUB_READER_UPDATE_TEST: "1",
      EPUB_READER_UPDATE_CHECK_URL: "https://test.local/latest",
      EPUB_READER_UPDATE_MANIFEST_URL: "https://test.local/latest.json",
      EPUB_READER_UPDATE_TEST_DOWNLOAD_BASE: "https://test.local/assets/",
    })).toEqual({ checkUrl: "https://test.local/latest", manifestUrl: "https://test.local/latest.json", testMode: true, downloadBase: "https://test.local/assets/" });
  });

  it("routes test APK bytes locally without weakening production release validation", () => {
    const url = "https://github.com/herenfor/epub-read/releases/download/v0.3.99/epub-reader_0.3.99_android-arm64.apk";
    const env = { EPUB_READER_UPDATE_CHECK_URL: "http://127.0.0.1:48731/latest", EPUB_READER_UPDATE_MANIFEST_URL: "http://127.0.0.1:48731/latest.json", EPUB_READER_UPDATE_TEST_DOWNLOAD_BASE: "http://127.0.0.1:48731/assets/" };
    expect(updateDownloadUrl(url, resolveAppUpdateSource(env))).toBe(url);
    expect(updateDownloadUrl(url, resolveAppUpdateSource({ ...env, EPUB_READER_UPDATE_TEST: "1" })))
      .toBe("http://127.0.0.1:48731/assets/epub-reader_0.3.99_android-arm64.apk");
  });
});
