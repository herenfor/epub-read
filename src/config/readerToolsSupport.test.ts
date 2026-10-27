import { expect, it } from "vitest";
import type { AppBuildSession } from "./appBuildSession";
import { canUseNativeReaderTools } from "./readerToolsSupport";

it("uses the verified native debug identity even for a production-bundled frontend", () => {
  const session: AppBuildSession = { edition: "ai", source: "desktop", platform: "windows", shell: "desktop", debug: true, buildInfo: null };
  expect(canUseNativeReaderTools(session)).toBe(true);
  expect(canUseNativeReaderTools({ ...session, debug: false })).toBe(false);
  expect(canUseNativeReaderTools({ ...session, edition: "core" })).toBe(false);
  expect(canUseNativeReaderTools({ ...session, platform: "android" })).toBe(false);
  expect(canUseNativeReaderTools({ ...session, source: "browser" })).toBe(false);
});
