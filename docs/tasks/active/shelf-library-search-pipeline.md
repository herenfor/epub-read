# 任务：书架全库正文搜索与可配置语料流水线

- 状态：代码完成，待 Windows Tauri 实机审核
- 创建日期：2026-08-24
- 最后更新：2026-08-24
- 对应能力：C-56

## 目标

- 书架搜索可在“书名与作者”和“正文”之间切换；正文结果复用跨书 FTS，点击后打开书籍并按稳定文本锚点定位。
- 书架与阅读器的“全部书籍”共用唯一查询、结果、索引进度、取消和错误状态，任何时刻最多运行一个全库派生任务。
- 将逐书建库抽象成可供未来 FTS/向量/标签/摘要复用的语料流水线；本轮只启用 FTS sink，不接模型。
- Windows 桌面版使用真实 Worker 并行解析，SQLite 保持单写入调度；用户可设置最高并发，自动模式按逻辑核心选择并受书籍大小与阅读优先级约束。

## 非目标

- 不实现 Embedding、向量数据库、语义搜索、标签、摘要、RAG 问答或模型下载。
- 不开放第三方动态代码插件，不访问网络，不改变 Provider 选择。
- 不把派生缓存、任务或设备性能设置写入 portable archive。
- 不在用户确认前读取 EPUB 或启动建库。
- 不以多个普通 Promise 冒充多线程；浏览器开发预览允许降级，但发布版必须使用真实 Worker。
- 不在本轮解决单本超大 EPUB 的流式 ZIP 解压；大书必须独占调度，避免与其他书并行放大内存。

## 已确认边界

- `DocumentChunk`、`contentHash`、`chunkId`、parser/normalizer/chunker 版本和 paginator-compatible `TextAnchor` 保持为唯一语料与引用契约。
- 通用流水线输出 chunk，不直接依赖 FTS schema；本轮 `FtsCorpusSink` 是唯一启用的消费端。
- 全文索引仍是可删除、可重建派生缓存，不影响 EPUB、书架、进度、书签、笔记、用户确认标签或 Provider 配置。
- 阅读器当前书搜索保持会话级独立；书架“正文”和阅读器“全部书籍”共享全库查询；书架书名/作者查询另行保存。
- `App.tsx` 只组合入口和跳转，查询/任务/Worker 状态归 `src/features/ai` controller/store；关闭面板或切换书架/阅读器不得取消任务。
- 前端运行时锁与 Rust 持久任务互斥共同保证唯一建库；完成书原子提交，半本 staging 在取消或异常退出时回收。
- SQLite 读写允许并存，但所有派生写入经过单一写入队列；搜索结果只暴露已提交且版本匹配的书。
- 用户配置表示最高并发而非强制并发。自动模式使用 `navigator.hardwareConcurrency`，保留系统/界面资源；大书、阅读加载、取消与内存保护可以动态降级。

## 建议并发规则

- 自动：1～4 核使用 1；6～8 核使用 2；10～12 核使用 4；14～16 核使用 6；18 核以上使用 8。
- 手动：1 到 `min(16, max(1, logicalCores - 1))`；常用快捷值 1/2/4/6/8。
- 大于 512 MiB 的 EPUB 独占；Worker 只持有一本书和有界 chunk 批次；主线程以 transferable ArrayBuffer 移交字节。
- 阅读器加载/测量/快速翻页期间不启动新书，已有 Worker 在章节或批次边界让出。

## 预计修改文件

- `src/features/ai/indexing/*`：共享运行时、语料 sink、Worker 协议/池、并发设置与任务调度。
- `src/core/bookCorpusIndex.ts`：保持通用语料批次契约，按 Worker 需要增加可序列化边界。
- `src/ui/ShelfView.tsx`、`src/ui/SearchPanel.tsx`、`src/styles.css`：双模式书架搜索和共享状态投影。
- `src/App.tsx`：组合共享 controller、书架/阅读器入口及跨书锚点打开，不再拥有建库算法。
- `src-tauri/src/ai/*`：全库任务互斥和恢复的最小原生保护。
- `docs/MODULE_CONTRACTS.md`、RAG/任务/差异文档：登记长期边界和验证。

## 验收标准

