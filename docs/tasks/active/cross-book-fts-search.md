# 任务：SQLite FTS5 跨书全文检索

- 状态：待 Windows Tauri 实机审核
- 创建日期：2026-08-23
- 最后更新：2026-08-24
- 对应能力：C-54

## 目标

在不依赖任何 AI 模型的情况下，将共享结构化语料和稳定 chunk 持久化到独立 AI SQLite 缓存，并支持从整个本地书库检索正文、过滤结果、打开对应书籍并通过既有文本锚点跳回原文。

## 非目标

- 不实现 Embedding、向量数据库、语义搜索、Rerank、标签或生成式问答。
- 不下载模型，不连接 OpenAI、Ollama 或其他厂商服务。
- 不把正文索引、任务或模型信息写入 portable archive。
- 不在 AI/跨书搜索未启用时自动创建数据库或后台扫描全库。
- 不改变当前书会话级搜索的结果、高亮和跳转语义。

## 当前现象与证据

- C-53 已提供共享语料、稳定 chunk、独立 `ai.sqlite3` schema v1、任务状态机和开发面板。
- Windows PowerShell 7 自动验证通过前端、生产构建、Rust 28/28 和生产可见性门；用户已完成人工检查并确认 C-53 阶段通过。
- 当前 `chunks` 表只具备地基 schema，没有真实写入 API、FTS 表、跨书查询和结果 UI。

## 已确认根因

不是缺陷修复。跨书搜索尚未实现，因为 C-53 有意只建立数据与生命周期边界，没有接入真实索引执行器。

## 必须保持的行为

- 阅读器核心、当前书搜索和书架不能依赖 AI SQLite 才能工作。
- 数据库只在用户显式启用跨书索引或调用相关功能后惰性创建。
- 索引以 EPUB `contentHash` 为书籍身份；相同内容与版本不得重复建库。
- 索引可删除、可重建；删除索引不得删除 EPUB、书架记录、笔记、书签或进度。
- 结果必须携带 `contentHash`、章节、chunk、原文片段和 paginator-compatible 文本锚点。
- 搜索预览不写阅读进度；用户点击结果后才走既有打开书籍、历史和跳转链路。
- 建库和查询必须有界、可取消，并服从阅读优先级。

## 实施顺序

1. SQLite schema v2：书籍检索元数据、FTS5 表、迁移、清理和索引状态。
2. Rust 存储契约：单书事务替换、无变化跳过、跨书查询、短查询回退和过滤。
3. Tauri 命令与 TypeScript bridge：版本化输入校验、批量边界、错误与取消。
4. 真实建库执行器：从链接 EPUB 提取共享语料、切块并分批提交；接入现有任务状态机。
5. UI：现有搜索面板增加“当前书 / 全部书籍”，显示书名/作者/章节并接入跨书打开和稳定锚点跳转。
6. 数据管理：索引状态、占用空间、重建当前书和清除全部索引。

## 预计修改文件

- `src-tauri/src/ai/store.rs`、`src-tauri/src/ai/mod.rs`：schema、索引写入、查询、状态和命令。
- `src-tauri/src/lib.rs`：注册新增命令。
- `src/features/ai/indexing/*`：前端 bridge、任务控制器和数据契约。
- `src/core/corpus.ts`、`src/core/chunking.ts`：只在持久化输入需要时扩展元数据，不改变当前书搜索。
- `src/ui/SearchPanel.tsx`、`src/App.tsx`：搜索范围和跨书结果跳转。
- 项目维护文档：记录阶段状态、验证和同步边界。

## 实际修改

- 已建立本任务文档并将 C-53 Windows 实机验收标记为完成。
- SQLite schema 升至 v3：v2 的书籍检索元数据/trigram `chunk_fts` 保持；v3 新增隔离 staging 表，v1 既有 chunk 会经迁移写入 FTS。
- Rust 已提供单书原子替换索引、长查询 FTS5、1～2 字 `instr` 有界回退、按 contentHash/contentType 过滤、单书/全库 FTS 清理。
- Tauri 已注册 `ai_index_replace`、`ai_search`；前端 `indexStore` 统一映射 `DocumentChunk`、版本、JSON 文本锚点并隔离 invoke。
- 已接入逐本/逐章真实 EPUB 建库、chunk/字符双门控批次、阅读优先 yield、取消/失败 abort、版本跳过和失败继续。
- 阅读器搜索面板已加入“当前书 / 全部书籍”；全部书籍会显式启用建库，完成后查询并显示书名/作者/章节，点击命中可打开目标书并以精确文本锚点定位。
- 已提供重新建立和只清理全文索引；清理不会删除 Provider 配置、EPUB、书架、笔记、书签或进度。浏览器预览明确降级为仅桌面版支持。
- B-072 修复 Windows 首次实机建库的空语言兼容：旧书架记录用空字符串表示未知语言，前端现在在 staging 前省略该字段，Rust 边界也将空白语言规范化为 `NULL`；若本轮全部书籍均失败，界面不再进入伪 `ready` 状态，而是显示首个真实错误。
- B-073 修复图片封面/纯布局章节生成空正文块：语料层现在丢弃规范化后为空的结构块，图片-only 章节保留为空 batch 并继续后续正文；解析版本升至 `visible-xhtml-v2`，确保已有派生索引自动重建。
- B-074/C-55 将全库建库改为用户确认后启动：切换“全部书籍”只探测已有状态，不读取 EPUB；进度卡的取消按钮固定，取消会等待当前书读取/解析与 staging 回收结束。
- 已接入持久任务与异常退出恢复：每本书提交后保留，半本 staging 启动回收，下次仅补缺失/版本过期书；部分索引可直接搜索且只返回当前语料版本。
- 已建立可扩展派生缓存类别和原生 status/clear 命令；当前只登记 `full-text-index`，暂不在书架暴露缓存清理 UI。

