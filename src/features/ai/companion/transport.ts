import { Channel, invoke } from "@tauri-apps/api/core";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import type { ChatMessage, ChatSettings, ChatTransport, ToolCall } from "./types";
import { resolveRequestPolicy } from "./requestPolicy";
export { completionUrl } from "./requestPolicy";

/** SSE framing is independent of network chunk and UTF-8 boundaries. */
export class ChatStreamDecoder {
  private decoder = new TextDecoder();
  private pending = "";
  private text = "";
  private reasoning = "";
  private hasReasoning = false;
  private calls = new Map<number, ToolCall>();
  private finished = false;
  private finishReason = "";
  constructor(private onText: (text: string) => void) {}

  push(bytes: Uint8Array): void {
    this.pending += this.decoder.decode(bytes, { stream: true });
    this.drain();
  }
  private drain(): void {
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/u.exec(this.pending))) {
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { this.finished = true; continue; }
      const packet = JSON.parse(data) as {
        error?: { message?: string };
        choices?: Array<{ finish_reason?: string | null; delta?: {
          content?: string | null; reasoning_content?: string;
          tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
        } }>;
      };
      if (packet.error) throw new Error(packet.error.message || "模型服务返回错误");
      const choice = packet.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) { this.text += delta.content; this.onText(this.text); }
      this.reasoning += delta?.reasoning_content ?? "";
      if (typeof delta?.reasoning_content === "string") this.hasReasoning = true;
      for (const part of delta?.tool_calls ?? []) {
        const call = this.calls.get(part.index) ?? { id: "", type: "function" as const,
          function: { name: "", arguments: "" } };
        if (part.id) call.id = part.id;
        call.function.name += part.function?.name ?? "";
        call.function.arguments += part.function?.arguments ?? "";
        this.calls.set(part.index, call);
      }
    }
  }
  end(): ChatMessage {
    this.pending += this.decoder.decode();
    this.drain();
    if (!this.finished || !["stop", "tool_calls"].includes(this.finishReason)) {
      throw new Error(this.finishReason === "length" ? "回答达到输出上限，请缩小问题后重试" : "模型响应未完整结束，请重试");
    }
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    return { role: "assistant", content: this.text || null,
      ...(this.hasReasoning ? { reasoning_content: this.reasoning } : {}),
      ...(calls.length ? { tool_calls: calls } : {}) };
  }
}

export function createChatTransport(settings: ChatSettings, apiKey: string): ChatTransport {
  const policy = resolveRequestPolicy(settings);
  return {
    requestInfo: policy.info,
    async complete(messages, tools, signal, onText) {
      if (!isAiDevelopmentActionsAllowed()) throw new Error("阅读伙伴仅在 AI 开发版开放");
      signal.throwIfAborted();
      const endpoint = policy.endpoint;
      const payload = {
        ...policy.parameters, messages,
        ...(tools.length ? { tools } : {}),
      };
      const decoder = new ChatStreamDecoder(onText);
      if (getAppBuildSession()?.source === "desktop") {
        const requestId = crypto.randomUUID();
        const channel = new Channel<number[]>();
        let decodeError: unknown;
        const cancel = () => { void invoke("ai_chat_cancel", { requestId }).catch(() => {}); };
        channel.onmessage = (data) => {
          if (signal.aborted) { cancel(); return; }
          if (decodeError) return;
          try { decoder.push(new Uint8Array(data)); }
          catch (error) { decodeError = error; cancel(); }
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          await invoke("ai_chat_stream", { input: { requestId, endpoint, apiKey, payload }, onChunk: channel });
          signal.throwIfAborted();
          if (decodeError) throw decodeError;
        } catch (error) {
          signal.throwIfAborted();
          throw decodeError ?? error;
        } finally {
          signal.removeEventListener("abort", cancel);
          channel.onmessage = () => {};
        }
      } else {
        const response = await fetch(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(payload), signal,
        });
        if (!response.ok) throw new Error(`API 请求失败（HTTP ${response.status}），请检查地址、模型和密钥`);
        if (!response.body) throw new Error("服务没有返回流式内容");
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            decoder.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      signal.throwIfAborted();
      return decoder.end();
    },
  };
}

export function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
