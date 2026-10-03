/**
 * Strict parser for the frozen portable-state v3 wire.
 *
 * The parser deliberately builds new objects instead of spreading incoming
 * JSON into domain objects: unknown fields must not silently cross the storage
 * boundary, and every field is re-created from the whitelist.
 */
import {
  MAX_ANCHOR_SNIPPET_CODE_POINTS,
  normalizeAnchorText,
} from "../../render/textAnchor";
import {
  MAX_SAFE_COUNTER,
  codePointCount,
  validCanonicalUuid,
  validContentHash,
  validateOrganization,
  type Register,
} from "../../ui/libraryOrganization";
import {
  MAX_NOTE_CONTENT_CODE_POINTS,
  MAX_NOTE_SELECTED_CODE_POINTS,
} from "../../ui/notes";
import {
  mergeVersions,
  type Annotation,
  type Json,
  type Stamp,
  type Version,
} from "./portable-register-core";
import type {
  BookMetadata,
  BookmarkValue,
  LegacyLocator,
  Locator,
  ModernLocator,
  NoteValue,
  PortableBook,
  PortablePreferences,
  PortableStateV3,
  ProgressValue,
} from "./portable-state-types";
import type { Theme } from "../../render/settings";

export const PORTABLE_STATE_SCHEMA_VERSION = 3 as const;

export interface PortableStateIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface PortableStateParseOptions {
  /**
   * `reject` is the default because v3 has no extension point yet: silently
   * dropping an unknown core field could overwrite data written by a newer
   * client. `ignore` exists only for callers that have an explicit forward
   * compatibility decision.
   */
  readonly unknownFields?: "reject" | "ignore";
}

export class PortableStateParseError extends Error {
  readonly issues: readonly PortableStateIssue[];

  constructor(issues: readonly PortableStateIssue[]) {
    const first = issues[0];
    super(first ? `portable state is invalid: ${first.path}: ${first.message}` : "portable state is invalid");
    this.name = "PortableStateParseError";
    this.issues = issues;
  }
}

export interface PortableStateParseResult {
  readonly state: PortableStateV3 | null;
  readonly errors: readonly PortableStateIssue[];
}

let activeParseOptions: PortableStateParseOptions = {};

type Bad = { readonly __bad: true };
const BAD: Bad = { __bad: true };
type Result<T> = T | Bad;

function isBad<T>(value: Result<T>): value is Bad {
  return value === BAD;
}

function fail<T>(failures: PortableStateIssue[], path: string, code: string, message: string): Result<T> {
  failures.push({ path, code, message });
  return BAD;
}

function objectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** `undefined` means an absent optional field; BAD means a present-but-invalid one. */
function readOptional(value: Record<string, unknown>, key: string): unknown | undefined {
  if (!hasOwn(value, key)) return undefined;
  const raw = value[key];
  return raw === undefined ? undefined : raw;
}

function checkFields(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  failures: PortableStateIssue[],
  options: PortableStateParseOptions,
): Result<void> {
  const effective = options.unknownFields === undefined ? activeParseOptions : options;
  if (effective.unknownFields === "ignore") return undefined;
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) return fail(failures, path ? `${path}.${key}` : key, "unknown-field", "unknown field");
  }
  return undefined;
}

function stringField(
  value: Record<string, unknown>, key: string, path: string, failures: PortableStateIssue[],
  required: true, nonEmpty?: boolean,
): Result<string>;
function stringField(
  value: Record<string, unknown>, key: string, path: string, failures: PortableStateIssue[],
  required: false, nonEmpty?: boolean,
): Result<string | undefined>;
function stringField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  failures: PortableStateIssue[],
  required: boolean,
  nonEmpty = false,
): Result<string | undefined> {
  const raw = readOptional(value, key);
  if (raw === undefined) {
    return required
      ? fail(failures, `${path}.${key}`, "missing-field", "required field is missing")
      : undefined;
  }
  if (typeof raw !== "string") {
    return fail(failures, `${path}.${key}`, "invalid-string", "expected a string");
  }
  if (nonEmpty && raw.length === 0) {
    return fail(failures, `${path}.${key}`, "invalid-string", "must not be empty");
  }
  return raw;
}

function safeIntegerField(
  value: Record<string, unknown>, key: string, path: string, failures: PortableStateIssue[], required: true,
): Result<number>;
function safeIntegerField(
  value: Record<string, unknown>, key: string, path: string, failures: PortableStateIssue[], required: false,
): Result<number | undefined>;
function safeIntegerField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  failures: PortableStateIssue[],
  required: boolean,
): Result<number | undefined> {
  const raw = readOptional(value, key);
  if (raw === undefined) {
    return required
      ? fail(failures, `${path}.${key}`, "missing-field", "required field is missing")
      : undefined;
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_SAFE_COUNTER) {
    return fail(failures, `${path}.${key}`, "invalid-number", "expected a non-negative safe integer");
  }
  return raw;
}

