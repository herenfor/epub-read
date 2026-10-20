import type { SearchResult } from "../../../core/search";
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";

export interface ChatSettings {
  baseUrl: string;
  model: string;
  allowLaterChapters: boolean;
  scope: "book" | "library";
  mode: "reading" | "chat";
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
}
export type ChatPhase = "planning" | "searching" | "reading" | "answering";
export interface ChatTransport {
  complete(messages: ChatMessage[], tools: readonly ChatTool[], signal: AbortSignal,
    onText: (text: string) => void): Promise<ChatMessage>;
}
