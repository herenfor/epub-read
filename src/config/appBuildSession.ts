import type { AppBuildInfo } from "./appBuildInfo";
import type { AppEdition } from "./edition";
import { platformFromTarget, shellForPlatform, type AppPlatform, type AppShell } from "./platformValue";

export type AppBuildSession = Readonly<{
  /** "desktop" means a native Tauri host; "browser" means no native backend. */
  source: "desktop" | "browser";
  edition: AppEdition;
  debug: boolean;
  platform: AppPlatform;
  shell: AppShell;
  buildInfo: Readonly<AppBuildInfo> | null;
}>;

type AppBuildSessionInput =
  | { source: "desktop"; buildInfo: AppBuildInfo; platform?: AppPlatform }
  | { source: "browser"; edition: AppEdition; debug: boolean };

let currentSession: AppBuildSession | null = null;

/** Save immutable build metadata only after the startup checks have passed. */
export function setAppBuildSession(input: AppBuildSessionInput): AppBuildSession {
  if (input.source === "desktop") {
    const platform = input.platform ?? platformFromTarget(input.buildInfo.target) ?? "windows";
    const buildInfo = Object.freeze({ ...input.buildInfo });
    currentSession = Object.freeze({
      source: "desktop",
      edition: buildInfo.edition,
      debug: buildInfo.debug,
      platform,
      shell: shellForPlatform(platform),
      buildInfo,
    });
    return currentSession;
  }

  currentSession = Object.freeze({
    source: "browser",
    edition: input.edition,
    debug: input.debug,
    platform: "web",
    shell: "browser",
    buildInfo: null,
  });
  return currentSession;
}

/** Read-only session projection used by UI capability gates. */
export function getAppBuildSession(): AppBuildSession | null {
  return currentSession;
}

/** Clear startup state when bootstrap fails or between isolated tests. */
export function clearAppBuildSession(): void {
  currentSession = null;
}

/** Pure policy: release builds never expose mock/provider development actions. */
export function canUseAiDevelopmentActions(
  session: Pick<AppBuildSession, "edition" | "debug"> | null,
): boolean {
  return session?.edition === "ai" && session.debug;
}

/** Read-only query for AI UI components after successful application bootstrap. */
export function isAiDevelopmentActionsAllowed(): boolean {
  return canUseAiDevelopmentActions(currentSession);
}
