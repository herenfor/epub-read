import type { SearchResult } from "../../../core/search";
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";

export interface ChatSettings {
  baseUrl: string;
  model: string;
  allowLaterChapters: boolean;
  scope: "book" | "library";
  mode: "auto" | "reading";
  thinkingEnabled: boolean;
  contextTier: 100000 | 200000 | 400000;
  contextCapacity?: number;
  automaticMemory: boolean;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface Evidence {
  id: string;
  corpusVersion?: string;
  bookHash: string;
  bookTitle: string;
  chapterPath: string;
  chapterTitle: string;
  spineIndex: number;
  text: string;
  citation: SearchResult;
  hit: ResolvedCrossBookSearchHit;
}
export interface ReadingContext {
  bookHash: string;
  title: string;
  creator: string;
  spineIndex: number;
}
export interface SavedExchange {
  id: string;
  question: string;
  answer: string;
  evidence: Evidence[];
  createdAt: number;
  interrupted?: boolean;
  trace?: InvestigationStep[];
  context?: ReadingContext;
  revision?: number;
}
export interface InvestigationStep {
  tool: string;
  status: "running" | "ok" | "empty" | "error" | "cancelled";
  resultCount: number;
  elapsedMs: number;
  queries?: string[];
  chapterPath?: string;
  offset?: number;
  nextOffset?: number | null;
  error?: string;
}
export type ChatPhase = "planning" | "searching" | "reading" | "answering";
export interface ChatTransport {
  readonly requestInfo?: ChatRequestInfo;
  complete(messages: ChatMessage[], tools: readonly ChatTool[], signal: AbortSignal,
    onText: (text: string) => void): Promise<ChatMessage>;
}
export interface ChatRequestInfo {
  providerHost: string;
  model: string;
  thinking: "low" | "off" | "provider-default";
  maxTokens: number;
}
