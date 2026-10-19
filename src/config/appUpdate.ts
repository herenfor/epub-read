/** Shared release policy. Networking, scheduling, persistence and UI live outside this module. */
export const UPDATE_CHECK_URL = "https://api.github.com/repos/herenfor/epub-read/releases/latest";
export const UPDATE_MANIFEST_URL = "https://github.com/herenfor/epub-read/releases/latest/download/latest.json";
const RELEASE_ROOT = "https://github.com/herenfor/epub-read/releases";
const HOUR = 60 * 60 * 1000;

export type InstallKind = "installer" | "portable" | "android" | "unsupported";
export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  sha256: string | null;
}
export interface LatestRelease {
  version: string;
  tag: string;
  publishedAt: string;
  htmlUrl: string;
  important: boolean;
  assets: readonly UpdateAsset[];
}
export interface UpdateState {
  autoCheck: boolean;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureCount?: number;
  skippedVersion?: string;
  lastLaunchedVersion?: string;
  cachedLatest?: LatestRelease & { fetchedAt: number };
}

interface Version {
  core: string[];
  pre: string[];
}

function version(value: string): Version | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  if (!match) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some(part => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core: match.slice(1, 4), pre };
}

function compareNumber(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Invalid versions cannot advertise an upgrade. Numeric components never pass through floats. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = version(a);
  const right = version(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    const order = compareNumber(left.core[i], right.core[i]);
    if (order) return order;
  }
  if (!left.pre.length || !right.pre.length) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/u.test(l);
    const rn = /^\d+$/u.test(r);
    if (ln && rn) return compareNumber(l, r);
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Only stable releases and download links belonging to this repository are eligible. */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  const input = object(json);
  if (!input || input.draft !== false || input.prerelease !== false ||
      typeof input.tag_name !== "string" || typeof input.published_at !== "string" ||
      !Number.isFinite(Date.parse(input.published_at)) || !Array.isArray(input.assets) ||
      (input.body !== null && typeof input.body !== "string")) return null;
  const parsed = version(input.tag_name);
  if (!parsed || parsed.pre.length || input.tag_name.includes("+")) return null;
  const tag = input.tag_name;
  const normalized = tag.startsWith("v") ? tag.slice(1) : tag;
  if (input.html_url !== `${RELEASE_ROOT}/tag/${tag}`) return null;
  const assets: UpdateAsset[] = [];
  for (const raw of input.assets) {
    const asset = object(raw);
    if (!asset || typeof asset.name !== "string" || !asset.name || /[\\/]/u.test(asset.name) ||
        typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
        asset.browser_download_url !== `${RELEASE_ROOT}/download/${tag}/${asset.name}`) return null;
    const digest = typeof asset.digest === "string" && /^sha256:[a-f\d]{64}$/iu.test(asset.digest)
      ? asset.digest.slice(7).toLowerCase() : null;
    assets.push({ name: asset.name, url: asset.browser_download_url as string, size: asset.size, sha256: digest });
  }
  return {
    version: normalized, tag, publishedAt: input.published_at,
    htmlUrl: input.html_url as string,
    important: typeof input.body === "string" && input.body.includes("<!-- epub-reader:update important -->"),
    assets,
  };
}

export function pickUpdateAsset(release: LatestRelease, kind: InstallKind): UpdateAsset | null {
  const name = kind === "installer" ? `EPUB.Reader_${release.version}_x64-setup.exe`
    : kind === "android" ? `epub-reader_${release.version}_android-arm64.apk`
    : kind === "portable" ? `epub-reader_${release.version}_portable.exe` : null;
  if (!name) return null;
  const matches = release.assets.filter(asset => asset.name === name &&
    asset.url === `${RELEASE_ROOT}/download/${release.tag}/${name}`);
  if (matches.length !== 1) return null;
  const asset = matches[0];
  return kind === "android" && !asset.sha256 ? null : asset;
}

export function shouldAutoCheck(state: UpdateState, now: number, kind: InstallKind): boolean {
  if (!state.autoCheck || kind === "unsupported") return false;
  if (state.lastSuccessAt !== undefined && now - state.lastSuccessAt < 24 * HOUR) return false;
  if (state.lastFailureAt !== undefined) {
    const backoff = (state.failureCount ?? 1) <= 1 ? 1 : state.failureCount === 2 ? 6 : 24;
    if (now - state.lastFailureAt < backoff * HOUR) return false;
  }
  return true;
}

export function recordCheck(state: UpdateState, now: number, result: LatestRelease | "failed"): UpdateState {
  if (result === "failed") return {
    ...state, lastFailureAt: now, failureCount: Math.min(3, (state.failureCount ?? 0) + 1),
  };
  const next = { ...state };
  delete next.lastFailureAt;
  delete next.failureCount;
  return {
    ...next, lastSuccessAt: now,
    cachedLatest: { ...result, assets: result.assets.map(asset => ({ ...asset })), fetchedAt: now },
  };
}

export function noticeFor(state: UpdateState, current: string, kind: InstallKind):
  { kind: "none" } | { kind: "available"; release: LatestRelease; asset: UpdateAsset | null } {
  const release = state.cachedLatest;
  if (!release || compareVersions(release.version, current) <= 0 ||
      (state.skippedVersion !== undefined && version(state.skippedVersion) !== null &&
       compareVersions(release.version, state.skippedVersion) === 0)) return { kind: "none" };
  return { kind: "available", release, asset: pickUpdateAsset(release, kind) };
}

export function launchNotice(state: UpdateState, current: string):
  { show: false; next: UpdateState } | { show: true; from: string; next: UpdateState } {
  const next = { ...state, lastLaunchedVersion: current };
  return state.lastLaunchedVersion && compareVersions(current, state.lastLaunchedVersion) > 0
    ? { show: true, from: state.lastLaunchedVersion, next } : { show: false, next };
}
