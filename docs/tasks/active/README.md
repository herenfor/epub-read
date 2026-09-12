# 活动任务目录

这里仅存放尚未结束、需要跨对话继续的任务记录。

- 从 `../TEMPLATE.md` 复制一份并使用稳定名称，例如 `chapter-preload.md`。
- 同一目标只保留一个活动文件，新对话在原文件上继续更新。
- 任务完成并经用户审核后，可以移动到 `docs/tasks/archive/`；是否同步由用户决定。
- 一次性调试输出、测试书、截图和聊天转录不要放入本目录。
- 当前待确认或待同步的任务以本目录中的任务文件为准；已经同步但仍缺 Windows 证据的版本任务也可暂留在这里。

## 当前阶段

- 2026-09-12 追加反馈已本地修复，待 Windows/汇报人确认：[`toc-width-three-books.md`](./toc-width-three-books.md)（B-088～B-090）。火焰长短色块、赤月条目右缘、相容同居标题及页面百分比间距；当前前端 89/558，双版构建通过。

- 2026-09-12 本地修复完成，待 Windows 复验：[`toc-width-three-books.md`](./toc-width-three-books.md)（B-085～B-087）。修复相容同居蓝色卡片、前辈 04 目录卡片限宽、国王求婚 06 竖排引文；标题背景页保持原状。

- 2026-09-11 本地修复完成，待 Windows 原书库复验：[`core-reader-fixes-september.md`](./core-reader-fixes-september.md)（B-082～B-084）。修复高性能模式设置/缓存错位、添加笔记入口、已索引书籍删除；记录了前后对照、性能数据及验证边界。

- 代码与本地矩阵完成、待Windows双包验收：[`core-ai-release-hardening.md`](./core-ai-release-hardening.md)（C-57.6）。`dist/core`/`dist/ai`、独立target、Cargo Core安全默认、严格edition/build-info握手、AI CSS/fixture隔离和产物门禁已落地；前端83 files/537 tests、Core/AI 150 modules、Rust Core45/AI83及PowerShell 5.1语法通过。不修改GPU、Provider、schema或模型运行行为。
- 被C-57.6收口、仍待Windows双安装包验收：[`core-ai-edition-split.md`](./core-ai-edition-split.md)（C-57.5）。该文件保留首轮隔离历史，当前构建命令与安全默认以C-57.6为准。
- Windows Tauri dev 核心链路已通过、扩展边界待发布版验收：[`rag-model-asset-management.md`](./rag-model-asset-management.md)（RAG C-57）。D 盘模型库、固定探针登记/许可/下载、重启持久化和显式 SHA 校验已有实机证据；managed 删除的历史 staging 清理和 B-079 Windows 路径别名误报已修复待复验，linked、真实大文件和故障恢复矩阵仍待验证。不创建/加载 Provider、不读 EPUB、不建向量、不推理。当前总基线见 [`core-ai-edition-split.md`](./core-ai-edition-split.md)。
- C-57 Windows 验收重点：真实慢速/断网大文件、digest 错误镜像回退、磁盘不足、多进程/真实 IPC 并发、重启续传、Windows junction/reparse、Defender 文件占用、中文/日文长路径。