function finiteNumberField(
  value: Record<string, unknown>, key: string, path: string, failures: PortableStateIssue[], required: true,
): Result<number>;
function finiteNumberField(
  value: Record<string, unknown>, key: string, path: string, failures: PortableStateIssue[], required: false,
): Result<number | undefined>;
function finiteNumberField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  failures: PortableStateIssue[],
  required: boolean,
): Result<number | undefined> {
  const raw = readOptional(value, key);
  if (raw === undefined) {
    return required
      ? fail(failures, `${path}.${key}`, "missing-field", "required field is missing")
      : undefined;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fail(failures, `${path}.${key}`, "invalid-number", "expected a finite number");
  }
  return raw;
}

function nullableSafeIntegerField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  failures: PortableStateIssue[],
): Result<number | null> {
  const raw = readOptional(value, key);
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_SAFE_COUNTER) {
    return fail(failures, `${path}.${key}`, "invalid-number", "expected a non-negative safe integer or null");
  }
  return raw;
}

function nullableFiniteNumberField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  failures: PortableStateIssue[],
): Result<number | null> {
  const raw = readOptional(value, key);
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fail(failures, `${path}.${key}`, "invalid-number", "expected a finite number or null");
  }
  return raw;
}

function nullableStringField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  failures: PortableStateIssue[],
): Result<string | null> {
  const raw = readOptional(value, key);
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    return fail(failures, `${path}.${key}`, "invalid-string", "expected a string or null");
  }
  return raw;
}

function optionalStamp(value: Record<string, unknown>, key: string, path: string, failures: PortableStateIssue[]): Result<Stamp | undefined> {
  const raw = readOptional(value, key);
  if (raw === undefined) return undefined;
  if (!objectLike(raw)) return fail(failures, `${path}.${key}`, "invalid-stamp", "expected a stamp object");
  return parseStamp(raw, `${path}.${key}`, failures);
}

function parseStamp(raw: Record<string, unknown>, path: string, failures: PortableStateIssue[]): Result<Stamp> {
  checkFields(raw, path, ["deviceId", "counter"], failures, {});
  const deviceId = stringField(raw, "deviceId", path, failures, true, true);
  if (isBad(deviceId)) return BAD;
  const counter = safeIntegerField(raw, "counter", path, failures, true);
  if (isBad(counter)) return BAD;
  if (!validCanonicalUuid(deviceId) || counter === 0) {
    return fail(failures, path, "invalid-stamp", "deviceId must be a canonical lowercase UUID and counter must be at least 1");
  }
  return { deviceId, counter };
}

function parseClock(raw: Record<string, unknown>, path: string, stamp: Stamp, failures: PortableStateIssue[]): Result<Record<string, number>> {
  const clock: Record<string, number> = {};
  for (const [deviceId, counter] of Object.entries(raw)) {
    if (!validCanonicalUuid(deviceId)) {
      return fail(failures, `${path}.${deviceId}`, "invalid-clock", "clock deviceId must be a canonical lowercase UUID");
    }
    if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 1 || counter > MAX_SAFE_COUNTER) {
      return fail(failures, `${path}.${deviceId}`, "invalid-clock", "clock counter must be a positive safe integer");
    }
    if (deviceId === stamp.deviceId) {
      if (counter !== stamp.counter) {
        return fail(failures, `${path}.${deviceId}`, "invalid-clock", "event clock must include its own stamp counter");
      }
    } else if (counter >= stamp.counter) {
      return fail(failures, `${path}.${deviceId}`, "invalid-clock", "a Lamport event must follow every observed event");
    }
    clock[deviceId] = counter;
  }
  if (!hasOwn(clock, stamp.deviceId)) {
    return fail(failures, path, "invalid-clock", "event clock must include its own stamp");
  }
  return clock;
}

function parseVersion<T extends Json>(
  raw: Record<string, unknown>,
  path: string,
  failures: PortableStateIssue[],
  parseValue: (value: unknown, path: string, failures: PortableStateIssue[]) => Result<T>,
): Result<Version<T>> {
  checkFields(raw, path, ["stamp", "clock", "value", "updatedAtMs"], failures, {});
  const rawStamp = readOptional(raw, "stamp");
  if (rawStamp === undefined) return fail(failures, `${path}.stamp`, "missing-field", "required field is missing");
  if (!objectLike(rawStamp)) return fail(failures, `${path}.stamp`, "invalid-stamp", "expected a stamp object");
  const stamp = parseStamp(rawStamp, `${path}.stamp`, failures);
  if (isBad(stamp)) return BAD;
  const rawClock = readOptional(raw, "clock");
  if (rawClock === undefined) return fail(failures, `${path}.clock`, "missing-field", "required field is missing");
  if (!objectLike(rawClock)) return fail(failures, `${path}.clock`, "invalid-clock", "expected a clock object");
  const clock = parseClock(rawClock, `${path}.clock`, stamp, failures);
  if (isBad(clock)) return BAD;
  const rawValue = readOptional(raw, "value");
  if (rawValue === undefined) return fail(failures, `${path}.value`, "missing-field", "required field is missing");
  const value = parseValue(rawValue, `${path}.value`, failures);
  if (isBad(value)) return BAD;
  const updatedAtMs = safeIntegerField(raw, "updatedAtMs", path, failures, true);
  if (isBad(updatedAtMs)) return BAD;
  return { stamp, clock, value, updatedAtMs };
}

