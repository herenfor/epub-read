import { describe, expect, it } from "vitest";
import { ChatStreamDecoder } from "./transport";
import { answerWithBooks } from "./conversation";
import { chapterPage, fuseHits, type ReadingLibrary } from "./retrieval";
import { rankLexicalHits } from "./retrieval/ranking";
import { resolveRequestPolicy } from "./requestPolicy";
import { DEFAULT_CHAT_SETTINGS } from "./storage";
import { companionDiagnostics, createDiagnosticRecorder } from "./diagnostics";
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
    books: [], canRead: (hash, spine) => hash === "a".repeat(64) && spine <= 1, chapters: () => [{ chapterPath: "c1.xhtml", title: "第一章", spineIndex: 1 }],
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
  it("low thinking sends explicit provider parameters and preserves actual tool-round reasoning", async () => {
    const policy = resolveRequestPolicy(DEFAULT_CHAT_SETTINGS);
    expect(policy.parameters).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low", max_tokens: 8192 });
    const off = resolveRequestPolicy({ ...DEFAULT_CHAT_SETTINGS, thinkingEnabled: false });
    expect(off.parameters).toMatchObject({ thinking: { type: "disabled" }, max_tokens: 4096 });
    expect(off.parameters).not.toHaveProperty("reasoning_effort");
    const uncited = { ...hit("uncited", 80), originalText: "这段经历也返回了，但没有被回答引用。" };
    const decoder = new ChatStreamDecoder(() => {});
    decoder.push(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {
      reasoning_content: "private-reasoning-marker", tool_calls: [{ index: 0, id: "search_library", function: {
        name: "search_library", arguments: JSON.stringify({ queries: ["甲"] }) } }],
    }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`));
    const call = decoder.end();
    const f = fixture([call, { role: "assistant", content: "有原文。[E1]", reasoning_content: "private-final-marker" }], [hit("one"), uncited]);
    const result = await answerWithBooks({ ...f, question: "请查证经历", grounded: false,
      history: [{ id: "old", question: "旧问题", answer: "旧回答", evidence: [], createdAt: 1 }], memories: "",
      signal: new AbortController().signal, onUpdate: () => {} });
    expect(f.messages[0].every(message => message.role !== "assistant")).toBe(true);
    expect(f.messages[0].some(message => message.content?.includes("旧回答"))).toBe(true);
    expect(f.messages[1].find(message => message.tool_calls)?.reasoning_content).toBe("private-reasoning-marker");
    expect(result.evidence).toHaveLength(1);
    const snapshot = companionDiagnostics.snapshot();
    const inspection = snapshot.turns[snapshot.turns.length - 1];
    expect(inspection.requests[1].suppliedEvidenceIds).toEqual(["E1", "E2"]);
    expect(inspection.evidence.map(source => source.originalText)).toContain(uncited.originalText);
    expect(inspection.evidence[1]).toMatchObject({ chunkId: "uncited", textAnchor: { start: 80, end: 95 } });
    expect(inspection.tools[0]).toMatchObject({ name: "search_library", arguments: { queries: ["甲"] } });
    expect(inspection.requests[0].reasoningReceived).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private-reasoning-marker");
    expect(JSON.stringify(snapshot)).not.toContain("private-final-marker");
  });

  it("diagnostic snapshots whitelist request metadata and distinguish old cited-only history", () => {
    const recorder = createDiagnosticRecorder();
    const policy = resolveRequestPolicy(DEFAULT_CHAT_SETTINGS);
    const inspection = recorder.begin("核对原文", fixture([]).library.context,
      { ...policy.info, apiKey: "secret-key-marker" } as typeof policy.info);
    inspection.request([], []);
    inspection.tool(tool("search_library", { queries: ["甲"], authorization: "secret-header-marker" }).tool_calls![0], { evidence: [] });
    recorder.history(fixture([]).library.context, [{ id: "old", question: "旧问题", answer: "旧回答", evidence: [], createdAt: 1 }]);
    const snapshot = recorder.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("secret-key-marker");
    expect(JSON.stringify(snapshot)).not.toContain("secret-header-marker");
    expect(snapshot.history).toEqual([expect.objectContaining({ coverage: expect.stringContaining("uncited tool results were not retained") })]);
  });

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

  it("automatic mode follows selected tools and reuses verified original evidence on follow-up", async () => {
    const f = fixture([
      tool("search_library", { queries: ["甲", "离开"] }),
      tool("read_chapter", { bookHash: "a".repeat(64), chapterPath: "c1.xhtml", offset: 0, aroundEvidenceId: "E1" }),
      { role: "assistant", content: "原文说明甲当时并不知情。[E1]" },
    ]);
    const result = await answerWithBooks({ ...f, question: "甲为什么没有去？", grounded: false, history: [], memories: "",
      signal: new AbortController().signal, onUpdate: () => {} });
    expect(result.trace.map(step => step.tool)).toEqual(["search_library", "read_chapter"]);
    expect(result.evidence[0].text).toBe(hit("one").originalText);
    const followup = fixture([{ role: "assistant", content: "是的，原文说的是当时不知道。[E1]" }]);
    const second = await answerWithBooks({ ...followup, question: "所以不是故意拒绝？", grounded: false,
      history: [{ id: "previous", question: "甲为什么没有去？", ...result, createdAt: 1 }], memories: "",
      signal: new AbortController().signal, onUpdate: () => {} });
    expect(second.trace).toEqual([]);
    expect(second.evidence[0].hit.chunkId).toBe("one");
    expect(followup.messages[0].some(message => message.content?.includes(hit("one").originalText))).toBe(true);
  });

  it("automatic mode can discuss a supplied passage without forcing tools or citations", async () => {
    const f = fixture([{ role: "assistant", content: "这段给人的感觉是犹豫和遗憾。" }]);
    const result = await answerWithBooks({ ...f, question: "为什么我觉得这段很难过？我贴给你看：……", grounded: false,
      history: [], memories: "", signal: new AbortController().signal, onUpdate: () => {} });
    expect(result.answer).toContain("犹豫和遗憾");
    expect(result.trace).toEqual([]);
    expect(f.messages).toHaveLength(1);
  });

  it("does not publish a guessed book fact when the actual retrieval is empty", async () => {
    const f = fixture([tool("search_library", { queries: ["甲"] }), { role: "assistant", content: "甲一定知道。" }], []);
    const result = await answerWithBooks({ ...f, question: "甲知道吗？", grounded: true, history: [], memories: "",
      signal: new AbortController().signal, onUpdate: () => {} });
    expect(result.answer).toContain("未取得足够的原文依据");
    expect(result.answer).not.toContain("一定知道");
    expect(result.evidence).toEqual([]);
  });

  it("compound queries keep the right passage and fusion preserves diverse original anchors", () => {
    const exact = { ...hit("both"), normalizedText: "甲决定离开，因为归期已到。" };
    const nameOnly = { ...hit("name"), normalizedText: "甲留下照顾花园。" };
    const actionOnly = { ...hit("action"), normalizedText: "乙决定离开小镇。" };
    expect(rankLexicalHits([nameOnly, actionOnly, exact], "甲 离开").map(item => item.chunkId)).toEqual(["both"]);
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
