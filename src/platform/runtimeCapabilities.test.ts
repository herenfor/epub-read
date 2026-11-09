import { afterEach, expect, it } from "vitest";
import { clearAppBuildSession, setAppBuildSession } from "../config/appBuildSession";
import { APP_BUILD_INFO_PROTOCOL_VERSION } from "../config/appBuildInfo";
import { getRuntimeCapabilities } from "./runtimeCapabilities";

const buildInfo = { edition: "core", debug: false, version: "test", protocolVersion: APP_BUILD_INFO_PROTOCOL_VERSION, target: "test", profile: "release" } as const;

afterEach(() => clearAppBuildSession());

it("a native Linux session offers WebDAV sync and LAN transfer, like Windows and Android", () => {
  for (const platform of ["linux", "windows", "android"] as const) {
    setAppBuildSession({ source: "desktop", platform, buildInfo });
    const capabilities = getRuntimeCapabilities();
    expect([platform, capabilities.supportsCloudSync, capabilities.supportsLanTransfer]).toEqual([platform, true, true]);
  }
});

it("the browser preview and macOS stay without sync or LAN transfer", () => {
  setAppBuildSession({ source: "browser", edition: "core", debug: true });
  expect(getRuntimeCapabilities()).toMatchObject({ supportsCloudSync: false, supportsLanTransfer: false });
  setAppBuildSession({ source: "desktop", platform: "macos", buildInfo });
  expect(getRuntimeCapabilities()).toMatchObject({ supportsCloudSync: false, supportsLanTransfer: false });
});
