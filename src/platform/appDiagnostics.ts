import { validateAppBuildInfo, type AppBuildInfo } from "../config/appBuildInfo";
import { getAppBuildSession } from "../config/appBuildSession";
import { APP_EDITION } from "../config/edition";

/**
 * The environment facts a user may paste into a public issue. Mirrors the
 * native `app_diagnostics` DTO (schemaVersion 1). Only these fields are ever
 * copied: anything else the backend returns is dropped, and free-form strings
 * that do not look like an architecture or version fall back to unknown/null.
 */
export interface AppDiagnosticsV1 {
  schemaVersion: 1;
  build: AppBuildInfo;
  platform: "windows" | "android" | "linux" | "macos" | "ios" | "unknown";
  arch: string;
  distributionChannel: "installer" | "portable" | "deb" | "flatpak" | "aur" | "unknown";
  runtime: {
    name: "WebView2" | "Android WebView" | "WebKitGTK" | "WKWebView" | "unknown";
    version: string | null;
  };
  linuxSession: {
    display: "wayland" | "x11" | "unknown";
    source: "native" | "environment-hint" | "unavailable";
    wsl: boolean;
  } | null;
  compatibilityMode: "default" | "enabled" | "unavailable";
}

const PLATFORMS = ["windows", "android", "linux", "macos", "ios"] as const;
const CHANNELS = ["installer", "portable", "deb", "flatpak", "aur"] as const;
const RUNTIMES = ["WebView2", "Android WebView", "WebKitGTK", "WKWebView"] as const;
const DISPLAYS = ["wayland", "x11"] as const;
const SESSION_SOURCES = ["native", "environment-hint"] as const;
const COMPAT_MODES = ["default", "enabled"] as const;

// Compile-target names (x86_64, aarch64, armv7) and engine versions (2.48.3).
// Anything with spaces, slashes or other punctuation could be a path or a raw
// error, so it is not copied.
const ARCH_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+_-]{0,63}$/;

class InvalidDiagnosticsError extends Error {
  override name = "InvalidDiagnosticsError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick<T extends string, F extends string>(value: unknown, allowed: readonly T[], fallback: F): T | F {
  return (allowed as readonly unknown[]).includes(value) ? value as T : fallback;
}

/** Whitelist projection of whatever the native command returned. Throws on a malformed payload. */
export function projectAppDiagnostics(value: unknown): AppDiagnosticsV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new InvalidDiagnosticsError("schemaVersion");
  const build = validateAppBuildInfo(value.build, APP_EDITION);
  const runtime = isRecord(value.runtime) ? value.runtime : {};
  let linuxSession: AppDiagnosticsV1["linuxSession"] = null;
  if (value.linuxSession !== null && value.linuxSession !== undefined) {
    if (!isRecord(value.linuxSession)) throw new InvalidDiagnosticsError("linuxSession");
    const session = value.linuxSession;
    linuxSession = {
      display: pick(session.display, DISPLAYS, "unknown"),
      source: pick(session.source, SESSION_SOURCES, "unavailable"),
      wsl: session.wsl === true,
    };
  }
  return {
    schemaVersion: 1,
    build,
    platform: pick(value.platform, PLATFORMS, "unknown"),
    arch: typeof value.arch === "string" && ARCH_PATTERN.test(value.arch) ? value.arch : "unknown",
    distributionChannel: pick(value.distributionChannel, CHANNELS, "unknown"),
    runtime: {
      name: pick(runtime.name, RUNTIMES, "unknown"),
      version: typeof runtime.version === "string" && VERSION_PATTERN.test(runtime.version) ? runtime.version : null,
    },
    linuxSession,
    compatibilityMode: pick(value.compatibilityMode, COMPAT_MODES, "unavailable"),
  };
}

/** Readable, indented JSON in a fixed key order. */
export function formatAppDiagnostics(diagnostics: AppDiagnosticsV1): string {
  return JSON.stringify(diagnostics, null, 2);
}

/**
 * copied: the clipboard accepted the text.
 * unavailable: no native host (browser dev), so there is nothing honest to copy.
 * collect-failed: the native command failed or returned something unusable.
 * clipboard-failed: collection worked but the clipboard refused or is missing.
 */
export type CopyAppDiagnosticsOutcome = "copied" | "unavailable" | "collect-failed" | "clipboard-failed";

export interface CopyAppDiagnosticsDependencies {
  isNativeHost(): boolean;
  readNative(): Promise<unknown>;
  writeText(text: string): Promise<void>;
}

async function readNativeDiagnostics(): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<unknown>("app_diagnostics");
}

async function writeClipboardText(text: string): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) throw new Error("clipboard unavailable");
  await clipboard.writeText(text);
}

const defaultDependencies: CopyAppDiagnosticsDependencies = {
  isNativeHost: () => getAppBuildSession()?.source === "desktop",
  readNative: readNativeDiagnostics,
  writeText: writeClipboardText,
};

/** Collect once and copy the whitelisted JSON. Never throws and never puts error text on the clipboard. */
export async function copyAppDiagnostics(
  deps: CopyAppDiagnosticsDependencies = defaultDependencies,
): Promise<CopyAppDiagnosticsOutcome> {
  if (!deps.isNativeHost()) return "unavailable";
  let text: string;
  try {
    text = formatAppDiagnostics(projectAppDiagnostics(await deps.readNative()));
  } catch {
    return "collect-failed";
  }
  try {
    await deps.writeText(text);
  } catch {
    return "clipboard-failed";
  }
  return "copied";
}
