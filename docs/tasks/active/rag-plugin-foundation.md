# RAG 可选能力模块预备阶段

- 状态：已完成；代码、自动化和 Windows Tauri 实机验收均通过。不含真实模型、FTS、向量或生成。
- 所属分支：同一 EPUB Reader 仓库内的可选 AI/RAG 功能分支，不是独立项目或公开插件市场。
- 总路线：[`../../SEARCH_TO_RAG_ROADMAP.md`](../../SEARCH_TO_RAG_ROADMAP.md)
- 架构契约：[`../../AI_PLUGIN_ARCHITECTURE.md`](../../AI_PLUGIN_ARCHITECTURE.md)

## 本阶段目标

建立可启停、可替换、可清理的内部能力模块，让 mock Provider 可以走通注册、任务、语料切块、持久化和引用跳转；关闭模块后阅读、书架和当前书基础搜索保持不变。

## 实施顺序

1. [x] 建立 capability、Provider manifest、错误、取消和异步释放接口。
2. [x] 定义版本化语料、chunk、文本锚点和后台任务类型；检索结果/引用长期持久化 schema 随 FTS 阶段固化。
3. [x] 抽离当前搜索可复用的正文提取/标准化层，并保持 B-059/C-48 行为回归。
4. [x] 实现确定性结构化切块和稳定原文锚点。
5. [x] 建立 Rust SQLite/cache、schema v1、失效和清理边界。
6. [x] 建立有界进度、状态转换、取消和退出回收骨架；真实调度执行器后续实现。
7. [x] 使用 mock Provider 接通仅开发构建可见的能力检查入口；真实引用结果跳转随 FTS 阶段接线。
8. [x] 完成契约、生命周期、故障隔离和文档自动化验证。

## 明确不属于本阶段

- 真实模型下载、Embedding 计算和向量检索。
- Ollama、OpenAI-compatible 或其他厂商 API 实装。
- RAG 聊天、标签、智能书架、章节摘要和全书总结。
- 第三方 DLL/JS 动态插件加载。
- 将正文、索引、向量或模型写入阅读存档。

## 风险门

- 抽离语料层不得改变当前书搜索结果、标准化高亮或文本锚点。
- AI 状态不得继续集中进 `App.tsx`。
- SQLite/任务接口确定前不得绑定具体向量扩展或模型格式。
- 任何远程 Provider 都必须在后续实现时增加显式隐私提示和最小发送范围。

## 验收清单

- [x] AI禁用时零模型加载、零网络请求、零后台建库，且不创建 SQLite。
- [x] mock Provider 可注册、查询 capability、取消并释放。
- [x] 相同 EPUB 和版本产生相同 `chunkId`。
- [x] chunk 保存 paginator-compatible 文本锚点；真实检索 UI 跳转留到 FTS 阶段。
- [x] 删除/变更书籍精确清理或失效派生数据。
- [x] Provider、任务或数据库失败不影响阅读和普通搜索。
- [x] Windows Tauri 开发面板与自动验证通过；用户于 2026-08-23 确认本阶段验收通过。SQLite schema/清理由 Windows Rust 28/28 覆盖，开发面板保持不主动建库。

## 已实现文件

- `src/core/corpus.ts`、`src/core/chunking.ts`：共享语料、内容类型、版本化稳定切块和文本锚点。
- `src/features/ai/contracts`、`registry`、`lifecycle`：能力接口、注册表、mock 和惰性 runtime。
- `src/features/ai/ui/AiFoundationPanel.tsx`：仅开发构建可见的能力检查面板。
- `src-tauri/src/ai`：SQLite schema v1、清理边界和任务状态机。
- `src-tauri/src/linked_library.rs`：删除记录前清理已存在的单书 AI 派生数据。

## 自动化结果

- Vitest：58 files / 443 tests。
- TypeScript：`tsc --noEmit` 通过。
- Vite production build：120 modules。
- Rust：`cargo fmt --all -- --check`、`cargo check --locked`、28/28 tests 通过。