- 待 Windows WebView2 审核：[`font-drag-import.md`](./font-drag-import.md)（C-57）。字体中心已支持一次拖入多个 TTF/OTF/WOFF/WOFF2；浏览器与 Tauri 原生路径共用串行哈希/存储链路，面板外 EPUB 导入不变。全量 Vitest 73/509、tsc、Vite 137 modules 通过。
- 已通过 `0.1.9-beta.2` Windows 基础全文搜索验收：[`shelf-library-search-pipeline.md`](./shelf-library-search-pipeline.md)（C-56）。书架“书名与作者/正文”切换和阅读器“全部书籍”共享唯一全库运行时；真实 module Worker、可配置核心并发、单写入、大书独占、阅读优先让出及 Rust 持久任务互斥均已接通。8 以上并发的收益与峰值资源保留为后续性能调查。
- 已随 `0.1.9-beta.2` 通过 Windows 基础全文搜索验收：[`cross-book-fts-search.md`](./cross-book-fts-search.md)（C-54）。schema v3/trigram FTS、分批 staging、逐书建库、搜索范围 UI、索引管理与跨书锚点跳转已接通；真实模型、Embedding、向量、标签和生成不属于该阶段。
- 已完成：[`rag-plugin-foundation.md`](./rag-plugin-foundation.md)（C-53）。共享语料/稳定 chunk、capability/Provider、惰性 mock runtime、开发面板、独立 SQLite schema 和任务状态机已通过前端 58/443、Rust 28/28 与 Windows Tauri 实机验收。
- 待 Windows 发布包审核：[`cover-fallback-contract.md`](./cover-fallback-contract.md)（B-048/C-41）。桌面 Rust 链接导入和浏览器预览统一 `cover-image → meta cover → cover.*` 候选规则，修复 `id=image001; href=cover.webp` 漏封面；候选仅查 ZIP 中央目录，不解压、不扫描、不迁移旧库。
- 待用户/Windows 审核：[`settings-stepper-bounds.md`](./settings-stepper-bounds.md)（B-049）。详细设置 +/- 改为纯数值有序档位，按可见默认值从自动档相邻步进；数值边界 no-op 保持原 settings identity，不触发无效阅读器重载。自动化 319/319、tsc、Vite build 与 WSL Chromium 真实点击/reload 计数均通过。
- 待用户/Windows 审核：[`epub-guide-compatibility.md`](./epub-guide-compatibility.md)（B-041～B-047/C-40）。七项兼容修复的代码、定向与全量自动化、目标 EPUB 及相邻书 WSL Chromium 已完成；全量 Vitest 34 文件、314 测试、`tsc --noEmit` 与 `pnpm build`（95 modules）通过。C-40 同时回归 B-024 左对齐标题、C-18、B-023 百分比 margin 与 B-046 float；尚待 Windows WebView2/发布包实机验证及用户同步，不归档任务。
- 待 Windows 实机确认：[`desktop-single-instance.md`](./desktop-single-instance.md)（B-032）。Tauri 桌面版已接入官方单实例插件；第二次启动恢复并聚焦已有主窗口，浏览器开发模式不变。Rust 10/10、格式与检查通过。
- 待用户审核：[`reader-navigation-history-forward.md`](./reader-navigation-history-forward.md)（B-033）。阅读历史为最多 3 条的 back/forward 双栈；初始加载可以已保存基线记录首次跳转，同章 fragment 可连续入栈，最终 display-ready 后才写稳定进度。
- 待用户审核：[`toc-top-float-containment.md`](./toc-top-float-containment.md)（B-034）。目录顶层无作者水平 margin 的 float 在宽视口回到居中的 40rem 版心边缘；作者 margin、全页/全宽意图、过宽盒保守跳过，640px 窄容器保持自然布局。
- 待用户审核：[`footnote-rich-content-marker.md`](./footnote-rich-content-marker.md)（B-035）。多看图片脚注复制到宿主弹层后不再继承书籍 `list-style:none`，现在仅隐藏该结构的生成编号并恢复图片左缘；普通作者列表保持编号。
- 待用户审核：[`reader-session-lifecycle-and-blob-ownership.md`](./reader-session-lifecycle-and-blob-ownership.md)（B-036）。书籍会话按 flush → React 卸载 paginator → revoke ResourceServer → 清空状态结束；章节 CSS Blob URL 局部所有权在成功换章、失败、过期和 dispose 路径幂等撤销，过期测量不再进入兼容修正。
- 待 Windows 发布包审核：[`text-content-anchor-and-progress.md`](./text-content-anchor-and-progress.md)（B-037）。页面中心仅采样文本；章节自然排版后以 code-point 文本 offset/snippet 选择列，旧元素锚点和页码保持兜底，进度不再重复父子文本。WSL Chromium 的视口、重开与连续字号矩阵已通过。
- 待用户审核：[`same-chapter-navigation.md`](./same-chapter-navigation.md)（B-038）。当前已完成布局的章节内目录、书签、历史和普通书内链接直接恢复页/文本锚点，不重载 iframe；失败保持原位置，跨章仍走原有 load/display gate。WSL Chromium 已确认同章目录/后退/前进无 iframe 重载或隐藏闪动。
- 待用户审核：[`incremental-chapter-counts-and-progress.md`](./incremental-chapter-counts-and-progress.md)（B-039）。打开书籍不再同步扫描整书；generation-aware counts 由当前 ready 章节 measured、其余章节可取消 idle provisional 统计；扫描未完成时进度沿用书架 baseline，完成后才更新分母。未访问章节的 CSS hidden 只能估算，统计不参与布局；附 4 MiB/32 项 text LRU 与可取消字体/rAF wait。
- 待用户审核：[`reader-settings-reload-debounce.md`](./reader-settings-reload-debounce.md)（B-040）。连续字号/主题设置在 150ms debounce 内只合并执行最后一次；章节切换/dispose 取消旧 timer，设置重载在 await/load 前复制不可变阅读锚点与当前页 fallback，沿用 loadSeq/display gate/Blob ownership/measure abort 防止旧 reload 覆盖新位置。Chromium 已验证 900×650 长书连续无延迟两次字号+仍在第 2/3 页且旧 snippet 可见。
- 待用户审核：[`reading-progress-open-session.md`](./reading-progress-open-session.md)（B-050）。书架读过判定与暂时百分比解耦；章节统计增加 error/媒体权重、默认每 slice 4 章/100ms timeout 的有界 job 和版本化本机 structural cache（contentHash 优先、256 entries/100000 counts、estimated merge-preserve）；新导入时间、存档阅读证据 merge、每阅读会话首次写入和成功进度清新标记均已回归（全量 Vitest 36/332、Rust 14/14、tsc、Vite 98 modules），Windows WebView2/发布包待用户确认。
- 待用户审核：[`initial-turn-intent-gate.md`](./initial-turn-intent-gate.md)（B-051）。首次白屏/首次 display-ready 前的滚轮、键盘和工具栏翻页意图直接丢弃，首次内容显示后解锁并清理外层滚轮累计；后续跨章 loading 仍保留最后方向单槽。turnIntent 9/9、全量 Vitest 36/334、tsc 通过，Windows WebView2 真实输入待确认。
- 待用户审核：[`selection-shortcut-guard.md`](./selection-shortcut-guard.md)（B-052）。App 与 iframe 共用 DOM selection guard，仅拦截非编辑区域 Ctrl/Cmd+A，编辑控件及其后代放行；进入 reader 清理一次宿主旧 selection，不影响方向键翻页或正文手动选择。定向 76/76、全量 Vitest 37/337、tsc、Vite 99 modules 通过，Windows WebView2 selection 待确认。
- 待用户审核：[`dark-theme-contrast-guard.md`](./dark-theme-contrast-guard.md)（B-053/C-42）。dark theme 仅在 iframe load 后首次 measure 前按有效 alpha 背景与 WCAG contrast 保守修正接近主题前景的局部元素；按 html→body 单次 DFS 读取每个元素样式，背景图、未知/opacity/作者不同色跳过，marker 随文档销毁。定向 68/68、全量 Vitest 38/341、tsc、Vite 100 modules 通过，Windows WebView2 主题矩阵待确认。
- 待用户审核：[`footnote-hover-grace.md`](./footnote-hover-grace.md)（B-054/C-43）。iframe 脚注 marker 与宿主弹层共享 140ms hover grace，marker/overlay 交接不立即关闭，普通正文 mouseover 不触碰 gate，重复 mouseover 不重复显示；固定注释和关闭语义保持。定向 84/84、全量 Vitest 39/345、tsc、Vite 101 modules 通过，Windows WebView2 窄窗 hover 待确认。
- 待用户审核：[`footnote-placement-narrow-window.md`](./footnote-placement-narrow-window.md)（B-055/C-44）。FootnotePop 移入 `.main` 统一局部坐标，placement helper 处理极窄/四角/低高容器并限制宽高，ResizeObserver 仅在尺寸变化时更新。定向 92/92、全量 Vitest 40/353、tsc、Vite 102 modules 通过，640×480 与 Windows WebView2 UI scale 待确认。
- 待用户审核：[`dark-theme-text-shadow-fallback.md`](./dark-theme-text-shadow-fallback.md)（B-056/C-45）。仅 dark theme 在 `#epub-viewer` 注入可继承的 `text-shadow: 1px 1px 1px #1e1e1e` 作为浅色盒/复杂背景的可读性兜底；不使用 `#epub-viewer *` 或 `!important`，light/sepia 不注入，作者后代 `none`/特效声明保留。sanitize 定向 54/54；Root 独立全量 Vitest 40 文件/354 tests、tsc、Vite 102 modules 通过，Windows WebView2 观感与长章节性能仍待用户。
- 待用户审核：[`force-horizontal-reading.md`](./force-horizontal-reading.md)（B-057/C-46）。可重排章节的“强制横排”开关覆盖根级/嵌套竖排到 `horizontal-tb`，含 Chromium vendor 写法；SVG 及后代排除普通后代覆盖，固定版式屏蔽，不改 direction。定向 sanitizer/菜单/存储/存档 73/73、fixedLayout/helper 58/58；Root 独立全量 Vitest 42 文件/359 tests、tsc、Vite 102 modules 及 900×650 WSL Chromium 临时竖排烟测通过，Windows WebView2/真实竖排书仍待用户确认。
- 待 Windows 主机与实机审核：[`font-center-system-fonts.md`](./font-center-system-fonts.md)（B-058/C-47）。Windows DirectWrite 系统字体 + 独立字体中心已接入；系统字体只在首次打开时枚举并会话缓存，导入字体启动只读取元数据、当前选择才读取一个 Blob，虚拟列表支持大规模搜索与末尾滚动。前端全量 44 files/365 tests、tsc、Vite 104 modules 及 WSL Chromium 900×650 模拟 300 imported 已通过；Windows target 构建、真实枚举、本地化字体名和 WebView2 待确认。
- 待用户与 Windows WebView2 审核：[`reader-text-search.md`](./reader-text-search.md)（B-059/C-48）。当前书可重排 EPUB 的正文搜索已接入：首次查询按需提取并缓存章节，使用紧凑 TypedArray 映射，支持 NFKC/大小写/布局空白标准化、短语与同上下文多关键词 AND、取消/generation、结果高亮和文本锚点跳转；不持久化索引、不跨书、不含模糊/语义检索。全量 Vitest 46 files/377 tests、tsc、Vite 106 modules 及 WSL Chromium 900×650 实机搜索/后退/前进已通过。
- 待用户与 Windows WebView2 审核：[`reader-notes.md`](./reader-notes.md)（B-060/C-49）。正文选区自定义右键菜单、笔记创建/编辑/删除、按时间列表、文本锚点跳转与 CSS Highlight 下划线已接入；只处理当前章节，不修改 EPUB DOM。全量 Vitest 50 files/393 tests、Rust 18/18、tsc、Vite 110 modules及 WSL Chromium 实机链路通过。
- 待用户与 Windows WebView2 审核：[`next-chapter-preload.md`](./next-chapter-preload.md)（B-061/C-50）。默认关闭的“高性能模式”最多保留上一篇/当前篇/下一篇三个静默槽位，按下一篇优先顺序预热，顺序命中后提升并保留反向缓存；关闭/固定版式仍为单 iframe。详细设置已统一主题卡片和现代开关，窄窗步进按钮/开关卡片对齐已回归。全量 Vitest 51 files/402 tests、tsc、Vite 110 modules 及 WSL Chromium 实书三 Blob/约 7ms 回翻通过。
- 待 Windows WebView2 审核：[`shelf-filter-drawer.md`](./shelf-filter-drawer.md)（B-062/C-51，含 B-063～B-066）。书架二级抽屉已接入组合筛选及搜索、排列、密度、主题和存档操作；滚动区占满剩余高度并预留稳定滚动槽，搜索图标/文字间距与垂直居中已修复，筛选展开前后选项宽度不再跳变。全量 Vitest 52 files/407 tests、Rust 19/19、tsc/Vite 110 modules 与 Chromium UI 链路通过。
- 待 Windows WebView2 审核：[`reader-foreground-arbitration.md`](./reader-foreground-arbitration.md)（B-071/C-52）。阅读器所有普通 panel、正文 transient 和笔记 modal 已由单一判别联合仲裁；全量 Vitest 53 files/420 tests、tsc、Vite 111 modules 通过。
- 待 Windows 发布包验证：[`linked-library-refactor.md`](./linked-library-refactor.md)（B-031）。桌面书库已改为引用源 EPUB；可同步状态、设备路径和 100 MiB 有界缩略图缓存已分层，旧测试书库不迁移。自动化为前端 21 文件 218/218、Rust 9/9、TypeScript/Vite 与 Cargo 检查通过。
- 当前隔离副本版本：`0.1.9-beta.2` 测试版；真实源仓 `main`/`origin/main` 仍以 `e8aabcd`（`v0.1.6`）为比较基线。
- 当前测试入口：`../../RELEASE_0.1.9-beta.2.md`；beta.1 与正式 0.1.9 文档保留为阶段历史。
- 已同步任务：B-020/B-021 导入与进度、自定义字体/CSS/全选、阅读跳转历史、书签、B-022。
- 待用户审核、尚未同步：[`toc-percent-margin-resilience.md`](./toc-percent-margin-resilience.md)（B-023）。B-022 的 CSSOM 扫描已改记为部分修复，后续以 B-023 的 Typed OM/安全回退方案为准。
- 待用户审核、尚未同步：[`toc-symmetric-margin-regression.md`](./toc-symmetric-margin-regression.md)（B-024）。C-18 的正对称 margin 豁免已收窄到具有 fit/max-content 原始意图的盒，普通目录标题恢复 C-04。
- 待用户审核、尚未同步：[`toc-inline-box-overflow.md`](./toc-inline-box-overflow.md)（B-025）。目标书 right 对齐目录的可见 inline 色块尾随全角空白越过父段落，已加入几何门控的 inline-block 原子化补偿。
- 待用户审核、尚未同步：[`reader-history-internal-links.md`](./reader-history-internal-links.md)（B-026）。修复 iframe 书内链接旧闭包导致历史不入栈，并为同章 fragment 增加可撤销通知；目录/书签/内部链接拆分为单次记录与纯跳转。
- 待用户审核、尚未同步：[`custom-css-commit-and-theme-bgcolor.md`](./custom-css-commit-and-theme-bgcolor.md)（B-027）。自定义 CSS 改为显式保存，浅色安全 bgcolor 合入默认背景层并保留用户背景图；多个 CSS 预设仍是 optional backlog（schema/UI CRUD/旧值迁移）。
- 待用户审核、尚未同步：[`toolbar-narrow-layout.md`](./toolbar-narrow-layout.md)（B-028）。工具栏左右列按实际控件宽度布局，窄屏标题单行省略，已完成 1080/640 视口与 UI scale 1/1.3 验证。
- 待用户审核、尚未同步：[`css-comment-boundaries.md`](./css-comment-boundaries.md)（B-029）。CSS 注释边界保护已完成自动化与 Chromium 外链 CSS 端到端验证；普通测试书回归与 Windows WebView2 确认仍按发布流程进行。
- 待用户审核、尚未同步：[`trailing-media-float-overflow.md`](./trailing-media-float-overflow.md)（B-030）。末尾递归媒体-only float 的跨列溢出已加入 `scrollHeight` 推算、后代视觉 rect 与碰撞门控；目标书 900×650/1280×800 及四本相邻实书 Chromium 回归完成。
- 上述任务暂留在活动目录保存 Windows 确认证据；确认发布后统一移动到 `../archive/`。
- 0.1.9 测试版范围已经冻结；编译前只接受阻断发布的问题，不从旧路线图自动扩大范围。
