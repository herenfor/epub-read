# AI/RAG 可选能力模块架构基线

## 定位

AI/RAG 功能属于当前 EPUB Reader 仓库和同一个 Tauri 应用，不拆成独立项目。这里的插件化用于隔离职责、快速替换 Provider 和按发行形态启停能力；第一阶段不开放第三方 DLL、JavaScript 或其他任意进程内代码。

当前已完成 C-53 地基；C-54 已接入 SQLite FTS5、分批 staging、真实逐书建库、跨书查询 UI和锚点跳转。C-56 进一步将书架与阅读器收敛到同一个全库运行时，并建立真实 Worker、可配置并发、单写入和阅读优先的通用语料流水线；`0.1.9-beta.2` Windows 基础全文搜索验收已通过。RAG C-57 模型资产代码及 Windows Tauri dev 核心链路已通过，扩展故障矩阵仍待发布版验收；模型运行时、向量存储和 RAG 问答 UI仍未实现。

路线阶段定位：基础全文搜索阶段已通过 `0.1.9-beta.2` Windows 验收；当前处于 RAG C-57 模型资产的 Windows 验收阶段。Provider 接口预留和模型资产可用性记录都不代表已存在真实模型运行时；C-58 才接入第一个 Embedding Provider。

进入 C-58 前增加 C-57.6 发行门禁补强与 C-58-Prep 运行时合同阶段。C-57.6 代码与本地矩阵已经完成，Windows双包仍待验收；C-58-Prep只用mock固化硬件探测结果、资源预留、Provider生命周期和可恢复索引manifest。两者都不得加载真实模型。

默认 Provider 策略已经修订：阅读器不把 Ollama 作为普通用户依赖，也不把第三方模型服务的数据目录和生命周期纳入默认路径。C-58 拆为硬件/后端探测与资源准入（C-58A）以及 GPU-first Builtin ONNX Embedding Provider（C-58B）；生成阶段优先采用项目构建、审计、固定版本的 GPU-first llama.cpp sidecar。Ollama/OpenAI-compatible 仅是后置高级 HTTP Provider。普通用户默认使用推荐模型并只选择“自动推荐 / GPU 兼容 / NVIDIA CUDA / CPU 兼容”；高级模型替换必须通过 C-57 manifest/linked 校验或未来受控能力插件，不能由模型包安装可执行代码。

## 三层边界

1. **阅读与基础搜索核心**：EPUB 解析、正文提取、标准化、原文锚点、高亮和跳转。它不依赖 AI 模块。
2. **智能检索模块**：持久化语料、SQLite FTS、Embedding、向量存储、混合检索、相似内容和建议标签。模块可以完全关闭。
3. **生成式 AI 模块**：Generator、带引用问答和分层总结。它依赖可靠检索，但智能检索不反向依赖生成模型。

## 建议代码边界

```text
src/features/ai/
  contracts/       capability、Provider、语料、检索和引用类型
  registry/        Provider 注册、选择、健康状态和能力解析
  lifecycle/       前端会话、取消、资源释放和状态投影
  indexing/        全库运行时、Worker 池、语料 sink、FTS adapter 与设备并发
  ui/              AI 设置、任务和问答界面

src-tauri/src/ai/
  commands.rs      最小 IPC 边界
  index_store.rs   SQLite schema、migration、事务和清理
  task_manager.rs  建库/推理任务、限流、取消和退出回收
  providers/       内置、sidecar 和 HTTP Provider 适配器
```

当前 TypeScript 已按 `src/features/ai` 落地 contracts/registry/lifecycle/indexing/models/ui，Rust 已按 `src-tauri/src/ai` 落地 store/task/models/download；禁止为了符合其余示意提前创建空文件，也禁止把 AI 状态继续堆入 `App.tsx`。

## Core / AI 编译边界（C-57.5）

