import { UPDATE_CHECK_URL, UPDATE_MANIFEST_URL } from "./appUpdate";

/** Where this build looks for new versions; emitted beside the bundle as app-update-source.json. */
export interface AppUpdateSource {
  checkUrl: string;
  manifestUrl: string;
  testMode: boolean;
  /** Isolated test packages only. Production keeps the canonical GitHub asset URL. */
  downloadBase?: string;
}

/**
 * Production builds always use the GitHub release endpoints. Only an update
 * test build (EPUB_READER_UPDATE_TEST=1, the same switch the native side
 * reads) may point elsewhere, and then it must name both endpoints.
 */
export function resolveAppUpdateSource(env: Record<string, string | undefined>): AppUpdateSource {
  if (env.EPUB_READER_UPDATE_TEST !== "1") {
    return { checkUrl: UPDATE_CHECK_URL, manifestUrl: UPDATE_MANIFEST_URL, testMode: false };
  }
  const checkUrl = env.EPUB_READER_UPDATE_CHECK_URL;
  const manifestUrl = env.EPUB_READER_UPDATE_MANIFEST_URL;
  const downloadBase = env.EPUB_READER_UPDATE_TEST_DOWNLOAD_BASE;
  if (!checkUrl || !manifestUrl || !downloadBase?.endsWith("/")) {
    throw new Error("EPUB_READER_UPDATE_TEST=1 needs check/manifest URLs and EPUB_READER_UPDATE_TEST_DOWNLOAD_BASE ending in /");
  }
  return { checkUrl, manifestUrl, testMode: true, downloadBase };
}

/** Keep release metadata canonical; only compiled test builds route APK bytes to the local fixture server. */
export function updateDownloadUrl(url: string, source: AppUpdateSource): string {
  return source.testMode && source.downloadBase
    ? source.downloadBase + url.slice(url.lastIndexOf("/") + 1)
    : url;
}
