import { APP_PLATFORM, APP_SHELL, type AppPlatform, type AppShell } from "../config/appPlatform";
import { getAppBuildSession } from "../config/appBuildSession";

export interface RuntimeCapabilities {
  platform: AppPlatform;
  shell: AppShell;
  /** True only for native desktop shells that own window chrome. */
  hasDesktopWindowChrome: boolean;
  /** True when system Back should be coordinated by the app root. */
  usesAndroidBack: boolean;
  /** Cache panel is available on Windows desktop and Android. */
  supportsCacheStorage: boolean;
  /** Native folder picking is only offered on Windows in this package. */
  supportsCustomCacheDirectory: boolean;
  /** Shared LAN save panel is delivered on Windows and Android only in this package. */
  supportsLanTransfer: boolean;
  /** Only an established Android native session can control system status bars. */
  supportsReaderSystemStatusBar: boolean;
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
    supportsCacheStorage: platform === "windows" || platform === "android",
    supportsCustomCacheDirectory: platform === "windows",
    supportsLanTransfer: platform === "windows" || platform === "android",
    supportsReaderSystemStatusBar: session?.source === "desktop" && platform === "android",
  };
}
