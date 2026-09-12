# 隔离副本相对源仓的变化

本文件是跨对话交接的首要状态页，用于回答：“`epub-reader` 相比真实源仓改了什么、是否验证、是否已经同步？”

## 路径映射

- 隔离副本：`<PROJECT_ROOT>/epub-reader`
- 真实源仓：`<PROJECT_ROOT>/eupb-read`
- 用户口头所称 `epub-read` 在当前磁盘上的实际名称为 `eupb-read`。
- AI 不得修改、提交或推送真实源仓。

## 当前比较基线

- 2026-09-11 只读核对：源仓 `main`、本地 `origin/main`、`v0.1.9-beta.1` 指向 `4aaa87137e5af237d0594bb64a2d9a285c2dd08c`，工作区干净。
- 提交时间：`2026-08-23T12:50:46+08:00`。
- 提交说明：`fix: v0.1.9-beta.1 (search parser strict XML, menu width, context menu anchoring, foreground arbitration B-067..B-071)`。
- 下表早期条目曾按 `e8aabcdeb03543402338aee00fb2e33d52e39841` / `v0.1.6` 登记，作为历史保留；不能把整张历史表都当作相对 beta.1 的新增差异。同步前仍需逐文件比较。
- 本轮只修改 `epub-reader`，未同步、提交、推送或修改真实源仓。

## 当前未同步变化

状态：**隔离副本仍为 `0.1.9-beta.2`。2026-09-11 基础修复 B-082～B-084 已完成本地验证：预加载设置一致性、添加笔记、已索引书籍删除。Vitest 86 文件/547 用例，tsc，Core/AI 前端各 150 modules 与产物门禁；Rust Core 49/49、AI 87/87、fmt 通过。Chromium 实际主题/字号切换、相邻章往返、笔记创建/保存/重开/编辑通过。Windows WebView2 与原书库实测仍待复验；C-57.6 双安装包验收状态未改变。**

2026-09-12 追加：B-085～B-087 三本目录/色块宽度修复已完成本地验证；当前前端基线为 **87 files / 552 tests**，两版构建/产物门禁通过。三本标题页保持原样，Windows 原书复验待用户完成。详见 `docs/tasks/active/toc-width-three-books.md`。

2026-09-12 第二轮追加：B-088～B-090 火焰目录色块、赤月条目越界及相容同居标题百分比间距完成本地修复；当前 **89 files / 558 tests**、Core/AI 各 151 modules 与产物门禁通过。详见同一 `toc-width-three-books.md` 追加记录；Windows/汇报人确认待完成。

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/paginator.ts`、`paginator.test.ts`、`paginator.clippedExtent.test.ts`、`percentageInsets.test.ts`、`percentageSpacing.ts`、`percentageSpacing.test.ts` | 更新/新增 | B-088～B-090：行内色块保留长短差异并排除被裁空白页；自动分组块固定边距计入限宽；页面百分比间距按有效版心计算并可恢复 | 89/558、双版构建/tsc/门禁；32 个实书组合、同文档重排和合成 padding/级联边界 | 是 |
| `docs/tasks/active/toc-width-three-books.md`、活动 README、BUGFIX_LOG、rendering-layers、PROJECT_CONTEXT、SOURCE_DELTA | 更新 | 追加三项反馈、C-16b 与 C-25/C-04 的修订；首轮标题保持原样声明限定为首轮 | 相容同居标题百分比由本轮用户明确授权修复；背景图设计继续保留，Windows 待验 | 是 |
| `src/render/paginator.ts`、`src/render/paginator.test.ts`、`src/render/percentageInsets.test.ts` | 更新/新增 | 2026-09-12 B-085～B-087：非标题自动盒的对称作者边距计入版心；对称百分比卡片保留限宽；竖排 float 不被横排 Canvas 撑宽并收进版心。保留标题与明确作者布局 | 全量 87/552、tsc、Core/AI 各 150 modules 和 artifact gate；三本目标、三本标题页及五本旧目录的原书矩阵，真实 reflow 通过 | 是 |
| `docs/tasks/active/toc-width-three-books.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/PROJECT_CONTEXT.md`、`docs/SOURCE_DELTA.md` | 更新/新增 | 记录三本宽度修复及用户补充：相容同居实际为 message.xhtml 的蓝色卡片，标题背景图不属于修复范围 | Windows WebView2 待复验；本轮无 Rust 变更，不重复运行 Cargo | 是 |
| `src/ui/ReaderView.tsx`、`src/render/paginator.ts`、`src/ui/ReaderView.preload.test.ts` | 更新/新增 | B-082：每个槽位记录实际设置，后台创建读取最新设置；防抖被换章取消时在同一次 load 应用最新设置，拒绝旧缓存提升 | 4 条真实 React 生命周期回归；Chromium 深色 24px → 下一章 → 浅色 18px → 下一章/回翻 | 是 |
| `src/ui/ReaderContextMenu.tsx`、`src/ui/ReaderContextMenu.interaction.test.ts`、`src/test/reactDomHarness.ts` | 更新/新增 | B-083：菜单先关闭再打开笔记，防止前台仲裁覆盖编辑框 | 修复前真实 React 点击测试失败、修复后通过；实际创建/保存/重开/编辑通过 | 是 |
| `src/App.tsx`、`src/ui/shelf.ts`、`src/ui/shelfDeletion.test.ts`、`src/ui/linkedShelf.test.ts`、`src-tauri/src/linked_library.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/ai/mod.rs`、`src-tauri/src/ai/store.rs` | 更新/新增 | B-084：后台原生删除、批量 IPC/事务/书架写入；最后一个索引用同 schema 清空 FTS，其他情况合并删除；前端仅移除成功记录 | Core/AI Rust；FTS/staging/jobs 范围、回滚、遗留行、重建、无 DB 副作用回归；合成 SQL 性能对照详见任务 | 是 |
| `docs/tasks/active/core-reader-fixes-september.md`、`docs/tasks/active/README.md`、`docs/tasks/active/next-chapter-preload.md`、`docs/tasks/active/reader-notes.md`、`docs/PROJECT_CONTEXT.md`、`docs/SOURCE_DELTA.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md` | 更新/新增 | 登记三项基础修复、当前源仓基线、验证和 Windows 边界 | 与本轮代码、测试及只读 Git 状态核对 | 是 |
| `src/App.tsx`、`src/ui/ShelfView.tsx`、`src/ui/SearchPanel.tsx`、`src/styles.css`、`src/features/ai/indexing/librarySearchRuntime*`、`corpusWorker*`、`corpusSink*`、`corpusConcurrency*`、`workerLibraryIndexer.ts`、`ftsCorpusSink.ts`、`vite.config.ts` | 新增/更新 | C-56 书架增加独立的“书名与作者/正文”模式；正文入口与阅读器“全部书籍”共享唯一应用级查询、结果、确认、任务、进度、取消和错误。语料生产与 FTS sink 解耦，生产构建使用真实 ES module Worker、transferable 字节、有界批次 ACK 和单 sink 写入；自动/手动并发受逻辑处理器、大书独占和阅读优先级约束，设备设置不进存档。索引卡说明自动推荐/手动最大值和内存代价，输入上限与当前设备一致 | 前端 72 files/504 tests、tsc、Vite 136 modules；并发说明定向 17/17；生成独立 28.70 kB `corpusWorker` chunk | 是 |
| `src/App.tsx`、`src/ui/FontSettingsPanel.tsx`、`src/ui/fontDrop.ts`、`src/ui/fontDrop.test.ts`、`src/styles.css` | 新增/更新 | C-57 字体中心支持浏览器 HTML5 与 Windows Tauri 原生路径拖放；多字体串行导入、格式预筛选、busy 仲裁、坐标命中和防闪烁视觉态均复用原 FontStore 链路 | helper 5/5；全量 73/509、tsc、Vite 137 modules | 是 |
| `src-tauri/src/ai/store.rs`、`src-tauri/src/ai/commands.rs`、`src-tauri/src/lib.rs`、`src/features/ai/indexing/indexTaskStore.ts` 及测试 | 更新 | C-56 新增幂等 `ai_task_acquire_library_index`：以即时事务取得唯一 `library-text-index` 任务，恢复 queued/paused，复用 running，同时允许其他 task kind 并行；前端启动不再先查后建产生竞态 | Rust fmt、39/39 tests；前端全量包含双入口快速启动只取得一个任务回归 | 是 |
| `docs/tasks/active/shelf-library-search-pipeline.md`、`docs/MODULE_CONTRACTS.md`、`docs/HANDOFF.md`、`docs/PROJECT_CONTEXT.md`、`docs/AI_PLUGIN_ARCHITECTURE.md`、`docs/SEARCH_TO_RAG_ROADMAP.md`、`README.md` | 新增/更新 | 登记 C-56 的共享运行时、真实 Worker、互斥/恢复、资源边界、设备并发和 RAG sink 扩展契约；明确本轮未实现模型/向量/标签/生成且仍待 Windows 实机审核 | 与代码及最终验证结果核对 | 是 |
| `docs/PROJECT_CONTEXT.md` | 更新 | 基线推进到 `e8aabcd`，记录 0.1.6、当前隔离副本 186 项测试、B-027 CSS 提交与 bgcolor 契约 | 与真实源仓、版本文件核对；全量 186/186 | 是 |
| `docs/tasks/active/version-0.1.6-development.md` | 更新 | 将 0.1.6 从“开发中/未同步”改为“已同步，待 Windows 发布状态确认” | 与 `main`、`origin/main`、`v0.1.6` 核对 | 是 |
| `docs/tasks/active/import-performance-duplicates-and-progress.md`、`custom-fonts-css-and-select-all.md`、`reader-history-back.md`、`bookmark-feature.md` | 更新 | 补齐源仓提交和同步状态；Windows 安装包未获确认的项目仍保留待确认 | 与 0.1.6 提交历史核对 | 是 |
| `src/render/paginator.ts` | 更新 | B-023：百分比 margin 主路径改为 Typed OM 最终级联；B-024：C-18 正对称 margin 居中豁免收窄到 fit/max-content 原始意图；B-025：computed-right 对齐行可见 inline 盒尾随 U+3000/NBSP 越界时使用几何门控原子化并在失败时事务式恢复；恢复移除 per-measure 标记，且先筛空白再读取样式 | 定向 19/19、全量 184/184、tsc、Vite、三本实书 Chromium 矩阵 | 是 |
| `src/render/paginator.test.ts` | 更新 | B-023/B-024 回归基础上，新增 B-025 尾随宽空白、可见盒、computed-right（逻辑 end 保守跳过）、实际越界与原子化回滚决策及生命周期标记恢复测试 | 定向 19/19、全量 184/184 | 是 |
| `docs/BUGFIX_LOG.md`、`docs/rendering-layers.md` | 更新 | B-022 改为部分修复并新增 B-023/B-024；C-16 登记最终级联与安全回退，C-18/C-24 登记对称 margin 边界 | 与代码和真实验证记录核对 | 是 |
| `docs/tasks/active/README.md`、`toc-percent-margin-resilience.md`、`toc-symmetric-margin-regression.md` | 更新/新增 | 登记 B-023/B-024 待用户审核状态、验收证据与风险 | 任务内验证表 | 是 |
| `docs/tasks/active/toc-inline-box-overflow.md` | 新增 | 登记 B-025/C-25 的根因、门控、生命周期、双视口验收和 Windows 待确认项 | 与代码、实书 Chromium 输出核对 | 是 |
| `docs/PROJECT_CONTEXT.md` | 更新 | 测试基线更新为 16 文件、185 用例，并记录 computed-right 行内盒 L5 补偿、end/RTL 保守边界与 B-026 历史契约 | 全量 Vitest 185/185 | 是 |
| `src/App.tsx` | 更新 | B-026：抽取最多 10 步的统一历史快照与只执行 href 的跳转函数；目录、书签和 paginator 内部链接按有效目标分别保证单次入栈，无效跨章不记录 | 真实 Chromium 跨章/fragment/invalid 撤销，tsc、Vite | 是 |
| `src/ui/ReaderView.tsx` | 更新 | B-026：通过 latest ref 转发 paginator 的已解析 href 与 before 通知，修复首次 loading 闭包导致的历史失效 | 真实 Chromium 跨章/fragment 撤销 | 是 |
| `src/render/paginator.ts` | 更新 | B-026：有效普通内部链接和存在目标的 fragment 改变位置前通知一次历史；外链/脚注、缺失 fragment 不通知，fragment 保持原地 hash/jump | Paginator 20/20、全量 Vitest 185/185 | 是 |
| `src/render/paginator.test.ts` | 更新 | 新增有效/无效内部路径、存在/缺失 fragment、外链通知边界回归；保留 B-025 生命周期和布局回归 | 定向 20/20、全量 185/185 | 是 |
| `docs/MODULE_CONTRACTS.md`、`docs/BUGFIX_LOG.md`、`docs/tasks/active/reader-history-internal-links.md`、`docs/tasks/active/README.md` | 新增/更新 | 登记 B-026 的 latest-ref、单次快照、fragment 撤销与外链/脚注排除契约 | 与代码和真实 Chromium 输出核对 | 是 |
| `docs/SOURCE_DELTA.md` | 更新 | 保留上述 0.1.6 交接文档差异，同时登记 B-023 待同步代码与文档 | 本文件、只读基线核对 | 是 |
| `src/ui/MenuPanel.tsx`、`src/ui/menuPanel.test.ts` | 更新 | B-027 将 custom CSS 改为本地 draft，只有“保存并应用”提交；支持清空、外部值同步与无改动禁用 | 定向/全量 Vitest；Chromium 输入 5 字符期间 iframe load=0，保存与清空各一次 | 是 |
| `src/render/sanitize.ts`、`src/render/sanitize.test.ts` | 更新 | B-027 将浅色安全 bgcolor 合入同一 override style 的默认 background-color，移除已消费 legacy 属性，userCss 保持最后；深色/纸色忽略且不重置背景图 | sanitize 49/49；合成章节 Chromium computed 背景与主题矩阵 | 是 |
| `docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/tasks/active/custom-css-commit-and-theme-bgcolor.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md` | 新增/更新 | 登记 B-027/C-26、186 测试基线与多个 CSS 预设 optional backlog | 文档链接/术语自检；全量 Vitest 186/186、tsc、Vite build | 是 |
| `src/ui/Toolbar.tsx`、`src/styles.css` | 更新 | B-028 按左右控件实际 layout `scrollWidth` 取最大值写入对称侧轨，宽屏标题可完整显示时居中；720px 以下切回不对称 max-content 轨道并单行省略 | Chromium 1080×760 标题中心差 0px；640×480 UI scale 1/1.3 按钮与标题无重叠 | 是 |
| `docs/MODULE_CONTRACTS.md`、`docs/BUGFIX_LOG.md`、`docs/tasks/active/toolbar-narrow-layout.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/PROJECT_CONTEXT.md` | 新增/更新 | 登记 B-028 对称侧轨、窄屏 fallback、中心契约和验收矩阵 | 文档链接自检；全量 Vitest、tsc、Vite build | 是 |
| `src/render/cssRewrite.ts`、`src/render/cssRewrite.test.ts` | 更新 | B-029 增加带 context nonce 的 quote-aware CSS comment protector；递归 `@import` 共享保护 context，注释外才执行 import/url/width 改写，inline width helper 保持同一边界 | cssRewrite 24/24；递归/未闭合/quoted URL/注释泄漏/占位符碰撞回归 | 是 |
| `src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`src/render/paginator.ts`、`src/render/paginator.test.ts` | 更新 | B-029 的 ancestor width、纯图片尺寸和 float guard 改用注释安全 authored-property 判断 | 定向 96/96；全量 Vitest 197/197、tsc、Vite build | 是 |
| `docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/tasks/active/css-comment-boundaries.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/PROJECT_CONTEXT.md` | 新增/更新 | 登记 B-029/C-27、nonce sentinel 注释边界契约与 0.1.6 活动任务基线；补录 sanitize 外链 CSS Chromium 端到端证据 | 文档结构自检；自动化 17 文件 197/197、Chromium hiddenReads=0/CSSOM/ComputedStyle | 是 |
| `src/render/paginator.ts`、`src/render/paginator.test.ts` | 更新 | B-030：末尾递归媒体-only float 以首列碎片 top + `scrollHeight` 推算未分片底部，临时收紧 margin-top，并用候选/后代视觉 rect、列边界、前序兄弟碰撞与 scrollLeft 做事务门控 | paginator 23/23；目标书 900×650、1280×800、640×480 Chromium | 是 |
| `docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md`、`docs/tasks/active/trailing-media-float-overflow.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/PROJECT_CONTEXT.md` | 新增/更新 | 登记 B-030/C-30、199 测试基线、四本相邻实书回归及 title wrapper 仅诊断边界 | 文档链接/状态自检；全量 Vitest 17 文件 199/199、tsc、Vite build、Chromium | 是 |
| `src-tauri/src/linked_library.rs`、`src-tauri/src/lib.rs` | 新增/更新 | B-031：以可同步记录、设备绑定和缩略图索引替代复制式书库；实现流式哈希、受限 ZIP 元数据、批量集中提交、变更检测、raw source/cover、精确重新关联、进度/书签、100 MiB LRU 与崩溃孤立缓存清理；移除旧复制式 runtime 命令 | Rust 9/9、`cargo fmt --check`、`cargo check --quiet` | 是 |
| `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/capabilities/default.json`、`package.json`、`pnpm-lock.yaml` | 更新 | B-031：加入 Tauri dialog/fs 插件及最小文件选择、存档文本读写权限；锁文件同步 | Cargo/TypeScript/Vite 生产构建通过 | 是 |
| `src/ui/shelf.ts`、`src/App.tsx`、`src/ui/ShelfView.tsx`、`src/styles.css` | 更新 | B-031：统一链接书库接口、一次性批量合并、重复/失败提示、缺失源文件徽标与重新定位、桌面存档选择、卡片 memo 与离屏布局隔离；书签确认不再以旧完整快照覆盖进度；浏览器保留 IndexedDB 测试后端 | `linkedShelf` 3/3；全量 218/218；TypeScript/Vite build | 是 |
| `src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts` 及测试 | 新增 | B-031：v1 无路径 JSON 存档、严格 schema/设置白名单、路径泄漏拒绝、按哈希合并较新进度/书签与 Tauri/浏览器投影 | 存档定向 9/9；全量 218/218 | 是 |
| `src/ui/thumbnail.ts`、`src/ui/thumbnail.test.ts` | 新增 | B-031：近视口门控、全局四并发、取消与 Blob 生命周期、最大 240×360 JPEG/WebP 派生 | 定向 5/5；全量 218/218 | 是 |
| `src/ui/progressWriter.ts`、`src/ui/progressWriter.test.ts` | 更新 | B-031：每本书首次稳定进度立即提交，后续 750ms 合并；在途 batch 冻结，更新值留待下一批，生命周期边界 flush | 定向 5/5；全量 218/218 | 是 |
| `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/src/lib.rs` | 更新 | B-032：桌面目标加入官方单实例插件并最先注册；第二次启动关闭自身，已有 `main` 窗口依次 show/unminimize/focus；浏览器开发路径不变 | Rust 10/10、`cargo fmt --check`、`cargo check` | 是 |
| `README.md`、`docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/tasks/active/desktop-single-instance.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | B-032：记录单实例外壳契约、官方插件选择、当前 10 项 Rust 基线、验证与 Windows 双启动待确认项 | 文档/实现接口核对 | 是 |
| `README.md`、`docs/HANDOFF.md`、`docs/tasks/active/linked-library-refactor.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md` | 新增/更新 | 登记 B-031 架构、数据边界、自动化证据、跨 JSON 崩溃边界、单本超大 EPUB 非目标及 Windows 100+ 本待验收项；移除交接入口中的复制式书库现状描述 | 文档与实现接口核对；全量前端/Rust/构建通过 | 是 |
| `src/ui/readerNavigationHistory.ts`、`src/ui/readerNavigationHistory.test.ts` | 新增 | B-033：纯 TS back/forward 双栈，每栈最多 3 条；普通新跳转清空 forward，后退/前进对称交换当前位置 | 定向历史测试 3/3 | 是 |
| `src/App.tsx`、`src/ui/ReaderView.tsx`、`src/render/paginator.ts`、`src/render/paginator.test.ts`、`src/ui/Toolbar.tsx`、`src/styles.css` | 更新 | B-033：同步 ready ref、初始基线单次捕获门、display-ready transition gate、同章 fragment settled 通知、anchor 优先恢复、转场禁写旧进度、实际页状态触发进度写入、前进/后退胶囊按钮及动态 intrinsic 侧轨测量 | 定向 31/31、全量 22 文件 221/221、`tsc --noEmit`、Vite build、WSL Chromium 交互 | 是 |
| `docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/reader-navigation-history-forward.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-033 的 ready 竞态、双栈与恢复契约、验证边界和用户审核状态 | 文档/接口核对 | 是 |
| `src/render/paginator.ts`、`src/render/paginator.test.ts` | 更新 | B-034：目录顶层无作者水平 margin 的 computed left/right float，在宽容器写入物理 float 侧 40rem 版心 inset；纯函数覆盖 right/left、窄容器及作者 margin/全页/全宽意图/过宽盒跳过；full-width intent 排除 reader 注入 stylesheet、过滤当前不生效条件，并置于 fit/max-content 分支之后 | paginator 28/28；全量 22 文件 226/226；`tsc --noEmit`、Vite build、目标书三视口与三本相邻实书 Chromium 通过 | 是 |
| `docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md`、`docs/tasks/active/toc-top-float-containment.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/PROJECT_CONTEXT.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-034/C-31、marginFixes 恢复契约、全宽意图保守边界与验证结论 | 文档/接口核对；全量测试、构建与实书 Chromium 通过 | 是 |
| `src/styles.css`、`src/ui/footnoteStyles.test.ts` | 新增/更新 | B-035：宿主脚注弹层仅对 `.duokan-footnote-content` 隐藏 `li[value]` 生成 marker、清零列表 padding，并取消该结构直接图片容器的旧负左 margin；普通 `.footnote-html ol/ul` 保持编号与缩进 | CSS 契约 2/2；定向 91/91；全量 Vitest 23 文件 228/228；`tsc --noEmit`、Vite build；目标书两个图片脚注 WSL Chromium 通过，WebView2 待确认 | 是 |
| `docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md`、`docs/tasks/active/footnote-rich-content-marker.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-035/C-32、富脚注跨 iframe 列表语义和普通列表保护边界 | 文档/接口核对；测试与构建结果见任务收尾 | 是 |
| `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 更新 | 将隔离副本四处构建版本统一提升为 0.1.7 测试发布候选；Cargo.lock 只修改 epub-reader 根包 | 版本一致性、Cargo metadata、全量前端/Rust 复验 | 是 |
| `docs/RELEASE_0.1.7.md`、`docs/tasks/active/version-0.1.7-release-candidate.md`、`docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`、`docs/tasks/active/README.md`、相关活动任务 | 新增/更新 | 建立 0.1.7 当前入口、Windows 安全同步/构建命令、排除项与发布包验收矩阵；0.1.6 任务冻结为历史入口 | 文档、命令和路径核对 | 是 |

0.1.7 候选收口时，`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 Cargo 锁文件中的本项目版本曾统一为 `0.1.7`；当前版本以本文件顶部状态和 0.1.8 收口段为准。