function validateEventList<T extends Json>(versions: readonly Version<T>[], path: string, failures: PortableStateIssue[]): void {
  try {
    mergeVersions(versions);
  } catch (error) {
    failures.push({
      path,
      code: "invalid-event-set",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseVersionList<T extends Json>(
  raw: unknown,
  path: string,
  failures: PortableStateIssue[],
  parseValue: (value: unknown, path: string, failures: PortableStateIssue[]) => Result<T>,
): Result<readonly Version<T>[]> {
  if (!Array.isArray(raw)) return fail(failures, path, "invalid-array", "expected an array");
  const versions: Version<T>[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!objectLike(item)) return fail(failures, `${path}[${index}]`, "invalid-version", "expected a version object");
    const version = parseVersion(item, `${path}[${index}]`, failures, parseValue);
    if (isBad(version)) return BAD;
    versions.push(version);
  }
  validateEventList(versions, path, failures);
  return versions;
}

function parseAnnotation<T extends Json>(
  raw: Record<string, unknown>,
  path: string,
  failures: PortableStateIssue[],
  parseValue: (value: unknown, path: string, failures: PortableStateIssue[]) => Result<T>,
): Result<Annotation<T>> {
  checkFields(raw, path, ["versions", "deleted"], failures, {});
  const rawVersions = readOptional(raw, "versions");
  if (rawVersions === undefined) return fail(failures, `${path}.versions`, "missing-field", "required field is missing");
  const versions = parseVersionList(rawVersions, `${path}.versions`, failures, parseValue);
  if (isBad(versions)) return BAD;
  const deleted = optionalStamp(raw, "deleted", path, failures);
  if (isBad(deleted)) return BAD;
  if (deleted && versions.length > 0) {
    return fail(failures, path, "invalid-annotation", "a deleted annotation must not retain versions");
  }
  return deleted ? { versions, deleted } : { versions };
}

function parseBookMetadataValue(raw: Record<string, unknown>, path: string, failures: PortableStateIssue[]): Result<BookMetadata> {
  checkFields(raw, path, ["title", "creator", "language", "fileName", "addedAtMs"], failures, {});
  const title = stringField(raw, "title", path, failures, true);
  if (isBad(title)) return BAD;
  const creator = stringField(raw, "creator", path, failures, true);
  if (isBad(creator)) return BAD;
  const language = stringField(raw, "language", path, failures, false);
  if (isBad(language)) return BAD;
  const fileName = stringField(raw, "fileName", path, failures, true);
  if (isBad(fileName)) return BAD;
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/|file:\/\/)/i.test(fileName)) {
    return fail(failures, `${path}.fileName`, "path-leak", "device paths are not allowed in portable state");
  }
  const addedAtMs = safeIntegerField(raw, "addedAtMs", path, failures, true);
  if (isBad(addedAtMs)) return BAD;
  return language === undefined ? { title, creator, fileName, addedAtMs } : { title, creator, language, fileName, addedAtMs };
}

function parseMetadataRegister(raw: Record<string, unknown>, path: string, failures: PortableStateIssue[]): Result<Register<BookMetadata>> {
  checkFields(raw, path, ["value", "stamp"], failures, {});
  const rawValue = readOptional(raw, "value");
  if (rawValue === undefined) return fail(failures, `${path}.value`, "missing-field", "required field is missing");
  if (!objectLike(rawValue)) return fail(failures, `${path}.value`, "invalid-metadata", "expected a metadata object");
  const value = parseBookMetadataValue(rawValue, `${path}.value`, failures);
  if (isBad(value)) return BAD;
  const rawStamp = readOptional(raw, "stamp");
  if (rawStamp === undefined) return fail(failures, `${path}.stamp`, "missing-field", "required field is missing");
  if (!objectLike(rawStamp)) return fail(failures, `${path}.stamp`, "invalid-stamp", "expected a stamp object");
  const stamp = parseStamp(rawStamp, `${path}.stamp`, failures);
  if (isBad(stamp)) return BAD;
  return { value, stamp };
}

function parseChapterPath(raw: unknown, path: string, failures: PortableStateIssue[]): Result<string> {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail(failures, path, "invalid-chapter-path", "expected a non-empty EPUB-internal path");
  }
  if (raw.includes("\\") || raw.startsWith("/") || raw.includes("#") || raw.includes("?") ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    return fail(failures, path, "invalid-chapter-path", "chapterPath must be a normalized EPUB-internal relative path");
  }
  return raw;
}

