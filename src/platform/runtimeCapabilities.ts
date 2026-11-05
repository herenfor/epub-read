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
  /** Same native-session gate: reader-scoped keep-screen-on is Android-only. */
  supportsReaderKeepScreenOn: boolean;
  /** Volume-key paging is delivered by the same Android native session. */
  supportsVolumeKeyTurn: boolean;
  /** WebDAV sync needs the native credential store: native Windows and Android only. */
  supportsCloudSync: boolean;
  /** "Show in File Explorer" for a book's file: native Windows only. */
  supportsRevealSource: boolean;
  /** A34 book library folder (open it, choose its location): native Windows only. */
  supportsLibraryFolder: boolean;
  /** 复制到书库 on import: native Windows and Linux (path links) and Android (document links). */
  supportsImportCopyChoice: boolean;
  /** ER-0042 automatic import folder: native Windows and Android. */
  supportsFolderWatch: boolean;
  /** ER-0044 password-gated private shelf: native Windows and Android. */
  supportsPrivateShelf: boolean;
}

export function getRuntimeCapabilities(): RuntimeCapabilities {
  const session = getAppBuildSession();
  const platform = session?.platform ?? APP_PLATFORM;
  const shell = session?.shell ?? APP_SHELL;
  const androidNativeSession = session?.source === "desktop" && platform === "android";
  return {
    platform,
    shell,
    hasDesktopWindowChrome: shell === "desktop",
    usesAndroidBack: platform === "android",
    supportsCacheStorage: platform === "windows" || platform === "android",
    supportsCustomCacheDirectory: platform === "windows",
    supportsLanTransfer: platform === "windows" || platform === "android",
    supportsReaderSystemStatusBar: androidNativeSession,
    supportsReaderKeepScreenOn: androidNativeSession,
    supportsVolumeKeyTurn: androidNativeSession,
    supportsCloudSync: session?.source === "desktop" && (platform === "windows" || platform === "android"),
    supportsRevealSource: session?.source === "desktop" && platform === "windows",
    supportsLibraryFolder: session?.source === "desktop" && platform === "windows",
    supportsImportCopyChoice: session?.source === "desktop" && (platform === "windows" || platform === "android" || platform === "linux"),
    supportsFolderWatch: session?.source === "desktop" && (platform === "windows" || platform === "android"),
    supportsPrivateShelf: session?.source === "desktop" && (platform === "windows" || platform === "android"),
  };
}
