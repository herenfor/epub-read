import { describe, expect, it } from "vitest";
import { APP_BUILD_INFO_PROTOCOL_VERSION, validateAppBuildInfo } from "./appBuildInfo";

const valid = {
  version: "0.2.3",
  edition: "core" as const,
  protocolVersion: APP_BUILD_INFO_PROTOCOL_VERSION,
  target: "x86_64-pc-windows-msvc",
  profile: "release",
  debug: false,
};

describe("app_build_info contract", () => {
  it("accepts a complete matching payload", () => {
    expect(validateAppBuildInfo(valid, "core")).toEqual(valid);
  });

  it("rejects a backend edition mismatch", () => {
    expect(() => validateAppBuildInfo({ ...valid, edition: "ai" }, "core"))
      .toThrow("前端为 core，后端为 ai");
    expect(() => validateAppBuildInfo(valid, "ai"))
      .toThrow("前端为 ai，后端为 core");
  });

  it("rejects malformed or incompatible payloads", () => {
    expect(() => validateAppBuildInfo(null, "core")).toThrow("无效数据");
    expect(() => validateAppBuildInfo({ ...valid, protocolVersion: 2 }, "core"))
      .toThrow("协议版本不兼容");
    expect(() => validateAppBuildInfo({ ...valid, debug: "false" }, "core"))
      .toThrow("debug");
  });
});