- Core不是另一套项目：它从同一代码树构建，保留`core/indexing/cache`中的语料、任务、SQLite FTS和全文搜索能力。
- `VITE_EDITION=core`是默认生产前端；编译期常量必须让模型面板、模型adapter和Provider实现从Core产物图中消失，不能只用CSS或运行时隐藏。
- Rust Cargo默认feature为空；Core只激活`core`，不编译`models`/`download`，不注册模型资产IPC，也不启用其可选`reqwest/fs2`依赖；FTS/store/task命令保持存在。直接Cargo检查可额外使用`--no-default-features`，Tauri 2.11 wrapper只传其支持的`--features core`。
- AI开发版使用`VITE_EDITION=ai`及Cargo `ai` feature。该edition是能力开关，不是Provider capability；业务逻辑仍按manifest/capability判断。
- AI开发版当前使用独立identifier `dev.epubreader.ai`和独立app-data，避免实验数据库影响正式Core。未来稳定AI版是否迁回统一identifier必须单独设计数据迁移，不能直接改名覆盖。
- Core新数据库允许停在FTS schema v3；AI可以从Core数据库幂等升级模型资产schema。Core也必须能读取更高但已知的AI schema而不访问模型表，保证edition切换不损坏全文索引。
- 正式热修复以Core构建为准，修复完成后合并回AI开发线；禁止分别维护两份阅读器实现。

### C-57.6 发行门禁（代码与本地矩阵已完成）

- 默认路径必须统一为 Core：Vite/Cargo/Tauri任一侧未显式选择AI时都不能带入AI能力。
- Core/AI分别写入`dist/core`、`dist/ai`及独立Rust target，Tauri只能读取同edition目录；禁止共享通用`dist`。
- 官方wrapper从一个edition参数派生Vite、Cargo feature、Tauri overlay和输出目录；未知edition、互斥feature或metadata不一致直接失败。
- Rust提供两版共有且无副作用的`app_build_info`；桌面在挂载App前比较前端编译edition，mismatch时不得初始化FTS/AI runtime、数据库、模型目录或网络。
- AI面板CSS由lazy模块持有，开发探针只属于AI公共资源；Core产物门禁同时扫描JavaScript、CSS、fixture和模型IPC。
- `tsc`继续全量检查，不按edition排除源码。真正的紧急Core热修复从稳定Git线发布，再把相同提交回合并AI线。
- 本阶段不修改schema、app-data或Provider；详细实施基线见[`core-ai-release-hardening.md`](tasks/active/core-ai-release-hardening.md)。

## 能力和 Provider 契约

首期能力集合：

```text
embedding
generation
reranking
```

Provider manifest 至少记录：

- Provider ID、实现版本和 transport。
- capability 集合及各能力当前可用状态。
- 模型 ID、digest、格式、维度或上下文限制。
- 本地/远程属性和正文传输提示。
- 初始化、健康检查、请求取消、空闲释放和错误分类。

Embedding、Generator 和 Rerank 分别选择；切换 Generator 不得使向量索引失效。运行时依据 capability 判断功能，不能依据发行版名称或文件是否存在猜测。

Provider 注册表必须区分默认受支持实现与高级兼容实现；未显式配置的 Ollama/HTTP Provider 不得自动探测、联网或创建外部数据目录。项目维护的 sidecar/加速后端属于运行能力组件，必须独立于模型资产构建、审计和更新。

## 语料与引用契约

`DocumentChunk` 至少携带：

```text
bookFingerprint
chunkId
chapterPath
chapterTitle
spineIndex
contentType
originalText
normalizedText
textAnchor
parserVersion
normalizerVersion
chunkerVersion
```

- `chunkId` 必须由稳定输入确定性产生，不使用每次建库随机 ID。
- 切块优先遵守标题、段落和句子边界，并保留少量版本化重叠。
- 目录、版权页、脚注和正文应通过 `contentType` 区分，不在提取阶段永久丢失来源信息。
- `Citation` 必须保存书籍、章节、正文块和原文锚点；UI 点击引用复用现有阅读跳转历史。
- 当前 `SearchResult` 是上游兼容参考，不直接作为长期持久化 schema。

## 数据与生命周期

- 使用 `contentHash`/书籍指纹关联书库，但 AI 数据位于独立目录和数据库。
- 正文副本、FTS、向量、模型和临时任务属于可删除、可重建缓存，不进入 portable archive。
- 用户标签、用户确认的建议和用户编辑摘要属于可同步数据，需与缓存分表管理。
- 删除书籍、内容指纹变化、解析/标准化/切块版本变化必须精确失效对应派生数据。
- 数据库必须有 schema version 和 migration；损坏后允许重建，不能阻断书架启动。
- 后台任务必须支持取消、失败隔离和退出回收；阅读期间限制并发、CPU和内存。
- AI 模块关闭时不加载模型、不访问网络、不启动后台建库。
- 全库派生任务由一个应用级 runtime 和 Rust 持久任务互斥共同仲裁；书架/阅读器只是状态投影，关闭面板不能取消任务。Worker 只负责解析和有界批次生产，消费端通过 `CorpusSink` 串行提交；以后新增向量或标签 sink 不得复制 EPUB 解析器。
- 并发配置表示设备最大值，不是任务保证值；大书、阅读加载、内存保护与取消可以降级。该配置不进入 portable archive。

