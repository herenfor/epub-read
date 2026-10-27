import type { AppBuildSession } from "./appBuildSession";

/** Native support uses the verified Rust build, never Vite's production/dev mode. */
export function canUseNativeReaderTools(session: AppBuildSession | null): boolean {
  return session?.edition === "ai" && session.source === "desktop"
    && session.platform === "windows" && session.debug;
}
