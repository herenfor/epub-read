import type { ChatRequestInfo, ChatSettings } from "./types";

export function completionUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim().replace(/\/+$/u, "") + "/");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("请填写不含密钥和查询参数的 HTTP(S) API 地址");
  }
  return new URL("chat/completions", url).href;
}

/** Provider parameters stay separate from credentials, streaming and tool orchestration. */
export function resolveRequestPolicy(settings: ChatSettings) {
  const endpoint = completionUrl(settings.baseUrl);
  const deepseek = new URL(endpoint).hostname === "api.deepseek.com";
  const enabled = settings.thinkingEnabled;
  const info: ChatRequestInfo = {
    providerHost: new URL(endpoint).host, model: settings.model.trim(),
    thinking: enabled ? "low" : deepseek ? "off" : "provider-default",
    maxTokens: enabled ? 8192 : 4096,
  };
  const parameters = {
    model: info.model, stream: true, max_tokens: info.maxTokens,
    ...(deepseek ? { thinking: { type: enabled ? "enabled" : "disabled" } } : {}),
    ...(enabled ? { reasoning_effort: "low" } : {}),
  };
  return { endpoint, info, parameters };
}