0.1.7 发布候选当时的复验：前端 Vitest 23 文件 228/228、Vite production build、Rust 10/10、`cargo fmt --check` 与 `cargo check --locked` 均通过；`cargo metadata --locked --no-deps` 识别 `epub-reader@0.1.7`。该段仅保留阶段历史，当前 Windows 发布入口为 0.1.8。

交接复验：Vitest 16 个文件 174/174、TypeScript、Vite 生产构建、`cargo check`、Rust 2/2 单测及 `cargo fmt --check` 均通过。B-023 验证：Vitest 16 个文件 177/177，真实 Chromium 双视口目录为 1/1 页。B-024 本轮验证：Vitest 16 个文件 179/179、`tsc --noEmit`、Vite 生产构建通过；侦探少年目录在 1280×800 与 900×650 均为 1/1 页，`Contents` 左缘恢复到 0.1.3 的 344px/154px；C-18 简介灰框宽屏、窄屏与 20px 字号仍逐列居中；B-023 的 70% margin 目录仍为 1/1 页。B-025 本轮验证：全量 Vitest 16 个文件 184/184、`tsc --noEmit`、Vite 生产构建通过；目标书 1280×800 色块右缘回到 960px 且 1/1，900×650 当前列右缘回到 770px、状态 1/2，键盘下一页可达 2/2，resize 后 per-measure 标记恢复并再次写回，最后“后记”不再落入不可达残片；B-023 与 B-024 均无回归。B-026 本轮验证：全量 Vitest 16 个文件 185/185、`tsc --noEmit`、Vite 生产构建通过；目标书跨章 iframe 链接和选择器书同章 fragment 均启用历史，撤销后恢复原位置且单次操作无重复历史。本轮未修改 Rust/Tauri，因此未重复运行 cargo。此前真实 Chromium 已验证导入判重与进度、全选、自定义字体/CSS、书签。Windows WebView2/NSIS 是否已重新编译、打包和分发仍待用户确认。

B-027 收尾：全量 Vitest 17 个文件 186/186、`tsc --noEmit`、Vite build 通过；Chromium 已验证编辑期间无 iframe 重载、保存与清空各触发一次，以及无作者 `!important` 的合成章节中浅色用户背景覆盖和深色/纸色主题回退。多个 CSS 预设仍为 optional backlog，不属于本次实现。

B-028 收尾：Chromium 1080×760 宽屏标题中心与 toolbar 中心差 0px（UI scale 1/1.3），书架“EPUB 阅读器”中心差 0px；640×480 窄屏 UI scale 1/1.3 均验证按钮完整且无重叠，窄屏 `nowrap`/ellipsis/9px，合成超长标题为 `439 > 315`、`472 > 171`。全量验证结果见本任务记录。

B-029 当前收尾：自动化定向 cssRewrite 24/24、sanitize 51/51、paginator 21/21（共 96/96），全量 Vitest 17 文件 197/197，`tsc --noEmit` 与 Vite build 通过；WSL Chromium 已完成 sanitize 外链 CSS 端到端验证：hiddenReads=0，注释逐字保留，CSSOM 仅有 `.real`，hidden 为默认色，real 保持蓝色与背景 URL。剩余为现有测试书普通回归和 Windows WebView2/安装包确认。

B-030 当前收尾：paginator 定向 23/23，全量 Vitest 17 文件 199/199，`tsc --noEmit` 与 Vite build 通过。目标书 900×650 为 1/1（`.fr` margin-top `-134.647px`），1280×800 为 1/1 且 margin-top `0px`；640×480 为 1/2，剩余两列来自目录主体自身。B-019、B-023、B-024、Sumeragi 900×650 实书回归均为 1/1。title.xhtml whole-page wrapper 仅诊断未修；Windows WebView2/安装包确认仍待用户。

B-031 当前收尾：前端 Vitest 21 文件 218/218、TypeScript/Vite 生产构建、Rust 9/9、`cargo fmt --check` 与 `cargo check --quiet` 均通过。桌面复制式书库命令已退出 runtime，链接源文件、便携存档、缺失源重新定位和有界缩略图已接入；每本书首次进度立即提交，启动会清理崩溃遗留的孤立缩略图/临时文件；旧 WSL/Windows `dev.epubreader.app` 缓存目标均不存在。Windows 发布包的 100+ 本/数 GB 性能、dialog/fs、拖放、重新定位和卸载源文件安全仍待用户实机确认。

B-032 当前收尾：桌面目标新增 `tauri-plugin-single-instance 2.4.3`，并作为 Tauri builder 首个插件注册。第二次启动通知会按 show、unminimize、focus 恢复已有 `main` 窗口，调用错误不会导致现有实例退出；浏览器 `pnpm dev` 不加载该插件。`cargo fmt --check`、Rust 10/10、`cargo check` 通过。仍需 Windows Tauri dev/发布包验证普通重复启动与最小化后重复启动各只保留一个进程/窗口。