function parseTextTarget(raw: Record<string, unknown>, path: string, failures: PortableStateIssue[]): Result<ModernLocator["target"]> {
  checkFields(raw, path, ["kind", "textProfile", "offset", "snippet"], failures, {});
  const kind = stringField(raw, "kind", path, failures, true, true);
  if (isBad(kind)) return BAD;
  if (kind !== "text") return fail(failures, `${path}.kind`, "invalid-locator", "expected text target");
  const textProfile = stringField(raw, "textProfile", path, failures, true, true);
  if (isBad(textProfile)) return BAD;
  if (textProfile !== "visible-codepoints-no-whitespace-v1") {
    return fail(failures, `${path}.textProfile`, "unsupported-text-profile", "unsupported text profile");
  }
  const offset = safeIntegerField(raw, "offset", path, failures, true);
  if (isBad(offset)) return BAD;
  const snippet = stringField(raw, "snippet", path, failures, true, true);
  if (isBad(snippet)) return BAD;
  if (codePointCount(snippet) > MAX_ANCHOR_SNIPPET_CODE_POINTS || normalizeAnchorText(snippet) !== snippet) {
    return fail(failures, `${path}.snippet`, "invalid-anchor-text", "snippet must contain at most 32 non-whitespace code points");
  }
  return { kind: "text", textProfile, offset, snippet };
}

function parseMediaTarget(raw: Record<string, unknown>, path: string, failures: PortableStateIssue[]): Result<ModernLocator["target"]> {
  checkFields(raw, path, ["kind", "signature", "indexHint", "tag", "ratio"], failures, {});
  const kind = stringField(raw, "kind", path, failures, true, true);
  if (isBad(kind)) return BAD;
  if (kind !== "media") return fail(failures, `${path}.kind`, "invalid-locator", "expected media target");
  const signature = stringField(raw, "signature", path, failures, true, true);
  if (isBad(signature)) return BAD;
  const indexHint = safeIntegerField(raw, "indexHint", path, failures, true);
  if (isBad(indexHint)) return BAD;
  const tag = stringField(raw, "tag", path, failures, true, true);
  if (isBad(tag)) return BAD;
  if (tag !== "img" && tag !== "svg" && tag !== "video") {
    return fail(failures, `${path}.tag`, "invalid-locator", "media tag must be img, svg or video");
  }
  const ratio = finiteNumberField(raw, "ratio", path, failures, true);
  if (isBad(ratio)) return BAD;
  if (ratio < 0 || ratio > 1) return fail(failures, `${path}.ratio`, "invalid-range", "ratio must be between 0 and 1");
  return { kind: "media", signature, indexHint, tag, ratio };
}

function parseModernLocator(raw: Record<string, unknown>, path: string, failures: PortableStateIssue[]): Result<ModernLocator> {
  checkFields(raw, path, ["locatorVersion", "chapterPath", "spineIndexHint", "target"], failures, {});
  const rawTarget = readOptional(raw, "target");
  if (rawTarget === undefined) return fail(failures, `${path}.target`, "missing-field", "required field is missing");
  if (!objectLike(rawTarget)) return fail(failures, `${path}.target`, "invalid-locator", "expected a target object");
  const kind = stringField(rawTarget, "kind", `${path}.target`, failures, true, true);
  if (isBad(kind)) return BAD;
  let target: ModernLocator["target"];
  if (kind === "chapter-start") {
    checkFields(rawTarget, `${path}.target`, ["kind"], failures, {});
    target = { kind: "chapter-start" };
  } else if (kind === "text") {
    const parsed = parseTextTarget(rawTarget, `${path}.target`, failures);
    if (isBad(parsed)) return BAD;
    target = parsed;
  } else if (kind === "media") {
    const parsed = parseMediaTarget(rawTarget, `${path}.target`, failures);
    if (isBad(parsed)) return BAD;
    target = parsed;
  } else {
    return fail(failures, `${path}.target.kind`, "invalid-locator", "unknown target kind");
  }
  const chapterPath = parseChapterPath(readOptional(raw, "chapterPath"), `${path}.chapterPath`, failures);
  if (isBad(chapterPath)) return BAD;
  const spineIndexHint = safeIntegerField(raw, "spineIndexHint", path, failures, true);
  if (isBad(spineIndexHint)) return BAD;
  return { locatorVersion: 1, chapterPath, spineIndexHint, target };
}

