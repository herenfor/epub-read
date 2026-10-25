import type { ReaderToolDefinition } from "./contracts";

const string = { type: "string", minLength: 1 };
const limit = { type: "integer", minimum: 1, maximum: 40 };
const cursor = { type: "string", minLength: 1 };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const integer = { type: "integer", minimum: 0 };
const book = schema({ bookId: string, contentHash: string, title: { type: "string" }, creator: { type: "string" },
  available: { type: "boolean" }, favorite: { type: "boolean" }, folderId: { type: ["string", "null"] } },
  ["bookId", "title", "creator", "available", "favorite", "folderId"]);
const chapter = schema({ chapterId: string, title: { type: "string" }, spineIndex: integer }, ["chapterId", "title", "spineIndex"]);
const passage = schema({ bookId: string, contentHash: string, chapterId: string, spineIndex: integer, chunkId: string,
  corpusVersion: string, originalText: { type: "string" }, anchor: schema({ start: integer, end: integer, snippet: { type: "string" } }, ["start", "end", "snippet"]) },
  ["bookId", "contentHash", "chapterId", "spineIndex", "chunkId", "corpusVersion", "originalText", "anchor"]);
const page = (items: Record<string, unknown>) => schema({ items: { type: "array", items }, nextCursor: { type: ["string", "null"] }, offset: integer }, ["items", "nextCursor", "offset"]);
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, outputSchema: Record<string, unknown>, readOnly = true): ReaderToolDefinition =>
  ({ name, description, inputSchema, outputSchema, readOnly });

const jobProperties = { taskId: { type: ["string", "null"] }, state: { type: "string", enum: ["queued", "running", "completed", "cancelled", "failed"] }, progress: { type: "number", minimum: 0, maximum: 1 } };
const searchCoverage = schema({ scopeBooks: integer, indexedBooks: integer, missingIndexBooks: integer,
  outdatedIndexBooks: integer, unavailableBooks: integer, complete: { type: "boolean" } },
  ["scopeBooks", "indexedBooks", "missingIndexBooks", "outdatedIndexBooks", "unavailableBooks", "complete"]);
const searchHit = schema({ bookId: string, contentHash: string, title: { type: "string" }, creator: { type: "string" },
  chapterId: string, chapterTitle: { type: "string" }, spineIndex: integer, chunkId: string, corpusVersion: string,
  excerpt: { type: "string" }, excerptTruncated: { type: "boolean" },
  anchor: schema({ start: integer, end: integer, snippet: { type: "string" } }, ["start", "end", "snippet"]) },
  ["bookId", "contentHash", "title", "creator", "chapterId", "spineIndex", "chunkId", "corpusVersion", "excerpt", "excerptTruncated", "anchor"]);

export const READER_TOOL_CATALOG: readonly ReaderToolDefinition[] = [
  tool("reader_search_library", "在授权书架的已有正文索引中检索，优先用本工具定位相关片段，再用read_passages的aroundChunkId读周边。queries为替代线索，各条内空格分词要求同段出现。默认8项，仅返回短预览；coverage明确未建/过期/不可用的范围，不自动全库建索引。无结果且覆盖不全不代表全库无答案。",
    schema({ queries: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", minLength: 1, maxLength: 256 } },
      bookIds: { type: "array", maxItems: 100, items: string },
      limit: { type: "integer", minimum: 1, maximum: 20 } }, ["queries"]),
    schema({ items: { type: "array", items: searchHit }, queries: { type: "array", items: string }, coverage: searchCoverage,
      truncated: { type: "boolean" }, candidateLimitReached: { type: "boolean" },
      retrieval: { type: "string", enum: ["indexed-lexical-rrf"] } },
    ["items", "queries", "coverage", "truncated", "candidateLimitReached", "retrieval"])),
  tool("reader_get_index_status", "查看授权书库或指定书籍的持久正文索引覆盖情况及本机准备任务；不读取全书、不启动建库。current仅表示当前语料版本的索引已提交，不表示模型理解正确。",
    schema({ bookId: string, limit, cursor }), page(schema({ bookId: string, state: { type: "string", enum: ["current", "missing", "outdated", "unavailable"] }, chunkCount: integer,
      job: schema(jobProperties, ["taskId", "state", "progress"]) }, ["bookId", "state", "chunkCount"]))),
  tool("reader_prepare_index", "显式为一本书准备持久正文索引，返回后台任务；同版本已就绪或同书任务复用。需要独立索引准备授权，不改变阅读进度。用get_index_status查询，cancel_index取消。",
    schema({ bookId: string }, ["bookId"]), schema({ ...jobProperties, bookId: string, reused: { type: "boolean" } }, ["taskId", "state", "progress", "bookId", "reused"]), false),
  tool("reader_cancel_index", "取消此阅读工具提供方为指定书籍创建的准备任务；等待暂存及原书释放后返回。不取消用户界面或其他提供方的任务。需要索引准备授权。",
    schema({ bookId: string, taskId: string }, ["bookId", "taskId"]), schema({ ...jobProperties, bookId: string }, ["taskId", "state", "progress", "bookId"]), false),
  tool("reader_find_books", "分页查询已导入书籍；query匹配书名/作者，支持文件夹和收藏筛选。返回bookId，后续调用请使用此ID。无需打开书籍。",
    schema({ query: { type: "string", maxLength: 256 }, folderId: { type: ["string", "null"] }, favorite: { type: "boolean" }, limit, cursor }), page(book)),
  tool("reader_get_book", "取得指定书籍元信息与源文件可用状态；不打开阅读页面，不改变阅读进度。",
    schema({ bookId: string }, ["bookId"]), book),
  tool("reader_list_chapters", "分页取得指定书籍的阅读流目录，chapterId可直接用于读取。目录不是正文；不要求此书正在阅读。",
    schema({ bookId: string, limit, cursor }, ["bookId"]), page(chapter)),
  tool("reader_read_passages", "按需分段读指定章节原文，默认8块、最多16块。建议先搜索定位，再用aroundChunkId读命中周边；证据不足时再扩读，避免默认逐章通读。cursor继续读取，返回实际范围/来源和下一游标；empty仅表示没有可提取文字。响应预算由调用适配层另行设置。",
    schema({ bookId: string, chapterId: string, aroundChunkId: string, cursor, limit: { type: "integer", minimum: 1, maximum: 16 } }, ["bookId", "chapterId"]),
    schema({ ...(page(passage) as { properties: Record<string, unknown> }).properties,
      contentState: { type: "string", enum: ["content", "empty"] }, totalChunks: integer, wholeChapter: { type: "boolean" } },
    ["items", "nextCursor", "offset", "contentState", "totalChunks", "wholeChapter"])),
  tool("reader_search_text", "在指定书籍做词面全文检索；空格分隔的词要求同段出现。返回相关性最高的有限原文和chunkId，可用read_passages展开。按章提取，无需先人工建索引；不等同于语义理解或全部命中列表。",
    schema({ bookId: string, query: { type: "string", minLength: 1, maxLength: 256 }, limit }, ["bookId", "query"]),
    schema({ items: { type: "array", items: passage }, truncated: { type: "boolean" }, scannedChapters: integer,
      query: string, retrieval: { type: "string", enum: ["lexical-chapter-extraction"] }, scope: schema({ bookId: string }, ["bookId"]) },
    ["items", "truncated", "scannedChapters", "query", "retrieval", "scope"])),
];
