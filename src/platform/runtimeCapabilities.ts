import { APP_PLATFORM, APP_SHELL, type AppPlatform, type AppShell } from "../config/appPlatform";
import { getAppBuildSession } from "../config/appBuildSession";

export interface RuntimeCapabilities {
  platform: AppPlatform;
  shell: AppShell;
  /** True only for native desktop shells that own window chrome. */
  hasDesktopWindowChrome: boolean;
  /** True when system Back should be coordinated by the app root. */
  usesAndroidBack: boolean;
}

export function getRuntimeCapabilities(): RuntimeCapabilities {
  const session = getAppBuildSession();
  const platform = session?.platform ?? APP_PLATFORM;
  const shell = session?.shell ?? APP_SHELL;
  return {
    platform,
    shell,
    hasDesktopWindowChrome: shell === "desktop",
    usesAndroidBack: platform === "android",
  };
}