B-033 当前收尾：阅读历史/paginator/progress writer 定向 31/31，全量 Vitest 22 文件 221/221，`tsc --noEmit` 与 Vite build 通过。代码实现使用最多 3 条 back/forward 双栈、初始保存位置基线、display-ready/同章 settled 稳定门控、anchor 优先恢复，并以实际页状态而非仅整数百分比触发进度写入。WSL Chromium 已验证首次跳转、连续 fragment、双向恢复和胶囊布局；Windows WebView2 人工确认待用户执行。

B-034 当前收尾：paginator 定向 28/28、全量 Vitest 22 文件 226/226、`tsc --noEmit` 与 Vite build 通过；新纯门控仅允许无作者水平 margin、宽度不超过 40rem 的 viewer 直接 `reader-top` float 进入，写回随 `marginFixes` 恢复。目标书 1280/900 已收回版心且保持 1/1，640 保持自然两页；玩具堂、赤月、すめらぎ相邻实书无回归。Windows WebView2 人工确认待用户执行。

B-035 当前收尾：脚注宿主 CSS 契约定向 2/2、脚注/样式/消毒/分页定向 91/91；全量 Vitest 23 文件 228/228，`tsc --noEmit` 与 Vite build 通过。目标书后记两个图片脚注已在 WSL Chromium 实际点击验证：生成 marker 隐藏、padding 为 0，图片与内容左缘一致；普通脚注列表保护回归通过。Windows WebView2 仍待人工确认。

## 本轮新增未同步变化（B-036、B-037）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/blobOwnership.ts`、`src/render/paginator.ts` | 新增/更新 | 按 sanitize/load 局部集合登记外链 CSS Blob URL；成功提交 iframe 后转为当前章节所有权，过期、异常、换章和 dispose 幂等撤销；`measure` 在异步边界核对 loadSeq、document/viewer 身份 | 生命周期定向 4/4、paginator 定向回归与 tsc；全量 Vitest/build 待收尾 | 是 |
| `src/ui/ReaderView.tsx`、`src/App.tsx` | 更新 | ReaderView cleanup 先 dispose paginator 再 revoke ResourceServer；返回书架 flush 后切视图，React 提交卸载后清空书籍会话状态 | 代码核对；React StrictMode/Windows WebView2 待人工确认 | 是 |
| `src/render/*lifecycle.test.ts`、`src/render/blobOwnership.test.ts`、`src/render/resources.test.ts` | 新增/更新 | 覆盖 CSS URL 成功换章、失败、过期、dispose、VisibilityGate 代次、共享 URL revokeAll 与幂等 | 定向 40/40；全量 Vitest 25 文件 236/236 | 是 |
| `docs/tasks/active/reader-session-lifecycle-and-blob-ownership.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md` | 新增/更新 | 登记 B-036 生命周期、所有权边界、页面中心仅观察锚点契约与验证边界 | 文档结构核对；全量 Vitest/tsc/Vite 通过 | 是 |
| `src/render/textAnchor.ts`、`src/render/paginator.ts`、`src/ui/ReaderView.tsx`、`src/App.tsx`、`src/ui/readingProgress.ts` | 新增/更新 | B-037：页面中心仅 caret 采样；当前章节自然布局后用 code-point 文本 offset/snippet→Range 列恢复，legacy/page 兜底，首列不受锚点影响；当前章分子消除父子重复计数并修正 linear=no | 定向 70/70、全量 Vitest 27 文件 250/250、tsc/Vite；WSL Chromium 视口、重开与连续字号矩阵通过，Windows WebView2 待人工确认 | 是 |
| `src/ui/shelf.ts`、`readerNavigationHistory.ts`、`storage.ts`、`libraryArchive*.ts`、对应测试、`src-tauri/src/linked_library.rs` | 新增/更新 | B-037：Shelf/书签/历史/浏览器存储/portable v1/Rust IPC 统一 optional `anchorTextOffset`/`anchorTextSnippet`；旧缺字段归一 null，文本-only sentinel 不跨 Rust usize 边界，snippet/数值严格校验 | archive/history/shelf/Rust round-trip 回归；Rust 11/11、fmt/check 通过 | 是 |
| `docs/tasks/active/text-content-anchor-and-progress.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-037/C-33 的自然分页、数据兼容、恢复优先级和 Chromium/WebView2 边界 | 文档与接口核对；自动化及 WSL Chromium 结果同上 | 是 |

## B-038 同章导航不重载

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/paginator.ts`、`src/render/paginator.test.ts` | 更新 | 新增当前已完成章节的同步 direct 导航：fragment/章首 hash 处理、text→legacy→page 恢复、异常事务回滚；成功不触发 load/sanitize/measure/recompute，失败保持当前页/anchor/hash | 定向 paginator/lifecycle 40/40；全量 Vitest 28 文件 258/258、tsc、Vite build | 是 |
| `src/ui/ReaderView.tsx`、`src/App.tsx` | 更新 | ReaderHandle 暴露同章原子入口；App 对 TOC/书签/history 做 ready 同章 direct 与跨章/未 ready reload 分流，历史仅在 direct 成功后提交 | 定向 history/progress/helper；全量 Vitest 258/258、tsc、Vite build | 是 |
| `src/ui/sameChapterNavigation.ts`、`src/ui/sameChapterNavigation.test.ts` | 新增 | 纯 helper 覆盖 direct/reload 判定、direct 失败不提交历史、back/forward 成功后采用 transition，不引入 React 测试依赖 | helper 3/3；全量 Vitest 28 文件 258/258 | 是 |
| `docs/tasks/active/same-chapter-navigation.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-038、C-33 的同章 direct/失败事务/跨章重载契约和非目标范围 | 文档链接/差异自检；全量 Vitest 258/258、tsc、Vite build | 是 |

## B-039 增量章节字数统计与进度 baseline 保护

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/ui/chapterCounts.ts`、`src/ui/chapterCounts.test.ts` | 新增 | generation-bearing unknown/estimated/measured collection；measured 优先、linear=no 排除、code-point safe count、complete/approximate summary、`resolveProgressPct` baseline 保护 | 定向及全量 Vitest 269/269、tsc、Vite build | 是 |
| `src/ui/chapterCountJob.ts`、`src/ui/chapterCountJob.test.ts` | 新增 | 可注入 requestIdleCallback/setTimeout 的可取消 job；每 slice 最多处理一章；结构排除 script/style、hidden、aria-hidden、明确脚注；缺资源/parser 失败 estimated 0 并留诊断；generation/book/server 防 stale callback | idle abort、A→B stale、一次一章、缺资源/parser 回归；定向及全量通过 | 是 |
| `src/render/textAnchor.ts` | 更新 | 导出纯结构排除判据，供 measured visible index 与 provisional count 复用；computed CSS hidden 仍只由 measured 路径处理 | textAnchor 4/4；全量 269/269 | 是 |
| `src/App.tsx` | 更新 | 删除打开书籍时整书同步 chapterChars 扫描；接入 counts ref/state、当前 ready anchor.totalChars measured、idle job、session generation、取消和 baseline progress；未 complete 沿用 baseline，complete 后更新 | 相关定向 69/69；全量 269/269、tsc、Vite build | 是 |
| `src/render/asyncWait.ts`、`src/render/asyncWait.test.ts`、`src/render/paginator.ts` | 新增/更新 | fonts 与 iframe defaultView double-rAF 可取消等待；先完成者清 timer，load/cleanup/dispose abort 旧 controller/rAF，最终保留 loadSeq/doc/viewer 校验 | 定向及全量 269/269、tsc、Vite build | 是 |
| `src/render/resources.ts`、`src/render/resources.test.ts` | 更新 | 新增默认 4 MiB/32 项 text LRU，按 text.length×2 估算，单条超限不缓存，decoder/stats 可测；revokeAll 清 entries/bytes，URL cache 契约不变 | LRU hit/淘汰/超大/revoke 回归；全量 269/269 | 是 |
| `docs/tasks/active/incremental-chapter-counts-and-progress.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-039、provisional 不参与布局、未访问 CSS hidden 只能估算、baseline/取消/LRU 边界与非目标（CSS cache/预加载/流式 ZIP/Rust） | 文档链接/术语自检；Vitest 31 文件 269/269、tsc、Vite build | 是 |

## B-040 快速设置重载与锚点 snapshot

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/ui/settingsReload.ts`、`src/ui/settingsReload.test.ts` | 新增 | 可取消 150ms debounce；连续设置只执行最后 task，章节切换可取消 pending timer | debounce/取消 2/2 | 是 |
| `src/ui/ReaderView.tsx` | 更新 | settings/userFonts identity 变化合并为最后一次 reload；章节、book/server cleanup 与 dispose 取消 timer；切章记录最新 settings，避免额外 reload | 与 paginator lifecycle 定向回归、tsc | 是 |
| `src/render/paginator.ts`、`src/render/paginator.settings.test.ts` | 更新/新增 | `reloadWithSettings` 在 await/load 前一次性复制 `ReadingAnchor` 与 current page，向 `load` 传 snapshot 和 fallback；无 document 时保留既有 anchor | B-040 定向 44/44；B036 stale gate/Blob 回归保持；Chromium 测试书 900×650 快速双字号+仍第 2/3 页且旧 snippet 可见 | 是 |
| `docs/tasks/active/reader-settings-reload-debounce.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-040，记录设置合并、anchor snapshot、过期 reload 防护与非目标范围，并登记 Chromium 矩阵结论 | 链接/术语自检；全量 Vitest 33 文件 273/273、tsc、Vite build | 是 |

## B-041 多看普通图文容器误判为全页图

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/sanitize.ts`、`src/render/cssRewrite.ts`、`src/render/paginator.ts` | 更新 | `.duokan-image-single` 不再仅因类名获得全页图语义：恢复普通图文/图注的作者布局与通用 width 规则；明确 fullscreen 类、纯单图和 B-013 SVG 的页面级全页路径保持 | 新回归旧实现 2 项失败；定向 Vitest 3 文件 114/114、目标 EPUB Chromium 1280×800 已复核普通图文与图注无越界；整组全量 Vitest 34 文件 304 测试、`tsc --noEmit`、`pnpm build`（95 modules）通过 | 是 |
| `src/render/sanitize.test.ts`、`src/render/cssRewrite.test.ts` | 更新 | 增加普通 single 图文容器、显式 fullscreen 与页面级纯图/SVG 边界回归 | 同上 | 是 |
| `docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 建立 B-041～B-044 统一任务，记录 B-041 根因、C-34 冲突台账、验证和后续三项的未处理边界；收尾时统一四项自动化/WSL Chromium 状态 | 文档与代码/测试术语核对；整组全量 34 文件 304 测试、tsc、build 通过 | 是 |

## B-042 连续百分比 float 组级版心门控

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/paginator.ts` | 更新 | C-31 现在识别连续直接 sibling 的同向百分比 float 栅格；只对总和 99..101 且至少两项的明确作者组跳过逐项版心 inset；现代 Typed OM 的明确 px 直接否决，旧 CSSOM 只处理简单可判定级联，reader overrides/复杂选择器/未知条件/不可读源保守不豁免 | 旧实现新增回归 36/5（5 项失败）；级联边界补测后 paginator 48/48；目标 EPUB 1280×800/900×650 前五个 opacity float 均同一行、无 margin 写回；整组全量 34 文件 304 测试、tsc、build 通过 | 是 |
| `src/render/paginator.test.ts` | 更新 | 覆盖 20×5、50×2、33.333×3 容差、单 float/20×2、不满整行、混合 px/%、方向/普通块/clear 断组、Typed OM px/无值、inline important/stylesheet 覆盖、reader overrides、复杂伪类、未知 CSSOM 和最终级联 | 定向 paginator 48/48 | 是 |
| `docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md` | 更新 | 登记 B-042/C-35 的组级门控边界、Typed OM 优先级、旧 CSSOM 保守风险、reader userCss 不可区分边界、B-034 回归约束；补写 1280×800/900×650 前五个 opacity float 的同一行 Chromium 证据 | 文档/代码术语核对；目标 EPUB Chromium、全量 34 文件 304 测试、tsc、build 已完成；Windows WebView2 待用户 | 是 |

## B-043 EPUB 3 NAV fragment 与多级目录

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/core/nav.ts`、`src/core/nav.test.ts` | 更新 | EPUB 3 `epub:type` 增加命名空间/属性回退；最近列表搜索在嵌套 li 边界剪枝，父项只读取自己的链接/文字，混合 `ol/ul` 保持文档顺序 | 旧实现父 li 回归失败；修复后 NAV 12/12（含 XML 直接嵌套 li） | 是 |
| `src/core/book.ts`、`src/test/book.test.ts` | 更新 | 导出 `resolveTocHrefs`；仅在 nav/NCX 基准文档属于 spine 时绑定 `#`/`#id`，无上下文 fragment/外部/空 href 仍禁用 | book 14/14 | 是 |
| `src/ui/TocPanel.tsx`、`src/ui/TocPanel.helpers.test.ts`、`src/App.tsx` | 更新/新增 | 目录递归统计为“项”；按 fragment 精确、章首、同路径顺序返回唯一节点引用，App 传递当前 path+anchor，避免同 XHTML 多项同时高亮 | Toc helper 3/3、TypeScript 通过 | 是 |
| `docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md` | 更新 | 登记 B-043/C-36、验证边界和 NAV 原本已被正确识别的结论 | 目标 EPUB 1280×800 Chromium：`.toc-count`=`334 项`、`.toc-item`=334，缩进 8/22/36px；正确 `12.4.1`、错误 NCX `14.1`=0；根目录无 disabled、点击后 iframe 有 `nav#toc`、12.4.1 唯一高亮并到 Chapter12-4 第 2/21 页；`iframe :target` 不作为本项断言；整组全量 34 文件 304 测试、tsc、build 通过 | 是 |

