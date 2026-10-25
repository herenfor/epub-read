import type { ReadingLibrary } from "./retrieval";
import { EvidenceRegistry, sourcePayload } from "./evidence";
import type { ChatPhase, ChatTool, InvestigationStep, ToolCall } from "./types";
import { readExchanges } from "./conversationStore";

export const READING_TOOLS: readonly ChatTool[] = [
  { type: "function", function: { name: "recall_conversation", description: "按原话关键词找这条持续对话的旧记录，最多8轮，含说话者、时间及当时书籍。用于核对旧讨论，不是书籍原文依据；未命中只代表关键词未匹配。返回片段带字符范围。",
    parameters: { type: "object", properties: { query: { type: "string", minLength: 2 } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "search_library", description: "在允许范围查原文。queries放不同短线索或同义说法，最多6条；同一条用空格分隔的词要求在同一段同时出现，可组合人名与动作缩小范围。关键词与书名不能代替原文依据。",
    parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" }, maxItems: 6 }, bookHash: { type: "string" } }, required: ["queries"], additionalProperties: false } } },
  { type: "function", function: { name: "read_chapter", description: "直接读取已知章节，或用aroundEvidenceId展开检索命中周边。offset从0或返回nextOffset继续，每次8块。返回本次起止范围与章节是否读尽；只读一部分不能称为通读。",
    parameters: { type: "object", properties: { bookHash: { type: "string" }, chapterPath: { type: "string" }, offset: { type: "integer", minimum: 0 }, aroundEvidenceId: { type: "string" } }, required: ["bookHash", "chapterPath", "offset"], additionalProperties: false } } },
  { type: "function", function: { name: "list_chapters", description: "当前书允许阅读的章节路径与标题。用于按章节直接阅读；目录不是正文。",
    parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "find_books", description: "按书名或作者查本机书库身份；返回目录信息，不代表已读过书。",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
];
/** Same tool contract for the direct loop and a future external harness adapter. */
export interface CompanionToolPort {
  readonly definitions: readonly ChatTool[];
  execute(call: ToolCall): Promise<unknown>;
}
export class ReadingToolSession implements CompanionToolPort {
  readonly definitions = READING_TOOLS;
  readonly trace: InvestigationStep[] = [];
  attemptedLookup = false;
  private supplied: Set<string>;
  constructor(private library: ReadingLibrary, readonly evidence: EvidenceRegistry, private signal: AbortSignal,
    private onPhase: (phase: ChatPhase) => void) { this.supplied = new Set(evidence.all().map(source => source.id)); }
  private payload(sources: ReturnType<EvidenceRegistry["all"]>) {
    return sources.map(source => {
      if (this.supplied.has(source.id)) return { id: source.id, reused: true, note: "原文已在本轮上下文中提供，沿用同一编号。" };
      this.supplied.add(source.id);
      return sourcePayload(source);
    });
  }
  async execute(call: ToolCall): Promise<unknown> {
    this.signal.throwIfAborted();
    const step: InvestigationStep = { tool: call.function.name, status: "running", resultCount: 0, elapsedMs: 0 };
    const start = performance.now();
    this.trace.push(step);
    try {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      if (call.function.name === "recall_conversation") {
        if (typeof args.query !== "string" || args.query.trim().length < 2) throw new Error("请提供至少两个字符的旧对话关键词");
        const query = args.query.trim(); this.onPhase("reading");
        const exchanges = await readExchanges({ query, limit: 8 });
        this.signal.throwIfAborted(); step.resultCount = exchanges.length;
        const excerpt = (text: string) => {
          const start = Math.max(0, text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 400);
          const end = Math.min(text.length, start + 1600);
          return { text: text.slice(start, end), start, end, totalCharacters: text.length };
        };
        return { exchanges: exchanges.map(exchange => ({ id: exchange.id, revision: exchange.revision ?? 1,
          createdAt: exchange.createdAt, context: exchange.context, interrupted: Boolean(exchange.interrupted),
          messages: [{ id: `${exchange.id}:user`, role: "user", ...excerpt(exchange.question) },
            ...(!exchange.interrupted ? [{ id: `${exchange.id}:assistant`, role: "assistant", ...excerpt(exchange.answer) }] : [])],
        })), note: "这是对话原话片段，不是原书证据；旧助手陈述仍可能有误。" };
      }
      if (call.function.name === "search_library") {
        this.attemptedLookup = true;
        if (!Array.isArray(args.queries) || !args.queries.every(value => typeof value === "string")) throw new Error("queries必须为短线索数组");
        step.queries = args.queries.slice(0, 6);
        this.onPhase("searching");
        const hits = await this.library.search(args.queries, typeof args.bookHash === "string" ? args.bookHash : undefined, this.signal);
        const sources = this.evidence.retain(hits); step.resultCount = sources.length;
        return { evidence: this.payload(sources), note: "跨书结果仅来自已建库且允许阅读的范围，未命中不代表全书库不存在；片段不代表完整章节，人物状态或因果不明确时可展开命中周边。" };
      }
      if (call.function.name === "read_chapter") {
        this.attemptedLookup = true;
        if (typeof args.bookHash !== "string" || typeof args.chapterPath !== "string" || typeof args.offset !== "number") throw new Error("缺少书籍、章节路径或原文块起点");
        step.chapterPath = args.chapterPath; this.onPhase("reading");
        const around = typeof args.aroundEvidenceId === "string" ? this.evidence.get(args.aroundEvidenceId) : undefined;
        if (args.aroundEvidenceId && (!around || around.bookHash !== args.bookHash || around.chapterPath !== args.chapterPath)) throw new Error("展开目标必须是已有的同章出处");
        const page = await this.library.read(args.bookHash, args.chapterPath, args.offset, this.signal, around?.hit.chunkId);
        const sources = this.evidence.retain(page.hits); step.resultCount = sources.length;
        step.offset = page.offset; step.nextOffset = page.nextOffset;
        return { evidence: this.payload(sources), offset: page.offset, nextOffset: page.nextOffset,
          wholeChapter: page.offset === 0 && page.nextOffset === null && sources.length > 0,
          note: sources.length ? "本次实际读取的原文范围；留意说话者、否定及先后。" : "该范围无原文，可能为空章、未建库或不在允许阅读范围。" };
      }
      if (call.function.name === "list_chapters") {
        const chapters = this.library.chapters(); step.resultCount = chapters.length;
        return { chapters, note: "目录信息，不是已读过的正文。" };
      }
      if (call.function.name === "find_books") {
        const query = typeof args.query === "string" ? args.query.toLocaleLowerCase() : "";
        const books = this.library.books.filter(book => `${book.title} ${book.creator}`.toLocaleLowerCase().includes(query)).slice(0, 40);
        step.resultCount = books.length;
        return { books, note: "书籍目录；跨书正文查阅需要先建库。" };
      }
      throw new Error("未知工具");
    } catch (error) {
      if (this.signal.aborted) step.status = "cancelled";
      this.signal.throwIfAborted();
      step.status = "error"; step.error = error instanceof Error ? error.message : String(error);
      return { error: step.error };
    } finally {
      step.elapsedMs = Math.round(performance.now() - start);
      if (step.status === "running") step.status = step.resultCount ? "ok" : "empty";
    }
  }
}
