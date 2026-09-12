import type { AppBuildInfo } from "./appBuildInfo";
import type { AppEdition } from "./edition";

export type AppBuildSession = Readonly<{
  source: "desktop" | "browser";
  edition: AppEdition;
  debug: boolean;
  buildInfo: Readonly<AppBuildInfo> | null;
}>;

type AppBuildSessionInput =
  | { source: "desktop"; buildInfo: AppBuildInfo }
  | { source: "browser"; edition: AppEdition; debug: boolean };

let currentSession: AppBuildSession | null = null;

/** Save immutable build metadata only after the startup checks have passed. */
export function setAppBuildSession(input: AppBuildSessionInput): AppBuildSession {
  const buildInfo = input.source === "desktop" ? Object.freeze({ ...input.buildInfo }) : null;
  currentSession = Object.freeze({
    source: input.source,
    edition: input.source === "desktop" ? input.buildInfo.edition : input.edition,
    debug: input.source === "desktop" ? input.buildInfo.debug : input.debug,
    buildInfo,
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