- [x] 书架书名/作者搜索保持原行为，正文搜索不混用其查询值。
- [x] 书架正文与阅读器全部书籍共享查询、结果、确认、进度、取消、错误和任务 ID。
- [x] 两个入口快速触发仍只创建一个持久任务；切换视图/关闭面板不中断建库。
- [x] 点击书架正文结果打开对应书并精确跳转；预览不写阅读进度。
- [x] Worker 池遵守自动/手动上限、单写入顺序、大书独占和阅读优先级。
- [x] 取消不启动新书、不留下半本索引；异常退出后已提交书保留并可续建。
- [x] FTS sink 与通用语料生产边界分离，未来增加向量 sink 无需改 EPUB 解析和书架入口。
- [ ] Windows 单线程/2/4/8 并发性能、CPU、峰值内存和阅读响应完成实机验收。

## 不应同步的本地文件

- 测试 EPUB、SQLite app-data、Worker 性能日志、截图、`dist`、`target` 和临时脚本。

## 实际实现

- `LibrarySearchRuntime` 成为应用级唯一全库搜索状态源；书架正文入口和阅读器“全部书籍”共享查询、结果、确认、任务、进度、取消与错误，面板关闭不销毁任务。
- `CorpusWorkerPool` 使用真实 module Worker 并发解析 EPUB，字节在获得槽位后才读取并以 transferable `ArrayBuffer` 移交；批次 ACK 提供背压，FTS sink 串行写入。
- 自动并发按逻辑核心选择 1/2/4/6/8，手动值限制为 `1..min(16, cores-1)`；设置只保存在本机。大于 512 MiB 的书独占，阅读加载时禁止启动新书且活动 Worker 在批次边界让出。
- 两个索引入口均显示“逻辑处理器”口径、自动推荐值、手动最大值和内存提示；手动输入框的实际 `max` 与设备上限一致。例如检测到 24 个逻辑处理器时自动推荐 8，手动最多 16。
- Rust `ai_task_acquire_library_index` 使用即时事务幂等取得唯一 `library-text-index` 任务；异常退出后的 active task 会回收，已原子提交的单书索引继续保留。
- Vite Worker 输出改为 ES module；生产构建已确认生成独立 `corpusWorker-*.js`，不是在主线程伪并发。

## 自动化验证

- 前端全量：72 个文件、504 个用例通过。
- TypeScript 与生产构建通过；Vite 136 modules，并生成 28.70 kB 独立 Worker chunk。
- Rust fmt 通过，Rust 39/39 tests 通过。

## 待完成与风险

- 当前 `fflate.unzipSync` 会整本解压；Worker 隔离主界面但不会降低单本解压峰值，大于 512 MiB 仅做独占保护。
- `@xmldom/xmldom` 已被 Vite 打入生产 Worker 的动态 chunk；它是构建期依赖而非安装后外部运行时依赖，现有归类不阻断发布，但许可证清单仍须按既有暂缓事项统一复核。
- WebView2 的实际核心数、Worker 生命周期、transferable 行为和内存峰值必须在 Windows 发布构建验证，WSL 浏览器不能替代。

## 后续性能调查（仅计划，当前不优化）

- 用户初步观察：并发超过 8 后，建库耗时改善已经不明显。当前自动模式继续以 8 为高核心设备推荐值，不据此修改流水线或数据库实现。
- 后续若单独开展调查，使用同一书库分别测试 1/2/4/6/8/12/16 并发，记录总耗时、逐阶段等待、CPU、峰值内存、磁盘吞吐和阅读交互延迟；冷启动与已有系统文件缓存的结果分开记录。
- 调查应区分 EPUB 读取/解压/切块、Worker 等待 ACK、主线程队列和 SQLite append/commit，判断瓶颈是解析、磁盘还是单写入；只形成数据和结论，不在没有证据时扩大缓冲、增加写线程或调整批次。
- 若 8 以上无稳定收益，后续可以把手动 12/16 保留为高级选项，但不提高自动推荐值。

## 交接说明

继续时先读本文件、`docs/AI_PLUGIN_ARCHITECTURE.md`、`docs/SEARCH_TO_RAG_ROADMAP.md`、C-54 任务、`libraryIndexer.ts`、`indexController.ts` 和 Rust AI task/store。不得把共享状态重新堆回两个 UI，也不得提前接向量或生成模型。

## 源仓同步状态

- [x] 已更新 `docs/SOURCE_DELTA.md`
- [ ] 用户已审核
- [ ] 用户已同步到真实源仓
- 源仓提交：待用户填写
