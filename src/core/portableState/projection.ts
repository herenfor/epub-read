/**
 * Display-side helpers for portable v3 state.
 *
 * Merge never declares a winner for reading progress. These helpers expose
 * candidates and deterministic display versions for annotations; callers are
 * still responsible for creating a chosen/`shown-all` basis before writing.
 */
import { compareStamp, type Annotation, type Json, type Stamp, type Version } from "./portable-register-core";
import type { LegacyLocator, Locator, ModernLocator, ProgressValue } from "./portable-state-types";

export interface MediaAnchorProjection {
  readonly index: number;
  readonly tag: string;
  readonly signature: string;
  readonly ratio: number;
}

export interface ReadingProjection {
  readonly locator: Locator;
  readonly chapterPath: string | null;
  readonly spineIndex: number;
  readonly page: number;
  readonly anchorIndex: number | null;
  readonly anchorRatio: number | null;
  readonly anchorTextOffset: number | null;
  readonly anchorTextSnippet: string | null;
  readonly mediaAnchor: MediaAnchorProjection | null;
}

export interface ProgressProjection extends ReadingProjection {
  readonly value: ProgressValue;
  readonly version: Version<ProgressValue>;
}

function mediaProjection(value: LegacyLocator["mediaAnchor"]): MediaAnchorProjection | null {
  if (!value) return null;
  return { index: value.index, tag: value.tag, signature: value.signature, ratio: value.ratio };
}

export function latestVersion<T extends Json>(versions: readonly Version<T>[]): Version<T> | null {
  let latest: Version<T> | null = null;
  for (const version of versions) {
    if (!latest || compareStamp(version.stamp, latest.stamp) > 0) latest = version;
  }
  return latest;
}

export function versionForStamp<T extends Json>(
  versions: readonly Version<T>[],
  stamp: Stamp,
): Version<T> | null {
  return versions.find((version) =>
    version.stamp.deviceId === stamp.deviceId && version.stamp.counter === stamp.counter) ?? null;
}

/** Display winner for an annotation; tombstone always wins and content is not resurrected. */
export function annotationDisplayVersion<T extends Json>(
  annotation: Annotation<T>,
): Version<T> | null {
  return annotation.deleted ? null : latestVersion(annotation.versions);
}

export function projectLocator(locator: Locator): Omit<ReadingProjection, "locator"> {
  if (locator.locatorVersion === 1) {
    const chapterPath = locator.chapterPath;
    const target = locator.target;
    if (target.kind === "text") {
      return {
        chapterPath,
        spineIndex: locator.spineIndexHint,
        page: 0,
        anchorIndex: null,
        anchorRatio: null,
        anchorTextOffset: target.offset,
        anchorTextSnippet: target.snippet,
        mediaAnchor: null,
      };
    }
    if (target.kind === "media") {
      return {
        chapterPath,
        spineIndex: locator.spineIndexHint,
        page: 0,
        anchorIndex: null,
        anchorRatio: null,
        anchorTextOffset: null,
        anchorTextSnippet: null,
        mediaAnchor: {
          index: target.indexHint,
          tag: target.tag,
          signature: target.signature,
          ratio: target.ratio,
        },
      };
    }
    return {
      chapterPath,
      spineIndex: locator.spineIndexHint,
      page: 0,
      anchorIndex: null,
      anchorRatio: null,
      anchorTextOffset: null,
      anchorTextSnippet: null,
      mediaAnchor: null,
    };
  }
  return {
    chapterPath: null,
    spineIndex: locator.spineIndex,
    page: locator.pageHint,
    anchorIndex: locator.anchorIndex,
    anchorRatio: locator.anchorRatio,
    anchorTextOffset: locator.anchorTextOffset,
    anchorTextSnippet: locator.anchorTextSnippet,
    mediaAnchor: mediaProjection(locator.mediaAnchor),
  };
}

export function projectProgressVersion(version: Version<ProgressValue>): ProgressProjection {
  const value = version.value;
  if (value === null) {
    return {
      version,
      value: null,
      locator: { locatorVersion: 0, spineIndex: 0, pageHint: 0, anchorIndex: null, anchorRatio: null, anchorTextOffset: null, anchorTextSnippet: null, mediaAnchor: null },
      chapterPath: null,
      spineIndex: 0,
      page: 0,
      anchorIndex: null,
      anchorRatio: null,
      anchorTextOffset: null,
      anchorTextSnippet: null,
      mediaAnchor: null,
    };
  }
  return { version, value, locator: value.locator, ...projectLocator(value.locator) };
}

/**
 * A modern locator may need the old shelf's fields for renderer compatibility.
 * `index`/`ratio` stay null for text/chapter-start; media keeps its own anchor.
 */
export function legacyShelfFields(projection: ReadingProjection): {
  readonly spineIndex: number;
  readonly page: number;
  readonly anchorIndex: number | null;
  readonly anchorRatio: number | null;
  readonly anchorTextOffset: number | null;
  readonly anchorTextSnippet: string | null;
  readonly mediaAnchor: MediaAnchorProjection | null;
} {
  return {
    spineIndex: projection.spineIndex,
    page: projection.page,
    anchorIndex: projection.anchorIndex,
    anchorRatio: projection.anchorRatio,
    anchorTextOffset: projection.anchorTextOffset,
    anchorTextSnippet: projection.anchorTextSnippet,
    mediaAnchor: projection.mediaAnchor,
  };
}

export function locatorChapterPath(locator: Locator): string | null {
  return locator.locatorVersion === 1 ? locator.chapterPath : null;
}

export function locatorSpineIndex(locator: Locator): number {
  return locator.locatorVersion === 1 ? locator.spineIndexHint : locator.spineIndex;
}

export function modernTargetKind(locator: Locator): ModernLocator["target"]["kind"] | null {
  return locator.locatorVersion === 1 ? locator.target.kind : null;
}