function parseMediaAnchor(
  raw: unknown,
  path: string,
  failures: PortableStateIssue[],
): Result<LegacyLocator["mediaAnchor"]> {
  if (raw === undefined || raw === null) return null;
  if (!objectLike(raw)) return fail(failures, path, "invalid-media-anchor", "expected media anchor object or null");
  checkFields(raw, path, ["index", "tag", "signature", "ratio"], failures, {});
  const index = safeIntegerField(raw, "index", path, failures, true);
  if (isBad(index)) return BAD;
  const tag = stringField(raw, "tag", path, failures, true, true);
  if (isBad(tag)) return BAD;
  const signature = stringField(raw, "signature", path, failures, true, true);
  if (isBad(signature)) return BAD;
  const ratio = finiteNumberField(raw, "ratio", path, failures, true);
  if (isBad(ratio)) return BAD;
  if (ratio < 0 || ratio > 1) return fail(failures, `${path}.ratio`, "invalid-range", "ratio must be between 0 and 1");
  return { index, tag, signature, ratio };
}

function parseLegacyLocator(raw: Record<string, unknown>, path: string, failures: PortableStateIssue[]): Result<LegacyLocator> {
  checkFields(raw, path, [
    "locatorVersion", "spineIndex", "pageHint", "anchorIndex", "anchorRatio",
    "anchorTextOffset", "anchorTextSnippet", "mediaAnchor",
  ], failures, {});
  const spineIndex = safeIntegerField(raw, "spineIndex", path, failures, true);
  if (isBad(spineIndex)) return BAD;
  const pageHint = safeIntegerField(raw, "pageHint", path, failures, true);
  if (isBad(pageHint)) return BAD;
  const anchorIndex = nullableSafeIntegerField(raw, "anchorIndex", path, failures);
  if (isBad(anchorIndex)) return BAD;
  const anchorRatio = nullableFiniteNumberField(raw, "anchorRatio", path, failures);
  if (isBad(anchorRatio)) return BAD;
  if (anchorRatio !== null && (anchorRatio < 0 || anchorRatio > 1)) {
    return fail(failures, `${path}.anchorRatio`, "invalid-range", "ratio must be between 0 and 1");
  }
  const anchorTextOffset = nullableSafeIntegerField(raw, "anchorTextOffset", path, failures);
  if (isBad(anchorTextOffset)) return BAD;
  const anchorTextSnippet = nullableStringField(raw, "anchorTextSnippet", path, failures);
  if (isBad(anchorTextSnippet)) return BAD;
  if (anchorTextSnippet !== null &&
      (anchorTextSnippet.length === 0 || codePointCount(anchorTextSnippet) > MAX_ANCHOR_SNIPPET_CODE_POINTS ||
        normalizeAnchorText(anchorTextSnippet) !== anchorTextSnippet)) {
    return fail(failures, `${path}.anchorTextSnippet`, "invalid-anchor-text", "snippet must contain at most 32 non-whitespace code points");
  }
  const rawMedia = readOptional(raw, "mediaAnchor");
  const mediaAnchor = parseMediaAnchor(rawMedia, `${path}.mediaAnchor`, failures);
  if (isBad(mediaAnchor)) return BAD;
  return {
    locatorVersion: 0,
    spineIndex,
    pageHint,
    anchorIndex,
    anchorRatio,
    anchorTextOffset,
    anchorTextSnippet,
    mediaAnchor,
  };
}

export function parseLocator(raw: unknown, path = "locator", failures?: PortableStateIssue[]): Locator | null {
  const collecting = failures !== undefined;
  const targetFailures = failures ?? [];
  let locator: Locator | null = null;
  if (!objectLike(raw)) {
    fail(targetFailures, path, "invalid-locator", "expected a locator object");
  } else {
    const version = readOptional(raw, "locatorVersion");
    if (version === 1) {
      const parsed = parseModernLocator(raw, path, targetFailures);
      if (!isBad(parsed)) locator = parsed;
    } else if (version === 0) {
      const parsed = parseLegacyLocator(raw, path, targetFailures);
      if (!isBad(parsed)) locator = parsed;
    } else {
      fail(targetFailures, `${path}.locatorVersion`, "unsupported-locator-version", "locatorVersion must be 0 or 1");
    }
  }
  if (!collecting && targetFailures.length > 0) throw new PortableStateParseError(targetFailures);
  return locator;
}

function parseProgressValueInput(raw: unknown, path: string, failures: PortableStateIssue[]): Result<ProgressValue> {
  if (raw === null) return null;
  if (!objectLike(raw)) return fail(failures, path, "invalid-progress", "expected a progress object or explicit null");
  checkFields(raw, path, ["locator", "progressPctHint"], failures, {});
  const rawLocator = readOptional(raw, "locator");
  if (rawLocator === undefined) return fail(failures, `${path}.locator`, "missing-field", "required field is missing");
  const localFailures: PortableStateIssue[] = [];
  const locator = parseLocator(rawLocator, `${path}.locator`, localFailures);
  failures.push(...localFailures);
  if (!locator) return BAD;
  const rawPct = readOptional(raw, "progressPctHint");
  if (rawPct === undefined) return fail(failures, `${path}.progressPctHint`, "missing-field", "required field is missing");
  if (typeof rawPct !== "number" || !Number.isFinite(rawPct) || rawPct < 0 || rawPct > 100) {
    return fail(failures, `${path}.progressPctHint`, "invalid-range", "progressPctHint must be between 0 and 100");
  }
  return { locator, progressPctHint: rawPct };
}

