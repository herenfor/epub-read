import { expect, it } from "vitest";
import { answerWithBooks } from "./conversation";
import { estimateTokens } from "./contextBudget";
import { parseSegment } from "./memoryMaintenance";
import { selectMemoryContext } from "./memoryContext";
import { companionDiagnostics } from "./diagnostics";
import type { ReadingLibrary } from "./retrieval";
import type { ChatMessage, SavedExchange } from "./types";

const context = { bookHash: "book-a", title: "甲书", creator: "", spineIndex: 0 };
const library: ReadingLibrary = { context, books: [], canRead: () => false, chapters: () => [],
  search: async () => [], read: async () => ({ hits: [], offset: 0, nextOffset: null }) };
const exchange = (id: string, question: string): SavedExchange => ({ id, question, answer: "我们讨论过。",
  evidence: [], createdAt: Number(id) || 1, revision: 1, context });

it("continuous input exceeds six exchanges, survives book changes and accounts for each protocol round", async () => {
  const history = Array.from({ length: 12 }, (_, index) => exchange(String(index + 1), `旧书的第${index}句话`));
  const requests: ChatMessage[][] = [];
  const replies: ChatMessage[] = [
    { role: "assistant", content: null, reasoning_content: "private-current-reasoning",
      tool_calls: [{ id: "chapters", type: "function", function: { name: "list_chapters", arguments: "{}" } }] },
    { role: "assistant", content: "继续聊。" },
  ];
  await answerWithBooks({ question: "换到乙书后接着说", history, memories: "", grounded: false,
    library: { ...library, context: { ...context, bookHash: "book-b", title: "乙书" } },
    signal: new AbortController().signal, onUpdate() {},
    transport: { complete: async messages => { requests.push(structuredClone(messages)); return replies.shift()!; } },
  });
  const data = JSON.parse(requests[0][1].content!.split("\n").slice(1).join("\n"));
  expect(data.recentConversation).toHaveLength(12);
  expect(data.context.bookHash).toBe("book-b");
  expect(data.recentConversation[0].context.bookHash).toBe("book-a");
  expect(requests[1][3].reasoning_content).toBe("private-current-reasoning");
  const turn = companionDiagnostics.snapshot().turns.at(-1)!;
  expect(turn.requests[1].context!.inputTokens).toBeGreaterThan(turn.requests[0].context!.inputTokens);
  expect(JSON.stringify(turn)).not.toContain("private-current-reasoning");
});

it("soft-budget compaction preserves the current question and never splits the active tool chain", async () => {
  const history = Array.from({ length: 30 }, (_, index) => exchange(String(index + 1), "旧话题".repeat(700)));
  let supplied: ChatMessage[] = [];
  await answerWithBooks({ question: "本轮完整问题", history, memories: "", grounded: false, library,
    contextPolicy: { softLimit: 10000, outputTokens: 8192 }, signal: new AbortController().signal, onUpdate() {},
    transport: { complete: async messages => { supplied = messages; return { role: "assistant", content: "继续。" }; } },
  });
  expect(supplied.at(-1)!.content).toBe("本轮完整问题");
  expect(estimateTokens(supplied)).toBeLessThan(10000);
  expect(history).toHaveLength(30);
});

it("derived memories preserve speaker provenance and are selected independently of original book evidence", () => {
  const source = exchange("1", "我明确喜欢慢慢讨论小说。");
  const payload = { summary: "用户表示喜欢慢慢讨论小说。", openTopics: [], memories: [
    { kind: "preference", content: "用户明确喜欢慢慢讨论小说。", sourceMessageIds: ["1:user"] },
  ] };
  const segment = parseSegment(JSON.stringify(payload), [source]);
  expect(segment.memories[0].sources).toEqual([{ exchangeId: "1", revision: 1, role: "user" }]);
  expect(selectMemoryContext([segment], "我们接着聊", "book-b", 200000).memories).toHaveLength(1);
  expect(() => parseSegment(JSON.stringify({ ...payload, memories: [
    { ...payload.memories[0], sourceMessageIds: ["1:assistant"] },
  ] }), [source])).toThrow("用户原话");
  expect(() => parseSegment(JSON.stringify({ ...payload, memories: [
    { ...payload.memories[0], sourceMessageIds: ["invented:user"] },
  ] }), [source])).toThrow("来源");
});