## B-044 UA 默认 margin 来源门控

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/paginator.ts` | 更新 | 新增当前生效 inline/CSSOM 的水平 margin 来源判断；L3 auto margin 临时移除后，明确 UA-only computed margin 跳过 C-04，作者/用户与未知来源保持原路径；涵盖 physical/logical/shorthand，customCss 仍可生效。仅 non-percentage、nonzero/unknown computed margin 的 C-04 候选扫描样式表，零/auto 直接子及 C-16 百分比路径不产生 O(children×rules) 新开销 | 新 B-044 回归在旧实现 4 项失败；修复后 paginator 54/54。目标 EPUB 8.6.5 Chromium：1280×800 两个 blockquote 均 width640/margin312/312、无 fixed，三段严格在每列 40rem；900×650 均 width640/margin122/122、无 fixed，后代无越块。B-023/B-024/Sumeragi 实书回归保持；整组全量 34 文件 304 测试、tsc、build 通过 | 是 |
| `src/render/paginator.test.ts` | 更新 | 覆盖 inline 注释、shorthand/logical、匹配/不匹配规则、当前 media/supports、未知 grouping/不可读 CSSOM、reader customCss、false/true/unknown 补偿门、zero/auto 与 C-16 百分比不扫描边界 | paginator 54/54 | 是 |
| `docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md` | 更新 | 登记 B-044/C-37、UA blockquote 40px 根因、保守边界、验证状态与不按标签特判的约束 | 文档与实现术语核对；目标 EPUB Chromium、相邻实书回归、全量 34 文件 304 测试、tsc、build 已完成；Windows WebView2 待用户 | 是 |

## B-045 UA 对称 margin 语义保留

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/paginator.ts` | 更新 | B-044 来源门控之后，新增 `getReaderTopUaSymmetricInsetMaxWidth()`：仅 reader-top、明确 UA-only、非 float/fullpage/百分比且 computed 左右 margin 有限非零对称时，将 border-box 减去双侧 inset 并按 box-sizing 写入临时 max-width；L3 auto margin 继续负责居中，写回纳入现有 marginFixes 恢复 | 新回归旧实现 1 项失败；修复后 paginator 55/55。目标 EPUB Chromium 1280×800 两个 blockquote width/max-width 560px、margin 352/352，每个 fragment 宽 560 且逐列居中；900×650 width 560、margin 162/162、无后代越界 | 是 |
| `src/render/paginator.test.ts` | 更新 | 覆盖 640+40/40→560、窄视口包含块限制、作者 margin、非对称、float、fullpage、百分比、非 reader-top、零 margin 不触发 | paginator 55/55；全量 Vitest 34 文件 305/305 | 是 |
| `docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md` | 更新 | 单列 B-045/C-38，明确 B-044 只消除右移却吞掉 UA 双侧语义；记录 C-38 的层级、生命周期和非目标边界 | B-041 3.1 图文容器、B-042 opacity float、B-043 12.4.1 NAV、B-023 赤月、B-024 玩具堂、Sumeragi WSL Chromium 回归；全量 Vitest 305/305、tsc、pnpm build（95 modules）通过；Windows WebView2 待用户 | 是 |

## 不属于同步变化

以下内容是本地依赖、构建或测试产物，不应复制进真实源仓：

- `node_modules/`
- `dist/`
- `.pnpm-store/`
- `.pw-browsers/`
- `.pw-libs/`
- `src-tauri/target/`、`src-tauri/target2/`、`src-tauri/gen/`
- `targettmp/`
- `.img-repro.png`
- `.tmptsx/`
- `scripts/repro-redmoon.mjs`（本地实书复现脚本，不属于产品运行时）
- `<PROJECT_ROOT>/测试用epub/` 中的本地测试书
- 一次性截图、日志和临时复现输出

## 后续更新规则

每次完成一项可同步改动后，在“当前未同步变化”中记录：

1. 文件路径；
2. 行为变化与修改原因；
3. 本地验证命令和结果；
4. 是否建议同步；
5. 若是 Bug，关联 `BUGFIX_LOG.md` 的编号。

用户确认已经同步后：

1. 更新新的源仓提交哈希；
2. 从“当前未同步变化”移除已同步项；
3. 在下方追加一次同步历史；
4. 保留未同步的本地实验项。

## 同步历史

- **2026-08-17 `0.1.5` 发布同步**：提交 `4bb9c7b2e50ef3a13f2cc8cd06d91c25486911b7`，标签 `v0.1.5`；用户确认已在 Windows 编译、打包并分发。
- **2026-08-17 `0.1.5` 文档收尾**：提交 `e349ab50e1a98f893c8de07dcc84fcf86f95f77d`，作为 0.1.6 开发阶段的起始基线。
- **2026-08-17 `0.1.6` 导入与进度**：提交 `323ea717451c1f05cfcb6e5c677550bca85e96a8`，同步 B-020/B-021、内容判重、批量导入优化和进度写入器。
- **2026-08-17 公开仓库准备**：提交 `09a995811a5adf7d9e8c8d765791ff2d45cf9883`，增加 MIT License 并泛化本机路径。
- **2026-08-18 `0.1.6` 功能提交**：提交 `d934588b6518dca819e72d2f129a68225cba6592`，同步书签、自定义字体/CSS、阅读历史返回、封面回退、B-022 和 0.1.6 版本元数据。
- **2026-08-18 `0.1.6` IPC 修复**：提交 `e8aabcdeb03543402338aee00fb2e33d52e39841`，把 Tauri 不支持的 `u128` 书架时间参数改为 `u64`；`main`、`origin/main`、`v0.1.6` 均指向该提交。

## B-046/C-31/C-39：顶层浮动布局单元与完整百分比组版心限宽

| 文件 | 状态 | 变更摘要 | 验证 | 是否同步 |
|---|---|---|---|---|
| `src/render/paginator.ts`、`src/render/paginator.test.ts` | 更新 | 所有顶层 left/right float 先进入 C-31 防火墙，安全单项按40rem投影并保留作者 margin，复杂单项保持原布局且不进入 C-04/C-18；新增独立 `floatLayoutFixes` 生命周期；安全完整百分比组按 40rem 版心写入本轮 px width/首项 inset，几何验收失败整组恢复；覆盖复杂回退、优先级恢复和 C-08 隔离 | paginator 62/62；全量 Vitest 34 文件 312/312；`tsc --noEmit`、`pnpm build`（95 modules） | 是 |
| `docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-046/C-39、两阶段 float 方案、无 DOM wrapper、复杂组保守回退、生命周期/防火墙契约及 Chromium 实测 | 3.4.4 1280/900、字号 16→20→16、金木犀双视口及相邻书 smoke 通过；Windows WebView2 待用户 | 是 |

## B-047/C-40：显式对称居中作者 margin 的通用门控

| 文件 | 状态 | 变更摘要 | 验证 | 是否同步 |
|---|---|---|---|---|
| `src/render/paginator.ts` | 更新 | 新增 `hasAuthoredSizingIntent` 与 `shouldKeepCenteredAuthorMargins`；在 C-31/C-16/C-18/C-38 后、C-04 前，仅对作者来源明确、无 sizing intent 的对称 `text-align:center` 普通顶层盒保留自然居中；固定/unknown/非对称/percentage/float/fit/fullpage 保守走原路径；reader 内建 `max-width:40rem` 不算作者 sizing | paginator 64/64；目标目录 1280/900 与字号 16→20→16 Chromium 同轴；B-024/B-045/C-18/B-023/B-046/金木犀回归 | 是 |
| `src/render/paginator.test.ts` | 更新 | 增加 C-40 门控与 sizing provenance 回归：center/left、固定/min/max、percentage/negative/zero/auto/unknown、float、fit/fullpage、不可读 CSSOM、reader default/custom CSS 与重排生命周期 | 定向 64/64；全量 Vitest 34 文件、314/314 | 是 |
| `docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-047/C-40 根因、C-04 边界、来源保守策略、B-024 对比、Chromium/全量验证与 Windows 待确认项 | `tsc --noEmit`、`pnpm build`（95 modules）通过；无 Rust 改动，临时脚本已清理 | 是 |

## B-048/C-41：链接书库 `cover.webp` 封面候选统一

| 文件 | 状态 | 变更摘要 | 验证 | 是否同步 |
|---|---|---|---|---|
| `src-tauri/src/linked_library.rs` | 更新 | Rust 原生链接导入保留有序 manifest，统一 EPUB3 `cover-image`、EPUB2 meta 和精确 `cover.*` href fallback；候选去 query/fragment、URL 解码/规范化、验证图片类型与 ZIP 条目存在，删除 `id.contains("cover")` 模糊匹配 | Rust 13/13、`rustfmt --check`、`cargo check --quiet` 通过；仅 `ZipArchive::by_name` 查询中央目录，不解压/解码/全 ZIP 扫描/额外哈希 | 是 |
| `src/core/book.ts`、`src/test/weirdBooks.test.ts` | 更新 | 浏览器预览使用同一候选顺序和有效性边界；manifest 资源路径去 query/fragment，新增失效标准声明继续回退 URL 编码 `Cover.WEBP` 的合成 EPUB 回归 | 新回归旧实现失败；全量 Vitest 34 文件、315/315，`tsc --noEmit`、`pnpm build`（95 modules）通过 | 是 |
| `docs/tasks/active/cover-fallback-contract.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/version-0.1.7-release-candidate.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-048/C-41：发行版差异来自 Rust 原生链接导入而非 WebView2/WebP 解码；低成本 O(manifest + 少量 by_name) 路径、旧库不迁移、重复导入刷新 binding 且保留进度 | 文档/契约核对；未启动 Chromium/Vite，Windows 发布包真实 `cover.webp` 导入待用户确认 | 是 |

## B-049：设置数值步进边界与阅读器重载

| 文件 | 状态 | 变更摘要 | 验证 | 是否同步 |
|---|---|---|---|---|
| `src/ui/settingsStepper.ts`、`src/ui/settingsStepper.test.ts` | 新增 | 纯数值有序步进按可见默认值处理 `undefined` 自动档；方向减/加分别取最近较小/较大值，超界 clamp；自动档若候选等于可见默认值则保持 `undefined` | 新回归旧实现 3 项失败；修复后设置步进 4/4 | 是 |
| `src/App.tsx` | 更新 | 行高、字重、字间距、字符间距改用纯数值档位；真实变化返回新 settings identity，边界 no-op 返回原对象；字号和 direct slider change 同步 clamp/避免无效更新，沿用 B-040 的 150ms reload debounce | 相关定向 7/7；全量 Vitest 35 文件、319/319；`tsc --noEmit`、`pnpm build`（96 modules） | 是 |
| `docs/tasks/active/settings-stepper-bounds.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/PROJECT_CONTEXT.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-049 根因、自动档可见默认值、identity/reload no-op 契约和验证边界；rendering-layers 无变化 | 文档与实现术语核对；WSL Chromium 真实点击确认有效步进各新增一次 iframe load，行高上下界与字间距下界额外点击均保持值和 load 计数；Vite/Chromium 已停止，5173/5174 未监听 | 是 |

## 0.1.8 测试发布候选收口

| 文件 | 状态 | 变更摘要 | 验证 | 是否同步 |
|---|---|---|---|---|
| `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 更新 | 四处产品版本统一提升为 0.1.8；Cargo.lock 仅修改 `epub-reader` 根包，不改同版本依赖 | 四处版本一致；Cargo metadata 识别 `epub-reader@0.1.8`；Rust 13/13、fmt/check 通过 | 是 |
| `docs/RELEASE_0.1.8.md`、`docs/tasks/active/version-0.1.8-release-candidate.md`、`docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 建立 0.1.8 当前发布入口、WSL→Windows 备份式干净同步命令、排除项、构建产物路径和 WebView2 验收矩阵；0.1.7 文件保留为阶段历史 | 文档路径/命令核对；Vitest 35 文件 319/319、tsc、Vite build（96 modules）通过 | 是 |

## 0.1.9 测试发布候选收口

| 文件 | 状态 | 变更摘要 | 验证 | 是否同步 |
|---|---|---|---|---|
| `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 更新 | 四处产品版本统一提升为 0.1.9；Cargo.lock 仅修改 `epub-reader` 根包 | 四处版本一致；Cargo metadata 识别 `epub-reader@0.1.9`；Rust 19/19、fmt/check 通过 | 是 |
| `docs/RELEASE_0.1.9.md`、`docs/tasks/active/version-0.1.9-release-candidate.md`、`docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 建立 0.1.9 发布入口、Windows 备份式干净同步命令、构建产物路径和重点验收矩阵；0.1.8 文件保留为阶段历史 | 文档路径/命令核对；Vitest 52/407、tsc、Vite 110 modules、Rust fmt/check/test 通过 | 是 |

## 0.1.9-beta.1 修复测试版

