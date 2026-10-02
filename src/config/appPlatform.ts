import { shellForPlatform, type AppPlatform, type AppShell } from "./platformValue";

declare const __APP_PLATFORM__: AppPlatform;

export type { AppPlatform, AppShell } from "./platformValue";
export { normalizeAppPlatform, platformFromTarget, shellForPlatform } from "./platformValue";

/** Build-time target, injected by Vite from VITE_APP_PLATFORM. */
export const APP_PLATFORM: AppPlatform = __APP_PLATFORM__;
export const APP_SHELL: AppShell = shellForPlatform(APP_PLATFORM);

export function isAndroidPlatform(): boolean {
  return APP_PLATFORM === "android";
}

export function isMobileShell(): boolean {
  return APP_SHELL === "mobile";
}
