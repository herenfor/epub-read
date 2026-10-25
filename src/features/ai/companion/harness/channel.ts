export type HarnessRequest = { type: "request"; id: string; runId: string } & (
  { kind: "model"; data: { protocol: import("../types").ChatMessage[] } }
  | { kind: "tool"; data: import("../types").ToolCall }
  | { kind: "finalize"; data: { answer: string } }
);
type HarnessFrame = HarnessRequest | { type: "complete"; answer: string; modelRequests: number; toolCalls: number }
  | { type: "error"; message: string };

/** Same-origin development port. Aborting the stream tears down its host turn;
 * callbacks and provider requests share the caller's cancellation signal. */
export async function runHarness(input: { id: string; model: string; system: string; question: string;
  maxTokens: number; tools: readonly import("../types").ChatTool[] }, signal: AbortSignal,
  onRequest: (request: HarnessRequest) => Promise<unknown>) {
  const headers = { "Content-Type": "application/json", "X-Companion-Token": crypto.randomUUID() };
  const response = await fetch("/__ai-companion/harness/run", { method: "POST", headers, body: JSON.stringify(input), signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? "DSH开发宿主不可用；请使用AI本地预览入口");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("DSH未返回事件流");
  const decoder = new TextDecoder();
  let buffer = "";
  let localError: unknown;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline)) as HarnessFrame;
        buffer = buffer.slice(newline + 1);
        if (frame.type === "error") throw localError ?? new Error(frame.message);
        if (frame.type === "complete") return frame;
        let value: unknown;
        let failed = false;
        try { value = await onRequest(frame); }
        catch (error) { localError = error; failed = true; }
        signal.throwIfAborted();
        const reply = await fetch("/__ai-companion/harness/reply", { method: "POST", headers, signal,
          body: JSON.stringify({ runId: input.id, id: frame.id, ...(failed ? { error: true } : { value }) }) });
        if (!reply.ok) throw localError ?? new Error("DSH轮次已结束，未提交迟到结果");
      }
      if (chunk.done) throw new Error("DSH事件流提前结束；本轮未保存为完整回答");
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