## UI 接入

- 通过现有 `ReaderForeground` 扩展 AI panel，保持菜单、目录、书签、搜索、笔记和 AI 界面互斥。
- `App.tsx` 只负责组合和路由；Provider、任务、问答和索引状态由独立 feature controller/store 管理。
- 真实能力可用前只提供开发入口，不在发布版展示不可用的空按钮。
- 远程 Provider 调用前展示发送范围和隐私影响；生成内容与原文证据必须明确区分。

## 预备阶段验收

- [x] mock Provider 可以注册、报告能力、取消和异步释放。
- [x] 相同输入和版本得到相同 chunk 与文本锚点。
- [x] 共享锚点与既有 paginator code-point 坐标保持一致；真实检索引用跳转将在 FTS 阶段接线。
- [x] 禁用 AI 后没有模型、网络、数据库建库任务和额外阅读路径依赖。
- [x] 删除书籍和清理全部 AI 数据能移除对应派生数据，不删除源 EPUB；无数据库时删除书籍不会创建数据库。
- [x] Provider、任务或数据库边界独立于阅读和普通搜索。

当前自动化基线：Vitest 83 files/537 tests、TypeScript、Core/AI Vite production build各150 modules及产物门禁；WSL Cargo Core 45/45、AI 83/83 tests与Rust fmt/check通过，Core active tree无`reqwest/fs2`，冲突/错误/缺失edition组合会按设计失败。Windows PowerShell 5.1语法解析通过。`0.1.9-beta.2`基础全文搜索Windows验收已完成；Core/AI双安装包以及RAG C-57的大文件断点续传、镜像切换、磁盘不足、应用重启恢复、长路径/reparse point和Defender文件占用恢复仍待Windows发布版验证。

当前已完成架构地基、SQLite FTS 跨书搜索和 RAG C-57 模型资产层。后续顺序为 Windows GPU/后端探测与资源准入、GPU-first Embedding Provider、可恢复向量索引、混合召回与评测，最后才接 GPU-first Generator 和带引用问答。CPU 只作为显式、限额兼容模式，不得由 GPU 故障静默触发。

## RAG C-57 模型资产层（已实现代码，待 Windows 验收）

C-57 在 Provider 运行层之前增加独立模型资产层。`ModelPackageManifest` 描述模型文件、格式、能力、digest、许可证、来源和设备提示；`ProviderManifest` 仍只描述 Provider 的实现、transport、capability 和生命周期。模型包不携带可执行代码，不会因为 `providerKind` 字段而创建或加载 Provider。现有 `builtin`、`sidecar`、`http`、`mock` Provider 契约保持不变。

资产层的 Rust/TS 边界包括：

- `src-tauri/src/ai/models.rs`：多文件 manifest、扩展白名单、相对路径与 symlink/reparse 安全、大小/SHA 校验、managed/linked 注册与验证；
- `src-tauri/src/ai/download.rs`：单 FIFO 下载、Range/.part、镜像切换、许可证、磁盘检查、暂停/恢复/取消和崩溃恢复；
- `src-tauri/src/ai/store.rs`：schema v4→v6 的 `model_packages`、`model_package_files`、`model_sources`、`model_download_tasks`、`model_license_acceptance`；
- `src/features/ai/models`：只读 adapter、controller、view model 和状态测试；开发 UI 不把资产状态提升为 `App.tsx` 真源。

模型库是可配置的设备路径。`managed` 只使用模型库内安全相对目录，确认删除时才删除精确受管理目录；`linked` 只登记用户外部绝对目录，重新定位需完整校验，删除永不删除外部文件。模型资产与阅读进度、portable archive、正文和向量缓存分离。

C-57 的 `findAvailableModelPackages` 只是“已安装、全部 verified、匹配 capability 且非 dev fixture”的元数据查询，C-58 才可在 Provider registry 中消费该查询并实例化运行时；C-57 不 create/load Provider，不读 EPUB、不建向量、不推理。开发入口和 `c57-dev-probe` 仅在 debug/dev 可见，正式版不提供公共模型市场。