| 文件 | 状态 | 变更摘要 | 验证 | 是否同步 |
|---|---|---|---|---|
| `src/styles.css`、`src/ui/menuPanel.test.ts` | 更新 | B-067：阅读器菜单预留稳定纵向滚动槽，详细设置展开前后卡片宽度保持一致 | 菜单契约 8/8、tsc；Windows WebView2 视觉待 beta.1 验收 | beta.1 |
| `src/core/search.ts`、`src/core/search.test.ts` | 更新 | B-068：搜索章节改为 XML/XHTML 优先、解析失败回退 HTML，修复 Windows WebView2 可能因自闭合标签误解析而提取空正文 | 新增 2 项解析回归；全量 Vitest 52/410、tsc、Vite 110 modules | beta.1 |
| `src/render/textAnchor.ts`、`src/render/paginator.ts`、`src/ui/ReaderView.tsx`、`src/ui/ReaderContextMenu.tsx`、`src/App.tsx` 及相关测试 | 更新 | B-069：选区菜单以末端片段定位，iframe selectionchange 更新坐标或关闭，宿主关闭同步清除选区 | 定向 3 files/16；全量 Vitest 52/411、tsc、Vite 110 modules | beta.1 |
| `src/styles.css`、`src/ui/SearchPanel.test.ts` | 更新 | B-070：隐藏 WebView2 原生 search 清除装饰；长查询保持单行内部滚动并预留自定义按钮空间 | SearchPanel 7/7；全量 Vitest 52/414、tsc、Vite 110 modules | beta.1 |
| `src/ui/readerForeground.ts`、`src/ui/readerForeground.test.ts`、`src/App.tsx`、`src/styles.css` | 新增/更新 | B-071/C-52：单一前台判别联合替代九组独立状态；panel/transient/modal 分层互斥，字体作为菜单子视图，modal 全窗口遮罩 | 状态契约 6/6；全量 Vitest 53/420、tsc、Vite 111 modules | beta.1 |
| `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`docs/RELEASE_0.1.9-beta.1.md` | 新增/更新 | 四处版本统一为 `0.1.9-beta.1`，建立 Windows 核心搜索修复测试入口 | 版本与 Cargo metadata 核对 | beta.1 |

## 0.1.9-beta.2 测试版

| 文件 | 状态 | 变更摘要 | 验证 | 是否同步 |
|---|---|---|---|---|
| `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`docs/RELEASE_0.1.9-beta.2.md` | 新增/更新 | 四处产品版本统一为 `0.1.9-beta.2`，建立包含 beta.1 修复和 C-53～C-56 的 Windows 测试发行入口 | 四处版本与 Cargo metadata 核对 | beta.2 |
| `docs/tasks/active/shelf-library-search-pipeline.md` | 更新 | 登记用户观察到并发超过 8 后收益不明显；后续只调查 1/2/4/6/8/12/16 的阶段耗时和资源指标，当前不优化流水线、不提高自动推荐值 | 计划边界与现有并发实现核对 | beta.2 |
| `docs/SEARCH_TO_RAG_ROADMAP.md`、`docs/AI_PLUGIN_ARCHITECTURE.md` | 更新 | 将当前阶段明确为第二阶段基础全文搜索的 beta2 Windows 验收/收尾；补正 C-54/C-56 已完成的 trigram、短查询、真实建库、共享运行时和 Rust FTS 状态，模型管理/Embedding/向量仍未开始 | 与 C-53～C-56 代码、任务和 beta2 范围核对 | beta.2 |

## 推荐比较命令

仅用于只读核对，不执行复制：

```bash
diff -qr \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=target \
  --exclude=target2 \
  --exclude=gen \
  --exclude=.pnpm-store \
  --exclude=.pw-browsers \
  --exclude=.pw-libs \
  --exclude=.git \
  <PROJECT_ROOT>/eupb-read \
  <PROJECT_ROOT>/epub-reader
```

## 开源协议切换（2026-08-21）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `LICENSE` | 替换 | 由 MIT License 切换为 **Apache License 2.0**（官方原文，202 行），用户选择以防潜在纠纷 | 与 apache.org 官方文本逐字比对 | 是 |
| `NOTICE` | 新增 | Apache 2.0 规范建议的 NOTICE 文件，声明 Copyright 2026 HeRenFor | 人工检查 | 是 |
| `README.md` | 更新 | 许可章节由 MIT 改为 Apache License 2.0 | 链接检查 | 是 |

## 第三方许可合规与发行包落地（草案已存在，暂时搁置）

状态：**网络波动前启动的许可材料修改在 2026-08-22 交接文档首次更新后延迟落盘。下表文件现在实际存在，但只视为待审草案：尚未完成目标 Windows 二进制的逐包传递依赖/版权/NOTICE 审计，也未验证 NSIS 与免安装包实际携带材料。等待进一步补充后再恢复，当前不得标记为正式完成。**

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `THIRD_PARTY_LICENSES.md` | 已新增、待审 | 草案列出主要运行时/开发依赖、MPL-2.0 五个 crate、r-efi 多许可选择、部分版权声明和许可证文本索引 | 文件存在；逐包传递依赖/版权/NOTICE 完整性未验收 | 完整复核后再同步 |
| `third-party-licenses/` | 已新增、待审 | 草案收录 Apache-2.0/MIT/MPL-2.0/BSD-2/BSD-3/ISC/Zlib/Unicode-3.0/CC-BY-4.0 九份文本 | 9 个文件存在；上游原文逐字复核尚未收口 | 完整复核后再同步 |
| `NOTICE` | 已更新、待审 | 已加入 Tauri Programme 与第三方清单入口 | 文件存在；上游 NOTICE 归属是否齐全未验收 | 完整复核后再同步 |
| `src-tauri/tauri.conf.json` | 已更新、待实包验证 | 已配置 `bundle.license` 和许可材料 `resources`，尚未配置 `licenseFile` | JSON/schema 尚需随整组复核；NSIS/免安装包未验证 | Windows 实包验证后再同步 |
| `package.json` | 已更新、待审 | 已增加 `"license": "Apache-2.0"` | 字段存在；整组尚未验收 | 完整复核后再同步 |
| `src-tauri/Cargo.toml` | 已更新、待用户确认 | 已增加 `license = "Apache-2.0"`，authors 改为 `HeRenFor` | 字段存在；权利人表述待用户确认 | 用户确认后再同步 |
| `README.md` | 已更新、待审 | 已声明第三方组件遵循各自许可证并链接第三方清单 | 链接目标存在；内容完整性未验收 | 完整复核后再同步 |
| `CONTRIBUTING.md` | 已更新、待用户确认 | 已增加 Apache-2.0 入站贡献条款 | 条款存在；措辞待用户确认 | 用户确认后再同步 |
| `LICENSE` | 已调整权限 | 当前权限已为 644 | `ls -l` 已确认 | 随整组材料同步 |

## B-050：打开期阅读进度链修复（2026-08-22）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/ui/readEvidence.ts`、`src/ui/ShelfView.tsx`、`src/ui/shelf.ts` | 更新/新增 | 将已读位置证据与暂时的整数百分比分离；书架继续阅读/读过判定兼容 isNew、页码、章节和文本/legacy anchor；成功 progress patch 和 IndexedDB update 自动清除 isNew | shelf 定向通过 | 是 |
| `src/ui/chapterCounts.ts`、`src/ui/chapterCountJob.ts`、`src/ui/chapterCountCache.ts` | 更新/新增 | 统计失败保持 error/unknown；结构 provisional 纯媒体章节按 1000 字/媒体单元保守计数，当前 measured 媒体章按 `pageCount * 1000`；job 默认每 slice 最多 4 章并带 100ms timeout；结构 estimated counts 按 `contentHash ?? shelfId` 使用版本化有界本机缓存，最多 256 entries/100000 counts，非 estimated 结果 merge-preserve 旧结构估算，缓存不进入 archive | 定向 Vitest 48/48；全量 Vitest 36/332、tsc、Vite 98 modules、Rust 14/14 + fmt/check 通过 | 是 |
| `src/render/textAnchor.ts`、`src/render/paginator.ts`、`src/ui/ReaderView.tsx`、`src/App.tsx` | 更新 | measured anchor 暴露媒体单元；当前无可见文字媒体章按页数权重计分；状态栏区分计算中/约/精确；最后 linear 章末页才显式 100%；打开/隐藏/返回书架安全边界保存 cache；未改变 setPage emit/capture 顺序 | 定向 Vitest 48/48；全量 Vitest 36/332、tsc、Vite 98 modules 及 Rust 14/14 + fmt/check 通过；未启动长期 Vite/Chromium | 是 |
| `src/ui/progressWriter.ts`、`src/ui/libraryArchive.ts`、`src-tauri/src/linked_library.rs` | 更新 | writer 增加 beginSession；portable merge 先按阅读证据再按 lastRead 时间；新导入 lastRead=0；Rust/浏览器成功进度写入清 isNew | progress/archive 定向；Rust 14/14、`cargo fmt --check`、`cargo check --quiet`、`cargo test --quiet` 通过 | 是 |
| `docs/tasks/active/reading-progress-open-session.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-050、缓存/统计/显示/存档/会话契约和最终验证边界 | 文档链接/术语已自检；全量 Vitest 36/332、tsc、Vite 98 modules、Rust 14/14 + fmt/check 通过；Windows WebView2/发布包待用户确认 | 是 |

## B-051：首次白屏加载期间丢弃翻页意图（2026-08-22）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/ui/turnIntent.ts`、`src/ui/turnIntent.test.ts` | 更新 | 增加每本书生命周期 `displayedOnce` 初始门；首次 display-ready 前 request 完全丢弃，首次 ready 不回放 pending；首次 ready 后仍保留跨章 loading 的最后方向单槽并消费一次；reset 保留已显示历史 | turnIntent 9/9；全量 Vitest 36/334；tsc 通过 | 是 |
| `src/ui/ReaderView.tsx` | 更新 | 首次 display-ready 解锁后清理外层 `WheelTurnAccumulator` 未达阈值累计；不改变 paginator/CSS/显示门顺序，书籍 `key={bookKey}` 重建自然复位 | `tsc --noEmit`；未启动长期 Vite/Chromium | 是 |
| `docs/tasks/active/initial-turn-intent-gate.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-051、首次加载输入丢弃契约、跨章持续滚轮保留行为和 Windows WebView2 风险 | 文档/术语自检；用户审核与实机输入待确认 | 是 |

## B-052：Ctrl/Cmd+A 宿主选择守卫（2026-08-22）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/selectionGuard.ts`、`src/render/selectionGuard.test.ts` | 新增 | 提供 DOM 键盘选择守卫与 document selection 清理；只拦截非编辑区域 A/a + Ctrl/Meta，编辑控件及后代放行 | selectionGuard 3/3 | 是 |
| `src/App.tsx`、`src/render/paginator.ts` | 更新 | App 宿主和 iframe keydown 共用守卫；命中后 preventDefault、清理对应 selection；进入 reader 的 view/bookKey 生命周期清理一次宿主旧 selection，不影响方向键或章节重排 | 定向含 paginator 76/76；全量 Vitest 37/337、tsc、Vite 99 modules 通过 | 是 |
| `docs/tasks/active/selection-shortcut-guard.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-052、宿主/iframe 选择契约、编辑控件放行边界和 WebView2 风险 | 文档/术语自检；用户审核与实机 selection 待确认 | 是 |

## B-053/C-42：深色主题章节局部对比度保守修正（2026-08-22）

WSL Chromium 1280×800 已实机确认目标书 `[简][雨穴].诡屋.02` 资料⑤：light 模式 body/box/p computed color 均为 `rgb(26,26,26)`，box 背景为 `rgba(255,255,255,0.8)`；dark 模式 body 为 `rgb(212,212,212)`，box/p 均为 `rgb(26,26,26)`，box 背景保持 `rgba(255,255,255,0.8)`。Vite 验证后已 Ctrl-C 释放 5173 端口；临时 `/tmp/repro-dark-dialog.mjs` 不同步。自动化最终为全量 Vitest 38 文件/341 用例、tsc、Vite 100 modules，通过；Windows WebView2 仍待用户确认。

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/darkThemeContrast.ts`、`src/render/darkThemeContrast.test.ts` | 新增 | 解析 RGB/RGBA/hex，递归合成有效背景并计算 WCAG contrast；按 html→body 单次 DFS 每元素读取一次样式，只修正接近 dark theme 前景且候选 `#1a1a1a` 显著改善的元素，保守跳过背景图/未知/opacity/作者不同色分支，支持背景容器继承 | darkThemeContrast 4/4；paginator 定向合计 68/68；全量 Vitest 38/341 | 是 |
| `src/render/paginator.ts` | 更新 | iframe load 后、首次 prepare/measure 前只运行一次 dark contrast 修正；显示门仍 hidden，marker 随文档自然销毁，不参与翻页/reflow | `tsc --noEmit`、Vite 100 modules；全量 Vitest 38/341；未启动长期 dev server | 是 |
| `docs/tasks/active/dark-theme-contrast-guard.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-053/C-42、目标资料⑤ 对比度证据、单次 DFS 读取约束、保守边界和 Windows WebView2 风险 | 文档/术语自检；用户审核与实机主题矩阵待确认 | 是 |

## B-054/C-43：iframe 脚注 marker 与宿主弹层 hover 交接（2026-08-22）

WSL Chromium 640×480 已实机确认目标书后记第二页 `note_ref020` 的交接：marker iframe `x=37.0..51.4`、宿主卡片 `x=59.4..359.4`，中间 8px gap；marker→card 12 步移动后 250ms 弹层仍 present，`MutationObserver added=1 removed=0`；离开两域 300ms 后 `added=1 removed=1`，恰好关闭一次，页码保持 `2/3`。验证后已 Ctrl-C 释放 5174 端口；临时 `/tmp/repro-footnote-flicker.mjs` 不同步。自动化最终为 39 文件/345 用例、tsc、Vite 101 modules，通过；Windows WebView2 仍待用户确认。

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/footnoteHoverGate.ts`、`src/render/footnoteHoverGate.test.ts` | 新增 | 140ms 可注入 close grace；marker/overlay 任一进入取消 timer，两者均离开且未 pinned 才单次关闭，重复 leave 不堆 timer；reset/dispose 清理 | gate 4/4；定向合计 84/84；全量 Vitest 39/345 | 是 |
| `src/render/footnotes.ts`、`src/render/footnotes.test.ts` | 更新 | 新增 `getFootnoteHoverAnchor`，只有当前文档内确认的脚注 anchor 才能触碰 gate；普通正文/非脚注 mouseover 返回 null 并保持 pending close | footnotes 定向 10/10；定向合计 84/84 | 是 |
| `src/render/paginator.ts`、`src/ui/ReaderView.tsx`、`src/App.tsx` | 更新 | Paginator 在有效脚注 hover/show/pinned/dismiss/load cleanup/dispose 同步 gate；普通正文 mouseover 不触碰 gate；ReaderHandle 转发宿主 overlay hover，App 同步 ref；同一仍 visible marker 不重复解析/发送 payload | `tsc --noEmit`；全量 Vitest 39/345；Vite 101 modules | 是 |
| `src/ui/FootnotePop.tsx` | 更新 | useLayoutEffect 仅在 offsetWidth/Height 实际变化时提交 size state，避免 rect 更新造成冗余渲染 | 定向脚注相关 84/84 | 是 |
| `docs/tasks/active/footnote-hover-grace.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-054/C-43、跨 iframe/host hover 时序、固定注释边界和 WebView2 风险 | 文档/术语自检；用户审核与实机 hover 待确认 | 是 |

## B-055/C-44：极窄窗口脚注弹层完整可见（2026-08-22）

Root 独立验收已完成：`pnpm exec vitest run` 全量 40 files/353 tests、`tsc --noEmit`、`pnpm build`（Vite 102 modules）通过。WSL Chromium 在 Tauri minWidth 对应 640×480 下验证目标书 `[简][初鹿野創].有谁规定了在现实中不能有恋爱喜剧的？.03` 后记第 2/3 页 `note_ref020`：`.main` rect=`0,42,640x417`，card rect=`59.40625,50,300x295.421875`，`fullyInside=true`；card `clientHeight=293`、`scrollHeight=293`，无截断/内部滚动。marker→card 250ms 为 `added=1 removed=0`，离开两域 300ms 后 `added=1 removed=1`，C-43 未回归。临时 5174 已停止，5173/5174 无监听。

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/ui/footnotePlacement.ts`、`src/ui/footnotePlacement.test.ts` | 新增 | 纯函数按 `.main` 尺寸与实际 card 尺寸计算有限非负 left/top/cardWidth/maxHeight，覆盖右/左、上/下、空间较大方向 clamp、极窄和容器不足 | placement 8/8；定向合计 92/92；全量 Vitest 40/353 | 是 |
| `src/ui/FootnotePop.tsx`、`src/App.tsx` | 更新 | 弹层移入 `.main` 统一 payload 坐标系；使用真实 client/offset 尺寸，ResizeObserver/resize listener 只在变化时更新并 cleanup，保持 z-index 60 | `tsc --noEmit`；全量 Vitest 40/353；Vite 102 modules | 是 |
| `docs/tasks/active/footnote-placement-narrow-window.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-055/C-44、640×480/UI scale 边界、坐标系和完整可见契约；补 root 独立 Chromium/构建验收 | `pnpm exec vitest run` 40/353、`tsc --noEmit`、`pnpm build` 102 modules；5173/5174 无监听；Windows WebView2 待用户确认 | 是 |

## B-056/C-45：深色主题文字阴影可读性兜底（2026-08-22）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/sanitize.ts` | 更新 | dark theme 的 `#epub-viewer` 根覆盖样式增加普通优先级 `text-shadow: 1px 1px 1px #1e1e1e`，依靠继承为浅色盒/复杂背景中的默认文字提供可读性兜底；不使用通配符或 `!important`，作者后代显式声明仍可覆盖 | sanitize 定向 54/54；Root 独立复验全量 40 文件/354 tests、tsc、Vite 102 modules 通过 | 是 |
| `src/render/sanitize.test.ts` | 更新 | 增加 dark 有、light/sepia 无、声明不含 `!important`/viewer 通配符强制规则，以及作者后代 `text-shadow:none`/特效正常保留的回归 | `src/render/sanitize.test.ts` 54/54 | 是 |
| `docs/tasks/active/dark-theme-text-shadow-fallback.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-056/C-45、仅 dark 注入/正常级联覆盖契约；Root 独立全量 40 文件/354 tests、tsc、Vite 102 modules 已复验，Windows WebView2 观感/长章节性能仍待用户 | 文档/术语自检；用户审核与实机主题/性能矩阵待确认 | 是 |

## B-057/C-46：强制横排以阅读竖排 EPUB（2026-08-22）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/render/settings.ts`、`src/ui/storage.ts`、`src/App.tsx`、`src/ui/ReaderView.tsx` | 更新 | 新增可持久化 `forceHorizontal`，App 初始化/写入/恢复默认/存档导入接入；ReaderView 保留现有 settings reload/锚点链路，并在 fixedLayout 有效设置中屏蔽 | 定向设置/固定版式 helper 通过；tsc 通过 | 是 |
| `src/ui/MenuPanel.tsx`、`src/styles.css`、`src/ui/menuPanel.test.ts` | 更新 | 详细设置加入“强制横排”开关，关闭显示“跟随书籍”、开启显示“竖排转横排”，保持既有菜单样式 | menu helper 定向通过 | 是 |
| `src/render/sanitize.ts`、`src/render/sanitize.test.ts` | 更新 | 仅 forceHorizontal 开启时对 html/body/viewer 及非 SVG 树普通后代注入标准/Chromium vendor horizontal writing mode 与 text orientation；不改 direction，SVG 显式写法可保留 | sanitize 55/55，覆盖根/嵌套竖排、关闭、SVG、主题无关 | 是 |
| `src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts`、相关测试 | 更新 | portable archive 白名单和 JSON 校验保留 forceHorizontal，不丢字段；旧 archive 继续兼容 | 存档/存储定向 16/16 | 是 |
| `docs/tasks/active/force-horizontal-reading.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/PROJECT_CONTEXT.md`、`docs/tasks/active/README.md` | 新增/更新 | 登记 B-057/C-46、fixedLayout/SVG 继承边界与用户审核风险 | 定向 73/73、helper 58/58；Root 独立全量 Vitest 42 文件/359 tests、tsc、Vite 102 modules 及 900×650 WSL Chromium `/tmp/vertical-smoke.epub` 烟测通过；临时 EPUB/脚本不入项目，Windows 实机待用户 | 是 |

