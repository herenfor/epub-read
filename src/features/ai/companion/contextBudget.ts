import type { ChatMessage, ChatTool, SavedExchange } from "./types";

/** Replaceable estimator, deliberately labelled as an estimate, not a tokenizer. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! > 127 ? 1.5 : 0.4;
  return Math.ceil(units);
}
export const exchangeTokens = (exchange: SavedExchange) => estimateTokens({
  id: exchange.id, question: exchange.question, answer: exchange.interrupted ? "" : exchange.answer,
  context: exchange.context, createdAt: exchange.createdAt,
});

export interface ContextPolicy { softLimit: number; capacity?: number; outputTokens: number }
export interface ContextLedger {
  kind: "estimate";
  inputTokens: number;
  softLimit: number;
  capacity?: number;
  outputTokens: number;
  safetyTokens: number;
  overSoftLimit: boolean;
  historyIds: string[];
  segmentIds: string[];
  memoryIds: string[];
  omittedHistory: number;
}
export function contextLedger(messages: readonly ChatMessage[], tools: readonly ChatTool[], policy: ContextPolicy,
  selected: Pick<ContextLedger, "historyIds" | "segmentIds" | "memoryIds" | "omittedHistory">): ContextLedger {
  // JSON includes current tool calls/results and real protocol reasoning exactly
  // once. Never copy reasoning into the ledger or into durable storage.
  const inputTokens = estimateTokens({ messages, tools }) + messages.length * 8;
  return { kind: "estimate", inputTokens, softLimit: policy.softLimit, capacity: policy.capacity,
    outputTokens: policy.outputTokens, safetyTokens: 16384, overSoftLimit: inputTokens > policy.softLimit, ...selected };
}
export function assertContextCapacity(ledger: ContextLedger): void {
  if (ledger.capacity && ledger.inputTokens + ledger.outputTokens + ledger.safetyTokens > ledger.capacity) {
    throw new Error("本轮必要资料接近已设置的接口容量，请分段查阅或核对接口上下文容量；对话记录仍保留。");
  }
}

export function recentWithinBudget(exchanges: readonly SavedExchange[], budget: number): SavedExchange[] {
  const selected: SavedExchange[] = [];
  let used = 0;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const size = exchangeTokens(exchanges[i]);
    // Keep the most recent complete exchange whole; capacity checks happen after
    // all request sections are assembled. The soft limit never cuts a sentence.
    if (selected.length && used + size > budget) break;
    selected.push(exchanges[i]); used += size;
  }
  return selected.reverse();
}
