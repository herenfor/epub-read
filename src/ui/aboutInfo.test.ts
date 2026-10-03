import { describe, expect, it } from "vitest";
import type { AppBuildSession } from "../config/appBuildSession";
import { projectAboutInfo } from "./AboutInfo";

const nativeSession: AppBuildSession = {
  source: "desktop",
  edition: "core",
  debug: false,
  platform: "android",
  shell: "mobile",
  buildInfo: {
    version: "0.2.8",
    edition: "core",
    protocolVersion: 1,
    target: "aarch64-linux-android",
    profile: "release",
    debug: false,
  },
};

const browserSession: AppBuildSession = {
  source: "browser",
  edition: "core",
  debug: false,
  platform: "web",
  shell: "browser",
  buildInfo: null,
};

describe("about info projection", () => {
  it("uses handshake buildInfo for native sessions", () => {
    const result = projectAboutInfo(nativeSession, { version: "0.0.0", edition: "ai" });
    expect(result).toMatchObject({
      productName: "EPUB Reader",
      version: "0.2.8",
      edition: "Core",
      channel: "Android 原生",
    });
    expect(result?.copyText).toContain("Target：aarch64-linux-android");
    expect(result?.copyText).toContain("Profile：release");
    expect(result?.copyText).toContain("Debug：否");
    expect(result?.copyText).not.toContain("0.0.0");
  });

  it("uses the Vite compile-time version for browser previews", () => {
    const result = projectAboutInfo(browserSession, { version: "0.2.8", edition: "ai" });
    expect(result).toMatchObject({
      version: "0.2.8",
      edition: "AI",
      channel: "Web 预览",
    });
    expect(result?.copyText).toContain("来源：Web 预览（前端编译版本）");
  });

  it("never fakes a version without a bootstrap session", () => {
    expect(projectAboutInfo(null, { version: "0.2.8", edition: "core" })).toBeNull();
    expect(projectAboutInfo({ ...nativeSession, buildInfo: null } as AppBuildSession, { version: "0.2.8", edition: "core" })).toBeNull();
  });
});