## B-058/C-47：Windows 系统字体与独立字体中心（2026-08-22）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/ui/fontStore.ts`、`src/ui/fontRuntime.ts` | 更新/新增 | 增加 `system_fonts_list` 前端边界与单活动 imported Blob URL 懒加载控制器；系统字体不暴露路径，非 Windows 空列表；竞态、切换、失败和 dispose 处理 URL ownership | 字体 runtime 定向 3/3；Root 全量 Vitest 44 files/365 tests | 是 |
| `src/ui/FontSettingsPanel.tsx`、`src/ui/MenuPanel.tsx`、`src/styles.css` | 新增/更新 | 独立字体中心、system/imported tabs、搜索、导入/删除、loading/error/empty；按实际容器高度计算的固定行高虚拟窗口含 top/bottom spacer、overscan/clamp；tab/search 同步复位 DOM scrollTop；面板 z42、backdrop z41 | 虚拟窗口定向 2/2；WSL Chromium 300 imported 末尾可达 Font299，900×900 实测 viewportHeight=292/DOM rows=13，搜索后 scrollTop=0；z/hitInside 通过 | 是 |
| `src/App.tsx`、`src/render/settings.ts`、`src/ui/storage.ts`、`src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts` | 更新 | 接入 `fontSource`/`customFontId` storage/archive；启动只列 imported 元数据，系统字体仅首次打开枚举并会话缓存；缺失 system 偏好不后台清空 | Root WSL binary get=0（StrictMode metadata getAll=2）、选择后 get=1，source/imported/id=012b | 是 |
| `src/render/sanitize.ts` 及字体/存档/sanitize 测试 | 更新 | system 只写 family、不生成 @font-face；imported 只注入当前 Blob；family 字符串转义反斜杠、引号和 CR/LF/form-feed | `tsc --noEmit`、Vite build 104 modules、sanitize/字体/存档定向通过 | 是 |
| `docs/tasks/active/font-center-system-fonts.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/PROJECT_CONTEXT.md`、`docs/SOURCE_DELTA.md` | 新增/更新 | 登记 B-058/C-47、Windows DirectWrite/Android 预留、性能/虚拟列表/URL 契约、验证证据与 Windows 风险 | 文档链接与编号核对；临时脚本数据不入项目 | 是 |

## B-059/C-48：当前书正文基础搜索（2026-08-22）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/core/search.ts`、`src/core/search.test.ts` | 新增 | 按需按 spine 提取当前书可见正文，会话级缓存；NFKC/小写/软连字符/布局空白标准化，以紧凑字符串和 TypedArray 保留原文范围到既有 code-point 锚点的映射；排除隐藏结构与脚注，支持短语及同上下文多关键词 AND | 搜索核心 8/8，覆盖取消、缓存、surrogate/NFKC/紧凑映射和结果上限；全量 Vitest 46 files/377 tests | 是 |
| `src/ui/SearchPanel.tsx`、`src/ui/SearchPanel.test.ts`、`src/App.tsx`、`src/ui/Toolbar.tsx`、`src/styles.css` | 新增/更新 | 独立正文搜索面板、180ms debounce、进度/取消、最多 100 条显示、原文高亮；点击结果使用现有锚点和 3 步历史，同章 direct/跨章 display gate，fixed-layout 隐藏入口 | `tsc --noEmit`、Vite 106 modules；WSL Chromium 900×650 “opacity 属性”4 条结果、高亮及 back/forward 实测通过 | 是 |
| `docs/tasks/active/reader-text-search.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/PROJECT_CONTEXT.md`、`docs/SEARCH_TO_RAG_ROADMAP.md`、`docs/HANDOFF.md` | 新增/更新 | 登记 B-059/C-48 的首版范围、性能/生命周期/跳转契约，并在路线图第一阶段与第二阶段标出已经完成的当前书基础项；跨书、持久化索引、模糊/语义/RAG 保持未实现 | 文档状态与代码/测试证据核对；临时脚本、书籍和截图不入项目 | 是 |

## B-060/C-49：正文笔记首版（2026-08-23）

| 文件 | 类型 | 相较源文件的修改 | 验证 | 同步 |
|---|---|---|---|---|
| `src/render/textAnchor.ts`、`src/render/paginator.ts`、`src/render/sanitize.ts` | 新增/更新 | 捕获/解析 code-point 文本范围；当前章节 CSS Custom Highlight 下划线；自定义正文右键入口，不插入笔记 span | 定向 range/sanitize/paginator 129/129；Chromium 保存前后宽度不变 | 是 |
| `src/ui/notes.ts`、`src/ui/ReaderContextMenu.tsx`、`src/ui/NoteComposer.tsx`、`src/ui/NotesPanel.tsx`、`src/App.tsx`、`src/ui/ReaderView.tsx`、`src/ui/Toolbar.tsx`、`src/styles.css` | 新增/更新 | 笔记校验、菜单、编辑器、本书时间列表、编辑删除、文本锚点跳转与三步历史接线 | 前端全量 50 files/393 tests、tsc、Vite 110 modules；Chromium 真实链路 | 是 |
| `src/ui/shelf.ts`、`src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts`、`src-tauri/src/linked_library.rs`、`src-tauri/src/lib.rs` | 更新 | notes 进入浏览器/Tauri 书架记录和 portable archive，前后端边界校验，同 ID 按 updatedAt 合并 | Rust fmt/tests 18/18；存储/存档定向 32/32 | 是 |
| `docs/tasks/active/reader-notes.md` 及项目维护文档 | 新增/更新 | 登记 B-060/C-49 范围、性能、降级、同步和待 Windows 证据 | 文档与实现核对 | 是 |

## B-061/C-50：实验性相邻章节预渲染与详细设置视觉统一（2026-08-23）

| 文件 | 类型 | 相较源文件的修改 | 验证 | 同步 |
|---|---|---|---|---|
| `src/render/paginator.ts`、`src/ui/ReaderView.tsx`、`src/ui/readerViewSettings.test.ts` | 更新 | 增加最终 display-ready 可等待边界与最多三槽的前后相邻调度；后台回调 active-gate，严格先下一篇、后上一篇，React 顺序目标提交后提升并保留旧章反向缓存；显式跳转/未命中走 P0，设置/尺寸/生命周期失效释放；稳定阅读器容器承担 resize 监听 | 全量 51 files/402 tests、tsc；Chromium 第二章三 Blob 就绪，返回原 Blob 约 7ms | 是 |
| `src/render/settings.ts`、`src/ui/MenuPanel.tsx`、`src/App.tsx`、`src/ui/storage.ts`、`src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts`、`src/styles.css` 及测试 | 更新 | 默认关闭的“高性能模式”（内部旧字段兼容）；fixed-layout 禁用；本机设置与 portable archive 白名单接入；详细设置统一主题色浅卡片和 42×24 现代开关，纸色色块降低浓度；滑块 flex 子项允许收缩，开关标题不再继承滑块顶部 padding，控制卡统一同宽同高 | 菜单测试 7/7；Chromium 640×520 实测卡片 267×60、`+` 完整内收、开关无顶部空白 | 是 |
| `docs/PRELOAD_PLAN.md`、`docs/tasks/active/next-chapter-preload.md` 及维护文档 | 新增/更新 | 将 P1a/P1b 前后各一章标为已实现，动画保留为后续；记录调度优先级、显式跳转门、生命周期与 Windows 待验收边界 | 文档与实现核对；临时脚本/截图/测试书不入项目；5173 已释放 | 是 |

## B-062/C-51：书架筛选抽屉与 OPF 语言元数据（2026-08-23）

| 文件 | 类型 | 相较源文件的修改 | 验证 | 同步 |
|---|---|---|---|---|
| `src/ui/shelf.ts`、`src/ui/shelf.test.ts` | 更新 | 增加可选 language、作者 NFKC/CJK 空白规范化、语言归组、保存时间分段及单索引组合筛选/交叉计数；不改原 creator/title | shelf 17/17；全量 52/407 | 是 |
| `src/ui/ShelfView.tsx`、`src/styles.css`、`src/App.tsx`、`src/ui/shelfDrawer.test.ts` | 更新/新增 | 带 reduced-motion 的书架抽屉及迁移项；折叠选项不创建 DOM；书架不渲染顶部 Toolbar；B-063 填满滚动区，B-064/B-065 修复搜索间距及 SVG 视觉居中，B-066 预留稳定滚动槽 | Chromium 完整交互；搜索 SVG 中心偏差0；展开前后滚动区379px/卡片347px保持不变；CSS契约2/2 | 是 |
| `src/core/opf.ts`、`src-tauri/src/linked_library.rs` | 更新 | 浏览器/Rust 均取首个非空 dc:language；Rust 记录 serde default 兼容旧 JSON，新导入持久化并返回 language | Rust fmt；19/19 | 是 |
| `src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts` 及测试 | 更新 | portable archive v1 增加可选 language，解析、投影与本机字段隔离保持兼容 | archive/import 定向 42/42；tsc/Vite | 是 |
| `docs/tasks/active/shelf-filter-drawer.md` 及维护文档 | 新增/更新 | 登记数据、性能、动画、可访问性、旧记录降级与 Windows 待验收边界 | 文档与实现核对；临时产物不入项目，5173 已释放 | 是 |

