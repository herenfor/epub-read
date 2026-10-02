/**
 * Build target platform policy shared by Vite, Node build scripts and the
 * frontend capability layer. This is intentionally dependency-free so it can
 * run in both Node and the browser build pipeline.
 */
export const APP_PLATFORMS = ["windows", "macos", "linux", "android", "ios", "web"] as const;

export type AppPlatform = (typeof APP_PLATFORMS)[number];
export type AppShell = "desktop" | "mobile" | "browser";

const PLATFORM_SET = new Set<string>(APP_PLATFORMS);

export function normalizeAppPlatform(value: unknown): AppPlatform {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (PLATFORM_SET.has(normalized)) return normalized as AppPlatform;
  throw new Error(`未知应用平台：${String(value)}`);
}

export function shellForPlatform(platform: AppPlatform): AppShell {
  if (platform === "android" || platform === "ios") return "mobile";
  if (platform === "web") return "browser";
  return "desktop";
}

/**
 * Best-effort mapping from Tauri/Cargo target strings to a platform value.
 * Unknown targets return null so callers can fail closed instead of guessing.
 */
export function platformFromTarget(target: string): AppPlatform | null {
  const value = target.toLowerCase();
  if (value.includes("android")) return "android";
  if (value.includes("windows")) return "windows";
  if (value.includes("ios")) return "ios";
  if (value.includes("darwin") || value.includes("apple")) return "macos";
  if (value.includes("linux")) return "linux";
  return null;
}

/**
 * Frontend output directory policy:
 * - desktop Core/AI keep the existing dist/core and dist/ai paths;
 * - every other edition/platform target gets a sibling directory so one
 *   build's emptyOutDir cannot delete another target's output.
 */
export function frontendOutDir(edition: string, platform: AppPlatform): string {
  if (platform === "windows") return edition === "ai" ? "dist/ai" : "dist/core";
  return edition === "ai" ? `dist/ai-${platform}` : `dist/core-${platform}`;
}
