import { READER_TOOL_CATALOG } from "./catalog";
import { ReaderToolError, type ReaderToolBackend, type ReaderToolReply, type ReaderToolRequest, type ReaderToolGrant } from "./contracts";

function validate(args: Record<string, unknown>, definition: (typeof READER_TOOL_CATALOG)[number]) {
  const schema = definition.inputSchema as { properties: Record<string, { type: string | string[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number }>; required: string[] };
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ReaderToolError("INVALID_ARGUMENTS", "arguments必须为对象");
  for (const key of schema.required) if (!Object.hasOwn(args, key)) throw new ReaderToolError("INVALID_ARGUMENTS", `缺少${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw new ReaderToolError("INVALID_ARGUMENTS", `未知参数${key}`);
    const type = value === null ? "null" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    if (!(Array.isArray(rule.type) ? rule.type : [rule.type]).includes(type)
      || typeof value === "number" && (!Number.isSafeInteger(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))
      || typeof value === "string" && (Array.from(value).length < (rule.minLength ?? 0) || Array.from(value).length > (rule.maxLength ?? Infinity))) {
      throw new ReaderToolError("INVALID_ARGUMENTS", `${key}不符合工具参数格式`);
    }
  }
  if (args.cursor && args.aroundChunkId) throw new ReaderToolError("INVALID_ARGUMENTS", "cursor和aroundChunkId请选择一种");
}
const encode = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
function offsetFor(cursor: unknown, binding: string): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(cursor as string), char => char.charCodeAt(0))));
    if (value.binding !== binding || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error();
    return value.offset;
  } catch { throw new ReaderToolError("CURSOR_EXPIRED", "游标与当前查询或原文版本不一致，请重新查询"); }
}
function page<T>(items: T[], args: Record<string, unknown>, binding: string, defaultLimit = 20) {
  const offset = offsetFor(args.cursor, binding);
  const limit = (args.limit as number | undefined) ?? defaultLimit;
  if (offset > items.length) throw new ReaderToolError("CURSOR_EXPIRED", "数据范围已变化，请重新查询");
  const selected = items.slice(offset, offset + limit);
  return { items: selected, nextCursor: offset + selected.length < items.length ? encode({ binding, offset: offset + selected.length }) : null, offset };
}

export function createReaderToolService(source: ReaderToolBackend, grant?: ReaderToolGrant) {
  const backend: ReaderToolBackend = { ...source, async list(signal) {
    const books = await source.list(signal);
    return grant?.bookIds ? books.filter(book => grant.bookIds!.includes(book.bookId)) : books;
  } };
  const extensions: Record<string, unknown> = { reader_get_index_status: backend.indexStatus,
    reader_prepare_index: backend.prepareIndex, reader_cancel_index: backend.cancelIndex };
  const definitions = READER_TOOL_CATALOG.filter(tool => !(tool.name in extensions) || Boolean(extensions[tool.name]));
  const bind = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(value))))).map(byte => byte.toString(16).padStart(2, "0")).join("");
  async function bookFor(id: string, signal: AbortSignal) {
    const book = (await backend.list(signal)).find(book => book.bookId === id);
    if (!book) throw new ReaderToolError("BOOK_NOT_FOUND", "书架中没有此bookId，请重新查书");
    return book;
  }
  return {
    definitions,
    async call(request: ReaderToolRequest, signal: AbortSignal): Promise<ReaderToolReply> {
      const header = { apiVersion: "1" as const, requestId: request.requestId };
      try {
        signal.throwIfAborted();
        const definition = definitions.find(tool => tool.name === request.name);
        if (!definition) throw new ReaderToolError("TOOL_NOT_SUPPORTED", "此版本未提供该工具");
        if (!definition.readOnly && grant && (!grant.prepareIndex || !["reader_prepare_index", "reader_cancel_index"].includes(request.name))) throw new ReaderToolError("ACCESS_DENIED", "此客户端未获索引准备权限");
        const args = request.arguments;
        validate(args, definition);
        let data: unknown;
        if (request.name === "reader_get_index_status") {
          const books = args.bookId ? [await bookFor(args.bookId as string, signal)] : await backend.list(signal);
          const statuses = (await backend.indexStatus!(books, signal)).sort((a, b) => a.bookId.localeCompare(b.bookId));
          data = page(statuses, args, await bind([request.name, args.bookId, statuses.map(status => [status.bookId, status.state, status.chunkCount])]));
        } else if (request.name === "reader_find_books") {
          const query = String(args.query ?? "").trim().toLocaleLowerCase();
          const books = (await backend.list(signal)).filter(book => `${book.title} ${book.creator}`.toLocaleLowerCase().includes(query)
            && (args.folderId === undefined || book.folderId === args.folderId) && (args.favorite === undefined || book.favorite === args.favorite))
            .sort((a, b) => a.bookId.localeCompare(b.bookId));
          data = page(books, args, await bind([request.name, query, args.folderId, args.favorite, books]));
        } else {
          const book = await bookFor(args.bookId as string, signal);
          if (request.name === "reader_get_book") data = book;
          else if (request.name === "reader_cancel_index") data = await backend.cancelIndex!(book.bookId, args.taskId as string, signal);
          else {
            if (!book.available) throw new ReaderToolError("SOURCE_UNAVAILABLE", "原书来源当前不可用，请在书架重新关联来源");
            if (request.name === "reader_prepare_index") data = await backend.prepareIndex!(book.bookId, signal);
            else if (request.name === "reader_list_chapters") {
              const chapters = await backend.chapters(book.bookId, signal);
              data = page(chapters, args, await bind([request.name, book.bookId, book.contentHash, chapters]));
            } else if (request.name === "reader_search_text") {
              const query = (args.query as string).trim();
              if (!query || query.split(/\s+/u).length > 8) throw new ReaderToolError("INVALID_ARGUMENTS", "请提供最多8个短检索词");
              data = { ...await backend.search(book.bookId, query, args.limit as number ?? 12, signal),
                query, retrieval: "lexical-chapter-extraction", scope: { bookId: book.bookId } };
            } else {
              const chunks = await backend.read(book.bookId, args.chapterId as string, signal);
              const binding = await bind([request.name, book.bookId, args.chapterId, book.contentHash, chunks.map(chunk => chunk.chunkId), chunks[0]?.corpusVersion]);
              let pageArgs = args;
              if (args.aroundChunkId) {
                const index = chunks.findIndex(chunk => chunk.chunkId === args.aroundChunkId);
                if (index < 0) throw new ReaderToolError("SOURCE_CHANGED", "命中段落已失效，请重新检索");
                pageArgs = { ...args, cursor: encode({ binding, offset: Math.max(0, index - 2) }) };
              }
              const result = page(chunks, pageArgs, binding, 8);
              data = { ...result, contentState: chunks.length ? "content" : "empty", totalChunks: chunks.length,
                wholeChapter: result.offset === 0 && result.nextCursor === null };
            }
          }
        }
        signal.throwIfAborted();
        return { ...header, ok: true, data };
      } catch (error) {
        const failure = signal.aborted ? new ReaderToolError("CANCELLED", "调用已取消") : error instanceof ReaderToolError
          ? error : new ReaderToolError("READER_UNAVAILABLE", "阅读能力暂时不可用，请检查书库和源文件", true);
        return { ...header, ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable } };
      }
    },
  };
}
