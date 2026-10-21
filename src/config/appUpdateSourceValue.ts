import { UPDATE_CHECK_URL, UPDATE_MANIFEST_URL } from "./appUpdate";

/** Where this build looks for new versions; emitted beside the bundle as app-update-source.json. */
export interface AppUpdateSource {
  checkUrl: string;
  manifestUrl: string;
  testMode: boolean;
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
  if (!checkUrl || !manifestUrl) {
    throw new Error("EPUB_READER_UPDATE_TEST=1 needs EPUB_READER_UPDATE_CHECK_URL and EPUB_READER_UPDATE_MANIFEST_URL");
  }
  return { checkUrl, manifestUrl, testMode: true };
}