function parseBookmarkValueInput(raw: unknown, path: string, failures: PortableStateIssue[]): Result<BookmarkValue> {
  if (!objectLike(raw)) return fail(failures, path, "invalid-bookmark", "expected a bookmark object");
  checkFields(raw, path, ["locator", "text", "createdAtMs"], failures, {});
  const rawLocator = readOptional(raw, "locator");
  if (rawLocator === undefined) return fail(failures, `${path}.locator`, "missing-field", "required field is missing");
  const localFailures: PortableStateIssue[] = [];
  const locator = parseLocator(rawLocator, `${path}.locator`, localFailures);
  failures.push(...localFailures);
  if (!locator) return BAD;
  const text = stringField(raw, "text", path, failures, true);
  if (isBad(text)) return BAD;
  const createdAtMs = safeIntegerField(raw, "createdAtMs", path, failures, true);
  if (isBad(createdAtMs)) return BAD;
  return { locator, text, createdAtMs };
}

function parseNoteValueInput(raw: unknown, path: string, failures: PortableStateIssue[]): Result<NoteValue> {
  if (!objectLike(raw)) return fail(failures, path, "invalid-note", "expected a note object");
  checkFields(raw, path, [
    "chapterPath", "spineIndexHint", "textProfile", "startTextOffset", "endTextOffset",
    "startTextSnippet", "endTextSnippet", "selectedText", "content", "createdAtMs",
  ], failures, {});
  const chapterPath = parseChapterPath(readOptional(raw, "chapterPath"), `${path}.chapterPath`, failures);
  if (isBad(chapterPath)) return BAD;
  const spineIndexHint = safeIntegerField(raw, "spineIndexHint", path, failures, true);
  if (isBad(spineIndexHint)) return BAD;
  const textProfile = stringField(raw, "textProfile", path, failures, true, true);
  if (isBad(textProfile)) return BAD;
  if (textProfile !== "visible-codepoints-no-whitespace-v1") {
    return fail(failures, `${path}.textProfile`, "unsupported-text-profile", "unsupported text profile");
  }
  const startTextOffset = safeIntegerField(raw, "startTextOffset", path, failures, true);
  if (isBad(startTextOffset)) return BAD;
  const endTextOffset = safeIntegerField(raw, "endTextOffset", path, failures, true);
  if (isBad(endTextOffset)) return BAD;
  if (endTextOffset <= startTextOffset) {
    return fail(failures, `${path}.endTextOffset`, "invalid-range", "endTextOffset must be greater than startTextOffset");
  }
  const startTextSnippet = stringField(raw, "startTextSnippet", path, failures, true, true);
  if (isBad(startTextSnippet)) return BAD;
  if (codePointCount(startTextSnippet) > MAX_ANCHOR_SNIPPET_CODE_POINTS || normalizeAnchorText(startTextSnippet) !== startTextSnippet) {
    return fail(failures, `${path}.startTextSnippet`, "invalid-anchor-text", "startTextSnippet must contain at most 32 non-whitespace code points");
  }
  const endTextSnippet = stringField(raw, "endTextSnippet", path, failures, true, true);
  if (isBad(endTextSnippet)) return BAD;
  if (codePointCount(endTextSnippet) > MAX_ANCHOR_SNIPPET_CODE_POINTS || normalizeAnchorText(endTextSnippet) !== endTextSnippet) {
    return fail(failures, `${path}.endTextSnippet`, "invalid-anchor-text", "endTextSnippet must contain at most 32 non-whitespace code points");
  }
  const selectedText = stringField(raw, "selectedText", path, failures, true, true);
  if (isBad(selectedText)) return BAD;
  if (codePointCount(selectedText) > MAX_NOTE_SELECTED_CODE_POINTS ||
      codePointCount(normalizeAnchorText(selectedText)) !== endTextOffset - startTextOffset) {
    return fail(failures, `${path}.selectedText`, "invalid-note", "selectedText does not match the code-point range");
  }
  const content = stringField(raw, "content", path, failures, true, true);
  if (isBad(content)) return BAD;
  if (codePointCount(content) > MAX_NOTE_CONTENT_CODE_POINTS) {
    return fail(failures, `${path}.content`, "invalid-note", "content exceeds the code-point limit");
  }
  const createdAtMs = safeIntegerField(raw, "createdAtMs", path, failures, true);
  if (isBad(createdAtMs)) return BAD;
  return {
    chapterPath,
    spineIndexHint,
    textProfile,
    startTextOffset,
    endTextOffset,
    startTextSnippet,
    endTextSnippet,
    selectedText,
    content,
    createdAtMs,
  };
}

