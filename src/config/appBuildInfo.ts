import type { AppEdition } from "./edition";

export const APP_BUILD_INFO_PROTOCOL_VERSION = 1 as const;

export interface AppBuildInfo {
  version: string;
  edition: AppEdition;
  protocolVersion: typeof APP_BUILD_INFO_PROTOCOL_VERSION;
  target: string;
  profile: string;
  debug: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEdition(value: unknown): value is AppEdition {
  return value === "core" || value === "ai";
}

/** Validate the small, read-only Rust/frontend startup handshake payload. */
export function validateAppBuildInfo(value: unknown, expectedEdition: AppEdition): AppBuildInfo {
  if (!isRecord(value)) throw new Error("app_build_info 返回了无效数据");
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error("app_build_info 缺少有效版本号");
  }
  if (!isEdition(value.edition)) throw new Error("app_build_info 返回了未知 edition");
  if (value.protocolVersion !== APP_BUILD_INFO_PROTOCOL_VERSION) {
    throw new Error(`app_build_info 协议版本不兼容：${String(value.protocolVersion)}`);
  }
  if (typeof value.target !== "string" || value.target.length === 0) {
    throw new Error("app_build_info 缺少有效 target");
  }
  if (typeof value.profile !== "string" || value.profile.length === 0) {
    throw new Error("app_build_info 缺少有效 profile");
  }
  if (typeof value.debug !== "boolean") throw new Error("app_build_info 缺少有效 debug 标记");
  if (value.edition !== expectedEdition) {
    throw new Error(`发行 edition 不匹配：前端为 ${expectedEdition}，后端为 ${value.edition}`);
  }
  return {
    version: value.version,
    edition: value.edition,
    protocolVersion: APP_BUILD_INFO_PROTOCOL_VERSION,
    target: value.target,
    profile: value.profile,
    debug: value.debug,
  };
}