依赖/许可核对：Windows target `windows` 0.61.3 记录为 MIT OR Apache-2.0，无 GPL；DirectWrite 为 Windows 系统 API。Android 本轮只预留接口。Linux 环境无法替代 Windows target，必须在 Windows 主机运行 cargo check/tauri build 与实机枚举。

## 搜索到 RAG 的长期方向文档（2026-08-22）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `docs/SEARCH_TO_RAG_ROADMAP.md` | 新增 | 独立记录正文语料/全文搜索、模型管理、语义索引、混合检索、建议标签、智能书架、带引用 RAG 与分层总结的阶段清单；明确智能检索与分类是实现目标，AI 总结是最终目标 | 文档结构与用户确认方向核对；当前无代码实现、无运行测试 | 是 |
| `docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`、`docs/SOURCE_DELTA.md` | 更新 | 增加长期路线入口，并明确其不属于 0.1.8、不得误判为已实现功能 | 链接与状态措辞核对 | 是 |

2026-08-23 方向补充：`docs/SEARCH_TO_RAG_ROADMAP.md` 增加插件化与发行路径，确定基础搜索核心常驻、智能检索/分类与生成式 AI 分层可选；能力插件和模型包分离，首版只采用项目维护的内建 Provider、受控 sidecar 和 HTTP Provider，不开放任意 DLL/JS 动态代码插件。文档同时明确现有 `SearchResult` 只是上游数据预留，AI Provider 注册表、capability manifest、模型运行时和向量数据库仍未实现。

## RAG 可选能力模块预备路线细化（2026-08-23）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `docs/AI_PLUGIN_ARCHITECTURE.md` | 新增 | 明确 RAG 位于同一仓库/应用但保持可选隔离；固定三层边界、Provider/capability、稳定 chunk/引用、独立缓存、任务生命周期和 UI 接入契约 | 文档与当前 `SearchSession`、contentHash、ReaderForeground、Tauri command 结构逐项核对；无代码实现 | 是 |
| `docs/tasks/active/rag-plugin-foundation.md` | 新增 | 将预备阶段拆成可执行顺序和验收清单；明确只使用 mock Provider 建立地基，暂不接真实模型、API、聊天或公开动态插件 | 范围与路线图交叉核对 | 是 |
| `docs/SEARCH_TO_RAG_ROADMAP.md`、`README.md`、`docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`、`docs/tasks/active/README.md` | 更新 | 注册同项目内可选模块方向，区分现有当前书搜索、预备阶段和长期生成目标；README 同步当前功能、测试基线和路线入口 | Markdown 链接、状态用语和 0.1.9-beta.1 基线检查；本轮仅文档，无运行测试 | 是 |

## C-53：RAG 可选能力模块地基（2026-08-23）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/core/corpus.ts`、`src/core/chunking.ts`、`src/core/search.ts` 及测试 | 新增/更新 | 抽离搜索共享的 XML-first 可见语料层；区分正文/标题/目录/版权/脚注等类型，NFKC/空白规范化，按结构/句子确定性切块，保存版本、稳定 chunkId 和 paginator-compatible 文本锚点；搜索结果契约保持 | corpus/chunk/search 定向 19；全量 Vitest 58/443、tsc | 是 |
| `src/features/ai/contracts`、`registry`、`lifecycle` 及测试 | 新增 | embedding/generation/reranking Provider、manifest、健康/隐私/取消/异步释放、项目内注册表和惰性 runtime；mock 确定性、本地且不联网 | Provider/runtime 覆盖注册冲突、取消、factory/health/dispose 异常及序列化生命周期；全量 58/443 | 是 |
| `src/features/ai/ui/AiFoundationPanel.tsx`、`src/ui/aiEntry.ts`、`src/ui/readerForeground.ts`、`src/ui/Toolbar.tsx`、`src/App.tsx`、`src/styles.css` 及测试 | 新增/更新 | assistant 纳入单一前台仲裁；仅 DEV 显示“AI 地基”，显式启用才创建 mock，关闭/卸载等待释放；不调用 Rust/SQLite | release/dev 可见性、前台互斥和 runtime 测试；Vite production 120 modules | 是 |
| `src-tauri/src/ai`、`src-tauri/src/lib.rs`、`src-tauri/src/linked_library.rs`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 新增/更新 | 独立 `<app-data>/ai/ai.sqlite3` schema v1（books/chunks/jobs/provider_models）；任务状态/有限进度/取消/退出回收；单书/全库清理；删除书架记录前仅在 DB 已存在时清理，不删除源 EPUB | cargo fmt/check --locked；Rust 28/28 | 是 |
| `THIRD_PARTY_LICENSES.md`、RAG 架构/路线/任务及维护入口 | 更新 | 登记 C-53 实现状态、Windows 待验收边界和 rusqlite/libsqlite3-sys MIT、bundled SQLite Public Domain | 文档链接/状态核对；无 GPL 新依赖 | 是 |

2026-08-23 Windows 补验：PowerShell 自动验证完成前端测试、生产构建、Rust fmt/check 与 28/28 tests；用户完成人工开发面板检查并确认 C-53 阶段通过。PowerShell 5.1 的 UTF-8 JSON 读取和产物字符串扫描误报已在 `scripts/validate-windows-rag-foundation.ps1` 中改为严格 UTF-8及实际 DEV render gate 检查。

## C-54：SQLite FTS5 跨书全文检索（2026-08-23）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `docs/tasks/active/cross-book-fts-search.md`、RAG 路线与维护入口 | 新增/更新 | C-53 验收后固定下一阶段范围：schema v2、持久化 chunk、FTS5 跨书查询、真实建库任务、过滤、结果打开与稳定锚点跳转；明确不接模型/向量/生成 | 文档范围与现有 C-53/当前书搜索契约核对；代码实现进行中 | 是 |
| `src-tauri/src/ai/store.rs`、`src-tauri/src/ai/mod.rs`、`src-tauri/src/lib.rs` | 更新 | C-54 第一批：schema v2 增加检索元数据及 trigram FTS，v1 chunk 迁移；单书原子替换、1～2 字短查询、长查询 FTS、contentHash/contentType 过滤及 FTS 同步清理；注册索引/查询命令 | Rust 32/32，含 v1→v2、长短查询、事务回滚、换行/控制字符和清理；fmt/check 通过 | 是 |
| `src/features/ai/indexing/indexStore.ts`、`indexStore.test.ts` | 新增 | C-54 前端 bridge 将稳定 `DocumentChunk`、三版本与 JSON 锚点映射到单一 Tauri 边界，并拒绝空块、混合指纹/版本 | 定向 3/3；全量 Vitest 59/446、tsc、Vite 120 modules | 是 |
| `src-tauri/src/ai/store.rs`、`src-tauri/src/ai/mod.rs`、`src-tauri/src/lib.rs` | 更新 | C-54 完整 staging：schema v3、begin/append/commit/abort、单批256 chunks/8 MiB、单块4 MiB、全书1000000 chunks/512 MiB；live/暂存隔离、启动回收、同书 begin 取代旧 staging；索引状态与只清全文索引命令；查询增加书名/作者/章节/类型过滤 | Rust 全量 36/36、fmt/check；原子性、边界、迁移、回收、Provider 保留均覆盖 | 是 |
| `src/core/bookCorpusIndex.ts` 及测试 | 新增 | 只在 core 层逐 linear spine 解码、提取结构语料并产生稳定 chunk 批次；缺章失败而非静默提交，支持 AbortSignal，不创建渲染 Blob | 定向 3/3；全量 Vitest 63/463 | 是 |
| `src/features/ai/indexing/indexController.ts`、`libraryIndexer.ts`、`indexStore.ts` 及测试 | 新增/更新 | 框架无关单书/多书控制器；chunk 数+字符数双门控、逐章/批 yield、单调进度、取消/异常 abort、版本跳过、坏书隔离继续；Tauri bridge 对齐 staging/status/search/clear 命令并严格解析锚点 | indexing 定向 14；tsc；全量 Vitest 63/463 | 是 |
| `src/ui/SearchPanel.tsx`、`src/ui/crossBookSearch.ts`、`src/App.tsx`、`src/styles.css` 及测试 | 更新/新增 | 阅读器搜索增加当前书/全部书籍分段入口；选择全部书籍显式建库并显示进度/取消，支持重建和只清索引；结果显示书名/作者/章节，NFKC 命中映射回原文高亮及精确文本锚点；跨书打开复用源文件重新定位和 display-ready 初始锚点 | SearchPanel/core/presentation 定向通过；全量 63/463、tsc、Vite 126 modules；Windows Tauri 真实链路待用户 | 是 |
| C-54 维护文档 | 更新 | 标记自动化实现完成、Windows 待审；明确无模型/网络、索引缓存边界，以及跨书打开重建会话故当前三步历史不跨书返回来源书 | 文档与代码状态核对 | 是 |

## B-072：Windows 跨书建库完成后搜索始终为空（2026-08-24）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/features/ai/indexing/indexStore.ts`、`indexController.ts` 及测试 | 更新 | 将旧书架的空白 `language` 规范化为未提供后再发送 staging/replace IPC，避免逐书被原生参数校验拒绝 | indexing 定向 16/16；全量 Vitest 63 files/465 tests | 是 |
| `src-tauri/src/ai/store.rs` | 更新 | 原生索引边界将可选语言的空白值规范化为 `NULL`，同时保留非空值长度/控制字符校验，形成双层兼容 | Rust fmt；全量 37/37 | 是 |
| `src/App.tsx` | 更新 | 全部候选书均建库失败时进入 error 并显示首个失败原因，不再把空数据库标记为 ready | TypeScript、Vite 126 modules | 是 |
| `docs/tasks/active/cross-book-fts-search.md`、`docs/BUGFIX_LOG.md`、`docs/SOURCE_DELTA.md` | 更新 | 记录 Windows 数据证据、根因、修复和重新建库要求 | 文档与实现核对 | 是 |

## B-073：图片封面章节使每本书因“无效的正文”建库失败（2026-08-24）