const THEMES: readonly Theme[] = ["light", "dark", "sepia", "gray"];

function parsePreferences(raw: unknown, path: string, failures: PortableStateIssue[]): Result<PortablePreferences> {
  if (!objectLike(raw)) return fail(failures, path, "invalid-preferences", "expected a preferences object");
  checkFields(raw, path, ["theme", "fontSizePx", "lineHeight", "fontWeight", "letterSpacingPx", "wordSpacingPx"], failures, {});
  const out: { -readonly [K in keyof PortablePreferences]: PortablePreferences[K] } = {};
  const theme = stringField(raw, "theme", path, failures, false, true);
  if (isBad(theme)) return BAD;
  if (theme !== undefined) {
    if (!THEMES.includes(theme as Theme)) return fail(failures, `${path}.theme`, "invalid-preference", "unsupported theme");
    out.theme = theme as Theme;
  }
  const numeric = (key: keyof PortablePreferences, min: number, max: number): Result<void> => {
    const value = finiteNumberField(raw, key, path, failures, false);
    if (isBad(value)) return BAD;
    if (value !== undefined) {
      if (value < min || value > max) return fail(failures, `${path}.${key}`, "invalid-preference", `${key} must be between ${min} and ${max}`);
      (out as Record<string, unknown>)[key] = value;
    }
    return undefined;
  };
  for (const [key, min, max] of [
    ["fontSizePx", 12, 32],
    ["lineHeight", 1, 3],
    ["fontWeight", 100, 900],
    ["letterSpacingPx", 0, 32],
    ["wordSpacingPx", 0, 64],
  ] as const) {
    const result = numeric(key, min, max);
    if (isBad(result)) return BAD;
  }
  return out;
}

function parsePortableBook(raw: Record<string, unknown>, path: string, failures: PortableStateIssue[]): Result<PortableBook> {
  checkFields(raw, path, ["metadata", "progress", "bookmarks", "notes"], failures, {});
  const rawMetadata = readOptional(raw, "metadata");
  if (!objectLike(rawMetadata)) return fail(failures, `${path}.metadata`, "invalid-metadata", "expected a metadata register");
  const metadata = parseMetadataRegister(rawMetadata, `${path}.metadata`, failures);
  if (isBad(metadata)) return BAD;

  const rawProgress = readOptional(raw, "progress");
  if (!objectLike(rawProgress)) return fail(failures, `${path}.progress`, "invalid-progress", "expected a progress object");
  checkFields(rawProgress, `${path}.progress`, ["versions"], failures, {});
  const rawProgressVersions = readOptional(rawProgress, "versions");
  if (rawProgressVersions === undefined) return fail(failures, `${path}.progress.versions`, "missing-field", "required field is missing");
  const progressVersions = parseVersionList(rawProgressVersions, `${path}.progress.versions`, failures, parseProgressValueInput);
  if (isBad(progressVersions)) return BAD;

  const rawBookmarks = readOptional(raw, "bookmarks");
  if (!objectLike(rawBookmarks)) return fail(failures, `${path}.bookmarks`, "invalid-annotations", "expected an annotation dictionary");
  const bookmarks: Record<string, Annotation<BookmarkValue>> = {};
  for (const [id, item] of Object.entries(rawBookmarks)) {
    if (id.length === 0) return fail(failures, `${path}.bookmarks`, "invalid-id", "annotation id must not be empty");
    if (!objectLike(item)) return fail(failures, `${path}.bookmarks.${id}`, "invalid-annotation", "expected an annotation object");
    const annotation = parseAnnotation(item, `${path}.bookmarks.${id}`, failures, parseBookmarkValueInput);
    if (isBad(annotation)) return BAD;
    bookmarks[id] = annotation;
  }

  const rawNotes = readOptional(raw, "notes");
  if (!objectLike(rawNotes)) return fail(failures, `${path}.notes`, "invalid-annotations", "expected an annotation dictionary");
  const notes: Record<string, Annotation<NoteValue>> = {};
  for (const [id, item] of Object.entries(rawNotes)) {
    if (id.length === 0) return fail(failures, `${path}.notes`, "invalid-id", "annotation id must not be empty");
    if (!objectLike(item)) return fail(failures, `${path}.notes.${id}`, "invalid-annotation", "expected an annotation object");
    const annotation = parseAnnotation(item, `${path}.notes.${id}`, failures, parseNoteValueInput);
    if (isBad(annotation)) return BAD;
    notes[id] = annotation;
  }

  return { metadata, progress: { versions: progressVersions }, bookmarks, notes };
}