## 验收标准

- [x] schema v1/v2 可升级到 v3并保留/建立 FTS；重复打开幂等，遗留 staging 在启动时回收。
- [x] 单书索引事务失败不留下半本数据；相同 hash/版本跳过仍待执行器接入。
- [x] 三字及以上正文查询使用 FTS5；一至二字查询走最多 200 条的有界短查询路径。
- [x] 存储查询契约支持 contentHash、书名、作者、章节路径和内容类型过滤；首版 UI 暂只暴露当前书/全部书籍范围。
- [x] 跨书结果包含原文高亮范围和精确稳定锚点，点击后可打开并跳转。
- [x] 建库可取消、失败可重试、退出时回收，逐章/批 yield 保持阅读优先。
- [x] 清理/重建全文索引不影响 Provider 配置、用户数据或源 EPUB。
- [x] 跨书索引未显式选择时零模型、零网络、零建库。
- [ ] Windows WebView2 实机验证通过。

## 本地验证

| 命令/操作 | 结果 | 日期 |
|---|---|---|
| C-53 Windows 自动验证与人工面板检查 | 通过；用户确认当前阶段验证通过 | 2026-08-23 |
| `cargo test --locked` | 36/36 通过，含 v1/v2→v3、staging 原子性/边界/回收、FTS 长短查询、过滤和定向清理 | 2026-08-23 |
| `pnpm test` | 63 files / 463 tests 通过 | 2026-08-23 |
| `tsc --noEmit`、`pnpm build` | 通过；Vite 126 modules | 2026-08-23 |
| `cargo fmt --all -- --check`、`cargo check --locked` | 通过 | 2026-08-23 |
| B-072 空语言修复：`pnpm test`、`pnpm build`、`cargo test --locked`、Rust fmt check | 63 files / 465 tests、Vite 126 modules、Rust 37/37，全部通过 | 2026-08-24 |
| B-073 空正文修复：真实 EPUB 批量语料回放、`pnpm test`、`pnpm build`、`cargo test --locked`、Rust fmt check | Windows 测试目录 37 本/3094 chunks 无非法正文；63 files / 467 tests、Vite 126 modules、Rust 37/37，全部通过 | 2026-08-24 |
| B-074/C-55 确认、取消、恢复与缓存边界 | 66 files / 485 tests、TypeScript、Vite production build、Rust fmt 与 38/38 tests，全部通过 | 2026-08-24 |

## 不应同步的本地文件

- Windows/WSL app-data 下的 `ai.sqlite3`、构建产物、测试书、临时脚本和截图。

## 待完成与风险

- FTS5 trigram 在中文、日文、拉丁文本及一至二字查询上的召回和索引体积需要真实书库测量。
- 单本 EPUB 仍沿用现有 `loadBook(Uint8Array)` 解析边界，但书库按单本顺序释放；正文通过 staging 有界 IPC，不会一次发送整库或整本正文。超大 EPUB 的现有整书解析成本不属于本阶段新引入问题，仍需 Windows 真实大书测量。
- 跨书打开会重建阅读会话，因此现有三步 back/forward 只覆盖目标书内后续跳转；当前不会伪装成可跨书返回来源书。若需要跨书撤销，必须单独扩展历史位置的 `contentHash/shelfId` 和异步 reopen 协议。
- Windows 首次实机暴露的空索引与第二层空正文问题均已定位并修复；修复前实际 `ai.sqlite3` 为 schema v3 但 `books=0/chunks=0/chunk_fts=0`，本机旧书架记录 `language=""`，且图片封面章节会产生空白 chunk。仍需用新构建重新建库并验证实际 SQLite 写入、中文/日文召回、耗时、取消、重启 staging 回收、重新定位和锚点落点。

## 交接说明

继续时先读本文件、`AI_PLUGIN_ARCHITECTURE.md`、`SEARCH_TO_RAG_ROADMAP.md`、`src-tauri/src/ai/store.rs`、`src/features/ai/indexing/` 和 `src/core/bookCorpusIndex.ts`。当前代码功能已接通，先完成 Windows Tauri 实机审核和必要修复；不得在验收前跳到模型/向量阶段。

## 源仓同步状态

- [x] 已更新 `docs/SOURCE_DELTA.md`
- [ ] 用户已审核
- [ ] 用户已同步到真实源仓
- 源仓提交：待用户填写
