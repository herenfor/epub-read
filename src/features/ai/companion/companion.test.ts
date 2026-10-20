import { describe, expect, it } from "vitest";
import { ChatStreamDecoder } from "./transport";
import { answerWithBooks } from "./conversation";
import { chapterPage, fuseHits, type ReadingLibrary } from "./retrieval";
import type { ChatMessage, ChatTransport } from "./types";
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";

const hit = (id: string, offset = 0): ResolvedCrossBookSearchHit => ({
  contentHash: "a".repeat(64), title: "测试书", creator: "", chunkId: id, spineIndex: 1,
  chapterPath: "c1.xhtml", chapterTitle: "第一章", contentType: "paragraph",
  originalText: "甲当时并不知道乙已经离开。", normalizedText: "甲当时并不知道乙已经离开。",
  textAnchor: { start: offset, end: offset + 15, snippet: "甲当时并不知道" },
});
function fixture(responses: ChatMessage[], hits = [hit("one")]) {
  const messages: ChatMessage[][] = [];
  const library: ReadingLibrary = {
    context: { bookHash: "a".repeat(64), title: "测试书", creator: "", spineIndex: 1 },
    books: [], chapters: () => [{ chapterPath: "c1.xhtml", title: "第一章", spineIndex: 1 }],
    search: async () => hits, read: async () => ({ hits, offset: 0, nextOffset: null }),
  };
  const transport: ChatTransport = { complete: async input => {
    messages.push(structuredClone(input));
    const response = responses.shift();
    if (!response) throw new Error("Unexpected model request");
    return response;
  } };
  return { library, transport, messages };
}
const tool = (name: string, args: unknown): ChatMessage => ({ role: "assistant", content: null,
  tool_calls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

describe("experimental reading companion", () => {
  it("decodes UTF-8 and tool arguments across arbitrary SSE network chunks", () => {
    const decoder = new ChatStreamDecoder(() => {});
    const stream = [
      { choices: [{ delta: { content: "查阅中文", tool_calls: [{ index: 0, id: "a", function: { name: "search_library", arguments: '{"queries":[' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"甲"]}' } }] }, finish_reason: "tool_calls" }] },
    ].map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    for (const byte of new TextEncoder().encode(stream)) decoder.push(new Uint8Array([byte]));
    const result = decoder.end();
    expect(result.content).toBe("查阅中文");
    expect(JSON.parse(result.tool_calls![0].function.arguments)).toEqual({ queries: ["甲"] });
  });

  it("requires a real lookup and expanded context before accepting a causal answer", async () => {
    const f = fixture([
      { role: "assistant", content: "甲故意没有去。" },
      tool("search_library", { queries: ["甲", "离开"] }),
      { role: "assistant", content: "甲不知道。[E1]" },
      tool("read_chapter", { bookHash: "a".repeat(64), chapterPath: "c1.xhtml", offset: 0 }),
      { role: "assistant", content: "原文说明甲当时并不知情。[E1]" },
    ]);
    const result = await answerWithBooks({ ...f, question: "甲为什么没有去？", grounded: true, history: [], memories: "",
      signal: new AbortController().signal, onUpdate: () => {} });
    expect(result.answer).toContain("并不知情");
    expect(result.evidence[0].text).toBe(hit("one").originalText);
    expect(f.messages).toHaveLength(5);
  });

  it("does not publish a guessed book fact when the actual retrieval is empty", async () => {
    const f = fixture([tool("search_library", { queries: ["甲"] }), { role: "assistant", content: "甲一定知道。" }], []);
    const result = await answerWithBooks({ ...f, question: "甲知道吗？", grounded: true, history: [], memories: "",
      signal: new AbortController().signal, onUpdate: () => {} });
    expect(result.answer).toContain("未取得足够的原文依据");
    expect(result.answer).not.toContain("一定知道");
    expect(result.evidence).toEqual([]);
  });

  it("fuses distinct keyword rankings without letting overlapping chunks consume the result budget", () => {
    const first = hit("first");
    const overlap = hit("overlap", 1);
    const other = { ...hit("other", 30), chapterPath: "other.xhtml" };
    expect(fuseHits([[first, overlap, other], [other, first]], 2).map(item => item.chunkId))
      .toEqual(["first", "other"]);
    const longChapter = Array.from({ length: 100 }, (_, index) => hit(String(index), index * 20));
    const page = chapterPage(longChapter, 0, "80");
    expect(page.offset).toBe(78);
    expect(page.hits.map(item => item.chunkId)).toContain("80");
    expect(page.nextOffset).toBe(86);
  });
});