| 路径 | 类型 | 变化与原因 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/core/corpus.ts`、`src/core/corpus.test.ts` | 更新 | 只将规范化后含可检索文字的结构块写入共享语料；`createCorpusChapter` 再做防御过滤；解析版本升至 `visible-xhtml-v2` 使旧索引自动失效重建 | corpus 7/7，覆盖图片-only XHTML 与手工空白块 | 是 |
| `src/core/bookCorpusIndex.test.ts`、`src/features/ai/indexing/libraryIndexer.test.ts` | 更新 | 覆盖空封面 batch 后继续建立后续正文；版本比较测试改用当前常量，防止版本升级后测试伪通过 | 相关定向 24/24；全量 63 files/467 tests | 是 |
| C-54 与维护文档 | 更新 | 登记 B-073 根因、版本升级、真实书回放和 Windows 重建要求 | Windows 测试目录 37 本/3094 chunks 无非法正文；Vite 126 modules、Rust 37/37 | 是 |

## B-074/C-55：用户确认式建库、可靠取消、异常退出恢复与派生缓存边界（2026-08-24）

| 路径 | 类型 | 相较源文件的修改 | 验证 | 建议同步 |
|---|---|---|---|---|
| `src/App.tsx`、`src/ui/SearchPanel.tsx`、`src/styles.css` 及测试 | 更新 | “全部书籍”改为只探测状态并先提示硬件/耗时，确认后才建库；进度卡固定取消区；部分索引可搜索；重建也先确认 | SearchPanel 11/11；全量前端 66/485；TypeScript、Vite | 是 |
| `src/features/ai/indexing/libraryIndexer.ts`、`indexController.ts`、`libraryIndexStatus.ts`、`indexTaskStore.ts` 及测试 | 更新/新增 | cancel 改为可等待收口，阻止下一本和取消后的进度回调；持久任务按书更新；启动识别异常退出并从已提交书本续建 | indexing 定向通过；全量前端 66/485 | 是 |
| `src/features/ai/cache/*`、`src-tauri/src/ai/*`、`src-tauri/src/lib.rs` | 新增/更新 | 建立统一派生缓存类别与状态/清理命令；全文查询增加三版本过滤；启动回收半本 staging 与运行中任务，清理不触碰用户数据和 Provider | Rust fmt；全量 38/38 | 是 |
| `docs/BUGFIX_LOG.md`、`docs/HANDOFF.md`、C-54 任务文档 | 更新 | 登记确认、取消、恢复、缓存归属、验证和 Windows 待验收项 | 文档与实现核对 | 是 |

## RAG C-57：模型资产管理（2026-08-24）

> 本节使用“RAG C-57”消歧；历史字体拖放功能也曾使用 C-57 编号。以下均为隔离副本相对真实源文件的新增/修改，须由用户审核后同步。

| 路径 | 类型 | 相较源文件的修改 | 验证/边界 | 建议同步 |
|---|---|---|---|---|
| `src-tauri/src/ai/models.rs` | 新增/更新 | 多文件 `ModelPackageManifest`、模型包扫描/注册/verify、文件白名单、路径/长度/slug/capability/mirror 校验、size/SHA 状态、默认 package ID、managed/linked 导入/重新定位/删除、开发固定 catalog 命令 | Rust tests 覆盖 manifest 无效项、绝对/父路径、扩展白名单、symlink/reparse、linked ownership、固定 15 字节 probe | 是 |
| `src-tauri/src/ai/store.rs` | 更新 | AI SQLite schema v4→v6；新增/维护 `model_packages`、`model_package_files`、`model_sources`、`model_download_tasks`、`model_license_acceptance`；状态迁移、ownership、root 变更、missing/corrupt 收敛和安全删除 | Rust 71 tests 总通过；不删除源 EPUB/linked 外部文件 | 是 |
| `src-tauri/src/ai/download.rs`、`src-tauri/src/ai/mod.rs`、`src-tauri/src/lib.rs` | 新增/更新 | 单 FIFO 下载 worker、enqueue/pause/resume/cancel/list、许可证 gate、Range/206/200/416、镜像切换、`.staging`/`.part`、实际进度、磁盘检查、SHA、原子安装、退出 paused 和崩溃目录收敛；注册 IPC 命令 | `cargo fmt --all -- --check`、`cargo test --locked` 71 passed、`cargo check --locked`；真实 Windows 大文件/Defender/多进程 IPC 仍待验收 | 是 |
| `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 更新 | 直接依赖 `reqwest 0.13.4`（blocking/rustls）和 `fs2 0.4.3`（磁盘空间）；不接 Ollama/Provider/推理 | 直接依赖许可已记录；不是完整锁文件许可审计 | 是 |
| `src/features/ai/models/modelAssets.ts`、`modelDownloads.ts`、`index.ts` | 新增/更新 | 薄 Tauri invoke adapter/types；model package、linked path、download task、license 和 fixed dev catalog 边界；`findAvailableModelPackages` 过滤 verified 非 probe 元数据 | 模型 adapter 定向测试；不创建/加载 Provider | 是 |
| `src/features/ai/models/modelAssetsController.ts`、`modelAssetsViewModel.ts` 及测试 | 新增 | 独立 controller/view model；首开只读 path/packages/tasks；活动轮询、完成刷新、dispose/generation、busy gate、许可证接受→入队顺序和 action matrix | 模型定向 10 tests；全量前端 77 files/520 tests | 是 |
| `src/features/ai/ui/AiFoundationPanel.tsx`、`ModelAssetsDevelopmentSection.tsx`、`ModelAssetLicenseDialog.tsx`、`src/styles.css` | 新增/更新 | DEV/Tauri-only 模型资产开发面板、目录选择、linked 管理、verify/delete/download/pause/resume/cancel、许可证来源、刷新元数据和实际 bytes/current file 展示；App 不持有资产状态 | 浏览器不 invoke；release 不显示公共模型市场；Vite build 143 modules | 是 |
| `public/c57-dev-probe/probe.txt` | 新增 | 固定 15 字节纯文本开发 fixture，无代码、无推理能力；仅 debug catalog 登记后可显式下载 | dist 可包含该极小 fixture；release command 拒绝 | 是 |
| `docs/tasks/active/rag-model-asset-management.md` | 新增 | 完整登记 C-57 目标、manifest/ownership/schema/download、安全、开发入口、测试证据、未做项与 C-58 交接 | 文档与代码接口核对 | 是 |
| `docs/SEARCH_TO_RAG_ROADMAP.md`、`docs/AI_PLUGIN_ARCHITECTURE.md`、`docs/MODULE_CONTRACTS.md` | 更新 | beta2 Windows 已验收；全文 OR/前缀/邻近后置给 RAG；登记 C-57 资产层与 Provider/模型包分离、惰性边界和 C-58 元数据查询契约 | 链接与状态核对 | 是 |
| `docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`、`README.md`、`docs/tasks/active/README.md` | 更新 | 登记当前版本、开发入口、测试基线、Windows 待验收边界和正式版不显示公共模型市场 | 仅文档核对 | 是 |
| `THIRD_PARTY_LICENSES.md` | 更新 | 登记 reqwest/fs2 直接依赖、版本、许可和源码；明确尚未完成完整锁文件/平台许可审计 | 本机 crate Cargo 元数据核对 | 是 |

### B-075：开发 Strict Mode 使模型资产面板卡在读取中（2026-08-24）

| 路径 | 类型 | 相较源文件的修改 | 验证/边界 | 建议同步 |
|---|---|---|---|---|
| `src/features/ai/models/modelAssetsController.ts`、`modelAssetsController.test.ts` | 更新 | controller 支持 React Strict Mode 的 setup → cleanup → setup：dispose 后可安全重启，旧 in-flight Promise 由 generation 隔离，旧 finally 不干扰新状态；真实卸载仍停止轮询 | controller 6/6；全量 Vitest 77 files/521 tests；TypeScript 通过；Rust 未修改 | 是 |
| `docs/BUGFIX_LOG.md`、`docs/tasks/active/rag-model-asset-management.md`、`docs/SOURCE_DELTA.md` | 更新 | 登记 Windows Tauri dev 永久 loading 的现象、Strict Mode 根因、修复边界和复验步骤 | 文档与代码核对 | 是 |

### B-076：Windows 开发探针地址与 Vite devUrl 不一致（2026-08-24）

| 路径 | 类型 | 相较源文件的修改 | 验证/边界 | 建议同步 |
|---|---|---|---|---|
| `src-tauri/src/ai/models.rs`、`src-tauri/src/ai/store.rs` | 更新 | 固定开发探针由 `127.0.0.1:5173` 改为与 Tauri `devUrl` 相同的 `localhost:5173`；补 catalog 重新登记替换旧 source、failed 任务可重新排队的回归 | Rust fmt/check；71/71 tests；仅开发 fixture，不改变正式模型来源或 Provider | 是 |

### B-077：Windows 模型校验栈溢出（2026-08-24）

| 路径 | 类型 | 相较源文件的修改 | 验证/边界 | 建议同步 |
|---|---|---|---|---|
| `src-tauri/src/ai/models.rs` | 更新 | `sha256_file` 的 1 MiB 栈数组改为256 KiB `Vec` 堆缓冲，保持逐块流式 SHA；新增256 KiB小栈线程 digest 回归 | Rust fmt/check；72/72 tests；不把模型整体读入内存 | 是 |

### B-078：删除模型精确清理历史 staging（2026-08-24）

| 路径 | 类型 | 相较源文件的修改 | 验证/边界 | 建议同步 |
|---|---|---|---|---|
| `src-tauri/src/ai/store.rs`、`download.rs`、`models.rs` | 更新 | 删除 package 在 immediate transaction 内重查活动任务并读取精确 task IDs；安全清理对应历史 staging 后才删除正式 managed 目录/DB，保留 `.staging` 根、他包、相似前缀和 linked 外部文件 | Rust fmt/check；74/74 tests；清理失败回滚 DB，活动任务拒绝且不清理 | 是 |

### B-079：Windows 短路径别名与 staging 安全边界（2026-08-27）

| 路径 | 类型 | 相较源文件的修改 | 验证/边界 | 建议同步 |
|---|---|---|---|---|
| `src-tauri/src/ai/models.rs`及测试 | 更新 | staging 安全检查改为 canonical 根目录 + 最近存在祖先的真实包含关系，再逐级检查 symlink/reparse 与剩余词法组件；消除 Windows 8.3/长路径别名误报，同时继续拒绝真实越界 | Windows Cargo Core 38/38、AI 72/72，Rust fmt/check；真实 D 盘中文长路径待 Tauri 复验 | 是 |

2026-08-24 Windows 实机补验：用户确认 Tauri dev 首次读取、D 盘模型库选择与保持、开发探针登记/许可证/下载、应用重启状态持久化和显式 SHA 校验全部通过；B-075～B-077 的修复均获得实机证据。删除、linked 导入/重新定位、真实大文件断点/镜像/磁盘/Defender/reparse/长路径仍未验收，不标记完整发布验收完成。

2026-08-24 RAG 路线修订：默认本地 AI 不依赖 Ollama；C-58 优先项目维护的 Windows CPU Builtin ONNX Embedding Provider，生成阶段优先固定/审计的 llama.cpp sidecar。Ollama/OpenAI-compatible 后置为高级可选 Provider；普通用户使用推荐模型和必要加速模式，高级替换通过 C-57 manifest/linked 或受控能力插件，模型包不得携带可执行代码。同步更新 `SEARCH_TO_RAG_ROADMAP.md`、`AI_PLUGIN_ARCHITECTURE.md`、`MODULE_CONTRACTS.md`、`README.md` 与 `HANDOFF.md`，仅文档，无运行时代码变更。

2026-08-24 GPU-first 路线修订：基于 CPU 大模型性能和整机响应风险，废止上述 C-58 CPU-first 默认路线。C-58 拆为 C-58A Windows GPU/后端能力探测、支持矩阵与资源准入，以及 C-58B GPU-first Builtin ONNX Embedding Provider；后续 llama.cpp 生成 Provider 同样 GPU-first。普通 UI 固定为自动推荐、GPU 兼容、NVIDIA CUDA、CPU 兼容；NVIDIA 以 CUDA 为性能路径，AMD/Intel/其他已验收设备以 WinML/DirectML（Embedding）和 Vulkan（生成）为通用路径，CPU 只显式限额启用且禁止静默回退。同步更新路线、架构、契约、README、项目上下文与交接文档；本轮仅文档，无运行时代码或依赖变化。

## C-57.5：Core / AI发行隔离（2026-08-27）

| 路径 | 类型 | 相较源文件的修改 | 验证/边界 | 建议同步 |
|---|---|---|---|---|
| `src/config/edition*.ts`、`vite.config.ts`、`src/features/ai/lifecycle/editionRuntime.ts`、`src/App.tsx`、`src/ui/aiEntry.ts`及测试 | 新增/更新 | 编译期`core/ai` edition；Core安全默认且不生成AI runtime/面板/模型资产chunk，AI production以lazy chunk保留开发入口 | 前端78 files/523 tests、tsc；Core/AI Vite各146 modules，Core目标字符串扫描为空 | 是 |
| `src-tauri/Cargo.toml`、`src-tauri/src/ai/mod.rs`、`store.rs`、`src-tauri/src/lib.rs` | 更新 | Cargo `ai` feature门控models/download、模型IPC及optional reqwest/fs2；Core保留FTS/store/task/cache；Core v3→AI v6补齐provider/model schema | Windows Cargo Core 38/38、AI 72/72，Rust fmt/check通过；含Core v3→AI v6迁移 | 是 |
| `scripts/build-windows.ps1`、`package.json`、`src-tauri/tauri.ai.conf.json`、`scripts/validate-windows-rag-foundation.ps1` | 更新/新增 | Windows脚本默认Core、显式AI；前后端edition成对传递、target隔离；AI使用独立`dev.epubreader.ai`身份/app-data；RAG验证脚本显式AI矩阵 | JSON解析和脚本静态核对；PowerShell/Tauri真实双打包待Windows | 是 |
| `docs/tasks/active/core-ai-edition-split.md`及路线/架构/契约/README/交接入口 | 新增/更新 | 固定同代码树双发行、Core热修复回合并、schema兼容与未实现边界 | 文档与实现核对 | 是 |

## C-57.6：Core / AI发行门禁设计与实现（2026-08-27～2026-08-28）

> 代码与本地矩阵已完成；Windows双安装包、身份/app-data和人工功能链路仍待用户验收，不能据此标记完整发布通过。

| 路径 | 类型 | 相较源文件的修改 | 验证/边界 | 建议同步 |
|---|---|---|---|---|
| `src/config/editionValue.ts`、`edition.ts`及测试 | 新增/更新 | 未设置edition安全默认为Core；显式值只接受规范化后的`core|ai`，空值/拼写错误不再静默降级 | 全量Vitest 83 files/537 tests；未知wrapper edition与`VITE_EDITION=preview`按预期失败 | 是 |
| `src/config/appBuildInfo.ts`、`appBuildSession.ts`、`src/appBootstrap.tsx`、`src/main.tsx`及测试 | 新增/更新 | 桌面在动态导入`App`前读取无副作用build-info并校验协议/edition；失败显示独立错误页且不初始化App/FTS/AI前端运行时；验证后的只读session控制debug动作 | 两种mismatch方向、IPC失败、浏览器跳过IPC和import顺序自动化；tsc通过 | 是 |
| `src/features/ai/ui/AiFoundationPanel.tsx`、`ModelAssetsDevelopmentSection.tsx`、`ai.css`、边界测试、`src/styles.css`、`public-ai/c57-dev-probe/probe.txt` | 新增/更新/迁移 | AI UI样式由lazy面板持有，探针只归AI静态目录；AI release隐藏mock/test catalog，保留模型库、linked、校验和资产管理 | Core无AI CSS/fixture/模型IPC；AI含lazy JS/CSS与15字节探针；双门禁通过 | 是 |
| `src-tauri/Cargo.toml`、`build.rs`、`src/build_info_contract.rs`、`src/build_info.rs`、`src/lib.rs` | 新增/更新 | Cargo空默认，显式`core/ai`互斥；release强制expected edition；两版注册只返回编译常量的`app_build_info`，不读State/SQLite/模型目录/网络 | Rust Core45/45、AI83/83、fmt；冲突feature、mismatch和release缺expected按预期失败 | 是 |
| `src-tauri/src/ai/store.rs`、`download.rs` | 小幅更新 | 非Windows reparse helper在Core编译时保持无副作用false分支；`download.rs`只有`cargo fmt`产生的换行变化，无行为修改 | Core/AI Rust矩阵通过；Core active tree无`reqwest/fs2` | 是 |
| `vite.config.ts`、`package.json`、`scripts/build-frontend.mjs`、`verify-edition-artifacts.mjs`、`build-windows.ps1`、`validate-windows-rag-foundation.ps1`、Tauri base/Core/AI config、`.gitignore` | 新增/更新 | 单一edition派生Vite、Cargo、Tauri、identifier与独立`dist/target`；生成edition/artifact manifest；B-080后Node wrapper直接运行本地CLI；B-081按Tauri 2.11真实接口只传`--features core|ai`，Cargo空默认与build.rs继续保证唯一edition | WSL官方`pnpm build:core|ai`各150 modules并通过门禁；Tauri dev/build四组参数解析通过；Windows窗口与真实双打包待复验 | 是 |
| `docs/tasks/active/core-ai-release-hardening.md`、路线/架构/契约/README/CONTRIBUTING/上下文/交接入口 | 新增/更新 | 从架构设计推进为真实实现，固定Core稳定线→AI回合并、全量tsc边界、C-58前置顺序和Windows待验收项 | 文档与代码、命令及上述验证证据核对；不得视为模型推理能力 | 是 |