function parseBooks(raw: unknown, path: string, failures: PortableStateIssue[], options: PortableStateParseOptions): Result<Record<string, PortableBook>> {
  void options;
  if (!objectLike(raw)) return fail(failures, path, "invalid-books", "expected a book dictionary");
  const books: Record<string, PortableBook> = {};
  for (const [hash, value] of Object.entries(raw)) {
    if (!validContentHash(hash)) {
      return fail(failures, `${path}.${hash}`, "invalid-hash", "book key must be a lowercase SHA-256 hash");
    }
    if (!objectLike(value)) return fail(failures, `${path}.${hash}`, "invalid-book", "expected a book object");
    const book = parsePortableBook(value, `${path}.${hash}`, failures);
    if (isBad(book)) return BAD;
    books[hash] = book;
  }
  return books;
}

function parsePortableStateObject(raw: unknown, failures: PortableStateIssue[], options: PortableStateParseOptions): PortableStateV3 | null {
  if (!objectLike(raw)) {
    fail(failures, "$", "invalid-state", "expected a state object");
    return null;
  }
  checkFields(raw, "", ["schemaVersion", "books", "organization", "preferences"], failures, options);
  const schemaVersion = readOptional(raw, "schemaVersion");
  if (schemaVersion !== PORTABLE_STATE_SCHEMA_VERSION) {
    fail(failures, "schemaVersion", "unsupported-schema-version", "only portable state schemaVersion 3 is supported");
    return null;
  }
  const rawBooks = readOptional(raw, "books");
  if (rawBooks === undefined) return fail(failures, "books", "missing-field", "required field is missing"), null;
  const books = parseBooks(rawBooks, "books", failures, options);
  if (isBad(books)) return null;

  const rawOrganization = readOptional(raw, "organization");
  if (rawOrganization === undefined) return fail(failures, "organization", "missing-field", "required field is missing"), null;
  let organization;
  try {
    organization = validateOrganization(rawOrganization);
  } catch (error) {
    fail(failures, "organization", "invalid-organization", error instanceof Error ? error.message : String(error));
    return null;
  }

  const rawPreferences = readOptional(raw, "preferences");
  let preferences: PortablePreferences | undefined;
  if (rawPreferences !== undefined) {
    const parsed = parsePreferences(rawPreferences, "preferences", failures);
    if (isBad(parsed)) return null;
    preferences = parsed;
    if (Object.keys(parsed).length === 0 && options.unknownFields === "ignore") preferences = undefined;
  }

  const result: {
    schemaVersion: 3;
    books: Record<string, PortableBook>;
    organization: typeof organization;
    preferences?: PortablePreferences;
  } = { schemaVersion: PORTABLE_STATE_SCHEMA_VERSION, books, organization };
  if (preferences !== undefined) result.preferences = preferences;
  return result;
}

/** Strict parse result; never modifies the caller's object and never throws for invalid payloads. */
export function tryParsePortableStateV3(
  input: unknown,
  options: PortableStateParseOptions = {},
): PortableStateParseResult {
  const failures: PortableStateIssue[] = [];
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input) as unknown;
    } catch {
      failures.push({ path: "$", code: "invalid-json", message: "state is not valid JSON" });
      return { state: null, errors: failures };
    }
  }
  const previousOptions = activeParseOptions;
  activeParseOptions = options;
  try {
    const state = parsePortableStateObject(raw, failures, options);
    return { state: failures.length === 0 ? state : null, errors: failures };
  } finally {
    activeParseOptions = previousOptions;
  }
}

/** Strict parser used at all portable-state storage/import boundaries. */
export function parsePortableStateV3(
  input: unknown,
  options: PortableStateParseOptions = {},
): PortableStateV3 {
  const result = tryParsePortableStateV3(input, options);
  if (!result.state) throw new PortableStateParseError(result.errors);
  return result.state;
}

export const normalizePortableStateV3 = parsePortableStateV3;

/** Validate a standalone preferences value (used by repository meta storage). */
export function parsePortablePreferences(raw: unknown): PortablePreferences {
  const failures: PortableStateIssue[] = [];
  const parsed = parsePreferences(raw, "preferences", failures);
  if (isBad(parsed) || failures.length > 0) throw new PortableStateParseError(failures);
  return parsed;
}

/** Validate one caller-supplied entity value at a repository command boundary. */
export function parseProgressValue(raw: unknown): ProgressValue {
  const failures: PortableStateIssue[] = [];
  const parsed = parseProgressValueInput(raw, "value", failures);
  if (isBad(parsed) || failures.length > 0) throw new PortableStateParseError(failures);
  return parsed;
}

export function parseBookmarkValue(raw: unknown): BookmarkValue {
  const failures: PortableStateIssue[] = [];
  const parsed = parseBookmarkValueInput(raw, "value", failures);
  if (isBad(parsed) || failures.length > 0) throw new PortableStateParseError(failures);
  return parsed;
}

export function parseNoteValue(raw: unknown): NoteValue {
  const failures: PortableStateIssue[] = [];
  const parsed = parseNoteValueInput(raw, "value", failures);
  if (isBad(parsed) || failures.length > 0) throw new PortableStateParseError(failures);
  return parsed;
}
