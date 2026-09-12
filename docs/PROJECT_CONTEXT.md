# 项目上下文与接手入口

本文件给没有历史聊天上下文的维护者或 AI 提供最小而稳定的项目认识。详细功能清单见根目录 `README.md`。

## 环境角色

- 隔离开发副本：`<PROJECT_ROOT>/epub-reader`
- 真实 Git 源仓：`<PROJECT_ROOT>/eupb-read`
- 本地测试书目录：`<PROJECT_ROOT>/测试用epub`
- 当前主要平台：Windows；浏览器模式用于快速开发，Tauri 负责桌面交付。

AI 只能修改隔离副本。源仓同步、提交和 GitHub 推送由用户完成。

## 当前基线

- `0.1.9` 已收口；当前隔离副本版本为 `0.1.9-beta.2` 测试版，包含 beta.1 修复、C-53～C-56 的跨书全文搜索流水线、历史字体 C-57 拖动导入以及 RAG C-57 模型资产管理代码。
- 已发布版本：`0.1.5`（已在 Windows 编译、打包并分发）
- 0.1.5 发布提交：`4bb9c7b2e50ef3a13f2cc8cd06d91c25486911b7`
- 当前源仓比较基线（2026-09-11 只读复核）：`4aaa87137e5af237d0594bb64a2d9a285c2dd08c`（`v0.1.9-beta.1`，`main` / 本地 `origin/main`）；工作区干净。
- 基线提交说明：`fix: v0.1.9-beta.1 (search parser strict XML, menu width, context menu anchoring, foreground arbitration B-067..B-071)`。
- 该提交只是当前比较基线；隔离副本此后已有大量未同步代码与文档变化，必须以 `SOURCE_DELTA.md` 为准，不能再视为与源仓一致。
- 2026-09-12 第二轮 B-088～B-090：火焰目录保留长短色块并避免额外空白页，赤月目录条目收回版心，相容同居标题及页面百分比 margin/padding 按有效宽度计算。前端 89 文件/558 用例，Core/AI 各 151 modules 与门禁、32 个实书组合与重排通过；Windows 和汇报人观感待确认，见同一 `toc-width-three-books.md`。
- 2026-09-12 最新基础修复 B-085～B-087：相容同居 message.xhtml 蓝色卡片、前辈 04 目录对称百分比限宽、国王求婚 06 目录竖排 float；前端 87 文件/552 用例、tsc、Core/AI 构建与产物门禁通过，三本目标及标题页/历史目录原书矩阵通过。本轮无 Rust 改动；Windows 待复验。见 `docs/tasks/active/toc-width-three-books.md`。
- 2026-09-11 基础修复 B-082～B-084 已通过本地验证：Vitest 86 文件/547 用例、tsc、Core/AI 前端各 150 modules 与产物门禁、Rust Core 49/49 与 AI 87/87、fmt；Chromium 主题/字号/相邻章往返与笔记创建/重开/编辑通过。详见 `docs/tasks/active/core-reader-fixes-september.md`。Windows 原书库、WebView2 复验与 C-57.6 双安装包验收仍未完成。
- C-57.6 发行门禁代码与本地自动化已经完成：独立前端/Rust产物、Cargo安全默认与显式互斥edition、通用build-info握手、AI CSS/fixture隔离和产物扫描均已落地。当前只剩Windows Core/AI双安装包与人工链路验收；完成前不要直接进入C-58真实Provider。
- `package.json`、Tauri 配置、Cargo 清单和 Cargo 锁文件中的本项目版本均为 `0.1.9-beta.2`。
- 渲染规划：`docs/PRELOAD_PLAN.md` 的 P0 首帧显示门与 P1 前后相邻三槽预加载已实现；P2 动画仍只是后续预留，不要视为已实现。
- C-53 已通过 Windows 验收。C-54/C-56 已完成 schema v3、trigram FTS、短查询、分批 staging、逐书真实建库、共享运行时、真实 Worker、版本跳过/取消/失败隔离、当前书/全部书籍 UI、索引重建/清理和跨书锚点跳转；`0.1.9-beta.2` 基础全文搜索已验收。模型、Embedding、向量、标签和生成仍未实现，RAG C-57 代码现待 Windows 发布版验收，见 `docs/tasks/active/rag-model-asset-management.md`。
- 已验收 C-56：书架搜索新增“书名与作者/正文”切换；书架正文和阅读器“全部书籍”共享唯一应用级运行时与 Rust 持久任务。真实 Worker 池按设备核心自动或手动并发，FTS 保持单写入，大书独占并服从阅读加载优先级；设置仅保存在设备。本阶段只启用 FTS sink，未接 Embedding、向量、标签或生成。8 以上并发的收益与峰值资源仅作为后续性能调查，详见 `docs/tasks/active/shelf-library-search-pipeline.md`。
- 当前待审 B-029：CSS 注释边界保护已接入 `cssRewrite`、sanitize 和 paginator；递归 `@import` 共享保护 context，且已完成 sanitize 外链 CSS 的 Chromium 端到端验证；普通测试书回归与 Windows WebView2 仍按发布流程确认，详见 `docs/tasks/active/css-comment-boundaries.md`。
- 当前待审 B-030：末尾递归媒体-only float 的跨列补偿已接入 paginator；使用首列碎片 top + `scrollHeight` 推算未分片底部，并对候选及后代视觉 rect 做列边界/碰撞事务门控，详见 `docs/tasks/active/trailing-media-float-overflow.md`。title.xhtml whole-page wrapper 仍仅为诊断，未修改。
- 当前待审 B-031：桌面书库已由复制正文改为链接源 EPUB；可同步记录、设备绑定和缩略图缓存分层，支持存档导入/导出、缺失源文件重新定位和视口门控缩略图。自动化完成，Windows 100+ 本发布包性能与原生文件流程仍待确认，详见 `docs/tasks/active/linked-library-refactor.md`。
- 当前待审 B-032：Tauri 桌面端已接入官方单实例插件并保证其最先注册；重复启动会显示、取消最小化并聚焦已有 `main` 窗口。Rust 自动化完成，Windows 普通/最小化重复启动仍待实机确认，详见 `docs/tasks/active/desktop-single-instance.md`。
- 当前待审 B-033：阅读跳转历史改为最多 3 条 back/forward 双栈；App 使用初始保存位置基线与 paginator display-ready/同章 settled 门控，首次及连续 fragment 跳转都不再漏记，anchor 优先于页码恢复，转场期间不写旧 ready 进度，实际页状态而非仅整数百分比触发保存，详见 `docs/tasks/active/reader-navigation-history-forward.md`。
- 当前待审 B-034：目录顶层无作者水平 margin 的 left/right float 在宽视口回到居中的 40rem 版心边缘；全页/全宽意图、作者 margin 和过宽盒保守跳过，640px 窄容器保持自然布局，详见 `docs/tasks/active/toc-top-float-containment.md`。
- 当前待审 B-035：多看图片脚注富 HTML 复制到宿主弹层后，定向隐藏 `.duokan-footnote-content` 生成的注释 marker 并清零左 padding；普通作者列表保持编号，详见 `docs/tasks/active/footnote-rich-content-marker.md`。
- 当前待审 B-048：桌面链接导入与浏览器预览已统一 `cover-image → meta cover → cover.*` 封面候选契约；发布版漏封面来自 Rust 原生 OPF 解析而非 WebView2/WebP 解码。候选仅查询已打开 ZIP 中央目录，不解压、不扫描整书；全量 Vitest 34/315、Rust 13/13、TypeScript/Vite 均通过，详见 `docs/tasks/active/cover-fallback-contract.md`。
- 当前待审 B-049：设置详细数值步进按可见默认值使用纯数值有序档位；最小/最大边界继续点击返回原 settings identity，不触发无效阅读器重载；全量 Vitest 35/319、TypeScript/Vite 与 WSL Chromium 真实点击/reload 计数均通过，详见 `docs/tasks/active/settings-stepper-bounds.md`。
- 当前待审 B-050：打开期阅读进度已将位置证据与暂时百分比解耦；结构 estimated 计数支持版本化本机缓存（contentHash 优先、256 entries/100000 counts、非 estimated merge-preserve）、默认每 slice 4 章/100ms timeout 的有界 job、error/媒体权重；新导入时间、存档阅读证据 merge 和每会话 progress writer 均已接入，详见 `docs/tasks/active/reading-progress-open-session.md`。全量 Vitest 36/332、tsc、Vite 98 modules、Rust 14/14 + fmt/check 已通过；Windows WebView2/发布包仍待用户补验。
- 当前待审 B-051：首次进入书籍的首次白屏/首个 display-ready 前，滚轮/方向键/PageUp/PageDown/空格/工具栏翻页意图全部丢弃，不在首次 ready 后回放；首次 ready 清理外层滚轮累计，已显示书籍的跨章 loading 仍保留最后方向单槽。纯逻辑 turnIntent 9/9、全量 Vitest 36/334、tsc 通过；Windows WebView2 真实输入仍待确认，详见 `docs/tasks/active/initial-turn-intent-gate.md`。
- 当前待审 B-052：App 宿主与 iframe paginator 共用 DOM selection guard，仅拦截非编辑区域 Ctrl/Cmd+A，编辑控件及其后代放行；进入 reader 时清理一次宿主旧 selection，不影响方向键与正文手动选择。定向 76/76、全量 Vitest 37/337、tsc、Vite 99 modules 已通过；Windows WebView2 selection 行为仍待确认，详见 `docs/tasks/active/selection-shortcut-guard.md`。
- 当前待审 B-053/C-42：dark theme 在 iframe load 后首次 measure 前按有效 alpha 背景与 WCAG contrast 保守修正局部元素；按 html→body 单次 DFS 读取每个元素样式，背景图、未知/opacity/作者不同色跳过，marker 随文档销毁。定向 68/68、全量 Vitest 38/341、tsc、Vite 100 modules 与 WSL Chromium 1280×800 目标资料⑤实机结果已记录；Vite 后已释放 5173，Windows WebView2 主题矩阵仍待确认，详见 `docs/tasks/active/dark-theme-contrast-guard.md`。
- 当前待审 B-054/C-43：iframe 脚注 marker 与宿主弹层共享 140ms hover grace；普通正文 mouseover 不触碰 gate，重复 mouseover 不重复显示，固定/关闭/章节 cleanup 语义保持。定向 84/84、全量 Vitest 39/345、tsc、Vite 101 modules 与 WSL Chromium 640×480 `note_ref020` 交接实机结果已通过；5174 已释放，Windows WebView2 窄窗 hover 仍待确认，详见 `docs/tasks/active/footnote-hover-grace.md`。
- 当前待审 B-055/C-44：FootnotePop 已移入 `.main` 统一 marker 局部坐标；placement helper 处理极窄窗口完整可见、左右/上下切换、容器 maxHeight 与尺寸变化。Root 独立验收的 `pnpm exec vitest run` 40/353、`tsc --noEmit`、`pnpm build` Vite 102 modules 与 WSL Chromium 640×480 `note_ref020` fullyInside/无截断证据均通过；5173/5174 无监听，Windows WebView2 UI scale 仍待用户确认，详见 `docs/tasks/active/footnote-placement-narrow-window.md`。
- 当前待审 B-056/C-45：dark theme 仅在 `#epub-viewer` 根容器注入可继承的 `text-shadow: 1px 1px 1px #1e1e1e`，为浅色盒/复杂背景提供低侵入可读性兜底；不使用 `#epub-viewer *` 或 `!important`，light/sepia 不注入，作者后代显式声明可覆盖。sanitize 定向 54/54（含 `none`/特效保留），Root 独立复验全量 Vitest 40 文件/354 tests、tsc、Vite 102 modules；Windows WebView2 观感与长章节性能仍待用户，详见 `docs/tasks/active/dark-theme-text-shadow-fallback.md`。
- 当前待审 B-057/C-46：可重排章节新增 `forceHorizontal` 设置，详细菜单可将竖排转换为横排；sanitize 覆盖 html/body/viewer 及非 SVG 树普通后代的标准与 Chromium vendor `writing-mode`，不改 direction，固定版式屏蔽。旧设置 undefined 兼容 false，localStorage/portable archive 均保留字段；Root 独立全量 Vitest 42 文件/359 tests、tsc、Vite 102 modules 及 `/tmp/vertical-smoke.epub` 900×650 WSL Chromium 烟测通过：开启后根级/嵌套 probe 为 `horizontal-tb`、`text-orientation=mixed`，SVG 显式 `vertical-rl` 保持，页码 1/1；Windows WebView2/真实竖排书仍待用户，详见 `docs/tasks/active/force-horizontal-reading.md`。
- 当前待审 B-058/C-47：Windows 系统字体通过 DirectWrite `system_fonts_list` 返回 family/localizedNames，无路径/文件读取；系统字体只在首次打开字体中心枚举并会话缓存，Android 仅接口预留。独立字体中心提供 tabs/search、导入/删除和按实际容器高度计算、带 spacer 的真实虚拟列表；imported 启动只 list 元数据，当前选择才 read 一个 Blob，竞态/切换/失败 URL ownership 已覆盖；`fontSource`/`customFontId` 已接入 storage/archive。Root 独立前端全量 Vitest 44 files/365 tests、tsc、Vite 104 modules；Rust fmt/check/test 17/17。WSL Chromium 模拟 300 imported 通过启动 get=0、末尾可达 Font299、选择 get=1、z42>z41/hitInside 与 source/id 证据；900×900 动态视口实测高度 292px/DOM rows=13，搜索后 scrollTop=0，最终补丁后定向 63/63、tsc、Vite 再通过。5173/5174 无监听。Windows target cargo check/tauri build、真实枚举、本地化 CSS family 和 WebView2 实机仍待确认，详见 `docs/tasks/active/font-center-system-fonts.md`。
- 当前待审 B-059/C-48：当前打开的可重排 EPUB 已支持按需、按 spine 顺序的正文搜索；会话缓存章节文本，逐章 yield，可取消并以 generation 防旧回写。标准化处理 NFKC/小写/软连字符/布局空白，排除隐藏结构与脚注，支持短语和同上下文多关键词 AND；正文索引使用紧凑字符串和 TypedArray 映射，结果最多保留 101 条、UI 展示 100 条，提供原文高亮与 code-point 文本锚点跳转，点击才进入既有 3 步历史。全量 Vitest 46 files/377 tests、tsc、Vite 106 modules；WSL Chromium 900×650 实测“opacity 属性”4 条结果及 back/forward 已通过。无持久化索引、跨书搜索、模糊/语义/RAG 功能，详见 `docs/tasks/active/reader-text-search.md`。
- 当前待审 B-060/C-49：可重排正文已支持选区右键添加笔记、本书笔记列表、编辑/删除、文本锚点跳转和既有三步历史。下划线只使用 CSS Custom Highlight，不修改书籍 DOM；notes 已进入前端/Tauri 书架记录及 portable archive。全量 Vitest 50 files/393 tests、Rust 18/18、tsc、Vite 110 modules与 WSL Chromium 真实链路通过，Windows WebView2 待确认；详见 `docs/tasks/active/reader-notes.md`。
- 当前待审 B-061/C-50：菜单新增默认关闭的“高性能模式”。可重排书最多保留上一篇/当前篇/下一篇三个同尺寸槽位，后台严格先下一篇、后上一篇，顺序跨章直接提升并保留旧章为反向缓存；显式跳转与未命中仍走 P0。开关不重载当前章，设置/字体/尺寸变化和生命周期会销毁备用槽；fixed-layout 禁用。详细设置已统一为主题色浅卡片和 42×24 现代开关，纸色衬底不再过深；窄窗下滑块和开关卡片统一为同宽同高，步进按钮不溢出且开关标题无多余顶部空白。全量 Vitest 51 files/402 tests、tsc、Vite 110 modules 与 WSL Chromium 实书三 Blob/约 7ms 回翻及 640×520 菜单实测通过；Windows CPU/内存、连续快速翻章与视觉待确认，详见 `docs/tasks/active/next-chapter-preload.md`。
- 当前待审 B-062/C-51（含 B-063～B-066）：书架新增带动画的二级筛选抽屉，收纳搜索、排列、密度、主题、存档导入/导出；可按作者、书名、保存时间、语言组合筛选。作者分组使用 NFKC 与 CJK 间 Unicode whitespace/Cf 清理但不改原 OPF 值，language 已进入浏览器/Rust/portable archive，旧记录显示未知且不扫描源文件。书架顶部 Toolbar 已移除，阅读器 Toolbar 保留；抽屉滚动区填满剩余高度并预留稳定滚动槽，搜索使用 SVG 图标严格居中，筛选展开不再引起横向缩窄。全量 Vitest 52 files/407 tests、Rust 19/19、tsc、Vite 110 modules 与 Chromium UI 链路通过；Windows 原生导入和 100+ 本实机待确认，详见 `docs/tasks/active/shelf-filter-drawer.md`。
- beta.1 B-067：阅读器 `.menu-panel` 预留稳定滚动槽，展开详细设置后设置卡片不再因滚动条出现而变窄。
- beta.1 B-068：Windows 发布版正文搜索空结果的差异定位到 XHTML 被无条件按 HTML 解析；现改为严格 XML 优先、失败再回退 HTML。全量 Vitest 52/410 与 Vite 110 modules 通过，待 Windows 原故障书复验。
- beta.1 B-069：正文选区菜单改以 Range 末尾可见片段定位；菜单打开期间 selectionchange 刷新位置，选区折叠/失效立即关闭，宿主关闭同步清除 iframe 选区。当前全量 Vitest 52/411，待 Windows WebView2 实机确认。
- beta.1 B-070：搜索输入框屏蔽 WebView2 原生清除装饰，只保留自定义按钮；长查询单行内部滚动、不会撑宽面板或遮住按钮。当前全量 Vitest 52/414。
- beta.1 B-071/C-52：阅读器菜单/目录/书签/搜索/笔记/日志、正文 transient 与笔记 modal 已收敛到单一 `ReaderForeground`；字体是菜单子视图，modal 全窗口独占。全量 Vitest 53/420、Vite 111 modules，详见 `tasks/active/reader-foreground-arbitration.md`。
- 当前暂缓事项：第三方许可草案已因网络波动前任务延迟落盘，现有 `THIRD_PARTY_LICENSES.md`、许可证文本目录、NOTICE/README/贡献条款、package/Cargo SPDX 字段与 Tauri bundle resources；但逐包传递依赖/版权/NOTICE 审计、Windows 安装包实证、图标授权和 Linux LGPL 边界均未验收。`SOURCE_DELTA.md` 与 `HANDOFF.md` 将其明确标记为“草案已存在、暂时搁置”，后续对话不得视为正式完成。

当前未同步变化以 `docs/SOURCE_DELTA.md` 为准，不要仅根据本节判断。

## 2026-08-24 当前 RAG C-57 交接

`0.1.9-beta.2` 的基础全文搜索 Windows 验收已完成；RAG C-57 的 Windows Tauri dev 核心资产链路（首次读取、D 盘模型库、探针登记/许可/下载、重启持久化和显式校验）也已通过，删除、linked 和真实大文件故障矩阵仍待发布版验收。C-57 已实现多文件模型 manifest、managed/linked ownership、模型库设备路径、schema v4→v6、单 FIFO Range 下载器、`.part`/SHA/磁盘/镜像/重启恢复基础和 dev-only 管理入口，但尚未实现真实 ONNX/GGUF/Ollama/API Provider、模型运行、Embedding、向量、标签或生成。

本轮自动化基线为前端 Vitest 77 files/521 tests、TypeScript、Vite production build 143 modules、Rust fmt/check 与 72 tests。B-075/B-076/B-077 已分别修复开发 Strict Mode 永久 loading、Windows localhost 探针地址不一致和 SHA 校验栈溢出；Windows 仍需实机验证真实慢速/断网大文件、错误 digest 镜像回退、磁盘不足、多进程/IPC 并发、重启续传、junction/reparse、Defender 文件占用和中文/日文长路径。

模型资产不是 Provider 插件：`ModelPackageManifest` 只描述模型文件，`ProviderManifest` 继续描述运行方式；`findAvailableModelPackages` 只是 verified 元数据过滤，C-58 才能实例化 Provider。正式版不显示公共模型市场，`c57-dev-probe` 仅 15 字节纯文本开发 fixture，release command 拒绝且不代表真实模型。

2026-08-24 路线再次修订：由于 CPU 大模型性能和整机响应风险，模型运行阶段拆为 C-58A Windows GPU/后端探测、支持矩阵和资源准入，以及 C-58B GPU-first ONNX Embedding Provider；后续 llama.cpp 生成同样 GPU-first。普通模式为自动推荐、GPU 兼容、NVIDIA CUDA、CPU 兼容；CPU 只显式限额启用，GPU 失败不得静默回退。2026-08-27 又在其前插入 C-57.6 与 C-58-Prep；具体顺序以 `SEARCH_TO_RAG_ROADMAP.md` 为准。

2026-08-27 C-57.5 已实现Core/AI编译隔离并待Windows安装包审核：默认Windows脚本构建Core，保留全文搜索但裁掉模型资产前端chunk、Rust `models/download`、模型IPC和可选`reqwest/fs2`；AI edition显式启用前后端`ai`开关，使用独立`dev.epubreader.ai`安装身份与app-data。前端78 files/523 tests、tsc、Core/AI production build及Windows Cargo Core 38/AI 72 tests已通过；PowerShell真实双打包和人工链路仍未验证。任务见`docs/tasks/active/core-ai-edition-split.md`。

2026-08-28 C-57.6 已完成隔离副本实现与本地矩阵：默认与显式Core/AI命令统一派生前端edition、Cargo feature、Tauri overlay和独立产物目录；release缺少/错误 expected edition、冲突feature与启动握手不匹配都会fail-closed；Core产物不再含AI CSS、模型IPC或开发探针。未修改schema、app-data、Provider、GPU或向量行为；Windows双包仍待验收。

## 运行时主链路

```text
EPUB bytes
  → ZIP/container.xml
  → OPF metadata + manifest + spine
  → EPUB 3 NAV / EPUB 2 NCX / spine fallback
  → Book + ResourceServer
  → sanitizeChapter
  → Blob iframe
  → ChapterPaginator 多栏测量
  → 页码、内容锚点与进度持久化
```

## 模块地图

- `src/core/book.ts`：加载总编排、资源清单、目录、字体混淆、DRM。
- `src/render/sanitize.ts`：危险内容移除、资源和 CSS 改写、阅读器样式注入。
- `src/render/displayGate.ts`：保持布局能力的 visibility 显示门、代次与超时恢复。
- `src/render/paginator.ts`：章节生命周期、测量、分页、锚点、输入和运行时布局补偿。
- `src/ui/ReaderView.tsx`：React 与分页器之间的适配层。
- `src/App.tsx`：书架、阅读会话、设置、进度和面板状态编排。
- `src/ui/shelf.ts`：Tauri 链接书库/IndexedDB 隔离预览的统一存储接口。
- `src/ui/importBooks.ts`：内容指纹、旧条目懒判重、批量结果提示与一次性书架合并。
- `src/ui/progressWriter.ts`：同书最新值优先的串行进度写入与退出 flush。
- `src/ui/libraryArchive.ts`、`libraryArchiveBridge.ts`：无设备路径的存档 schema、校验、合并与书架投影。
- `src/ui/thumbnail.ts`：近视口缩略图调度、尺寸/格式派生与 Blob 生命周期。
- `src-tauri/src/linked_library.rs`：链接书库索引、流式哈希、ZIP 元数据、源文件读取/重新关联和有界缩略图缓存。
- `src-tauri/src/lib.rs`：Tauri 插件初始化、命令注册和自定义字体命令；旧复制式书库命令不再注册。

自定义 CSS 由 `MenuPanel` 本地草稿承载，只有“保存并应用”才触发父级提交和章节重载；浅色安全 `body bgcolor` 作为同一 override style 的默认 `background-color`，用户 CSS 位于其后，深色/纸色忽略书籍颜色。多个 CSS 预设仍是 optional backlog，需要 presets schema、UI CRUD 和旧 `customCss` 迁移。

工具栏由 `Toolbar` 测量左右控件实际 layout 宽度并取最大值形成对称侧轨，中间使用 `minmax(0,1fr)`；宽屏可完整标题必须居中，720px 以下切回不对称 max-content 轨道并单行省略。按钮不可通过隐藏/裁切解决布局问题，UI scale 只作用于界面。

## 修改前必须理解的事实

1. EPUB 文件高度不统一，容错是产品能力，不是附带补丁。
2. 书籍 CSS 应尽量保留；阅读器 CSS 按 L1–L5 分层，详见 `rendering-layers.md`。
3. CSS 多栏会出现 Chromium 特有测量问题，因此分页器存在二次 margin、fit-content、float 和 computed-right 行内盒溢出修正；逻辑 `end` 暂不处理以避免 RTL 误伤。
4. 字号、窗口和图片加载都会触发布局变化，阅读位置必须依赖内容锚点恢复。
5. 章节加载和重排是异步的，过期任务不得写回新章节状态。
6. blob 章节在首次测量、二阶段补偿、分页自愈与入口定位完成前保持 `visibility:hidden`；不能改成 `display:none`，否则无法离屏测量。
7. 隐藏 iframe 不接收鼠标命中，连续滚轮还可能把目标锁定在外层直到手势结束；外层阅读区在加载期把输入压缩成最后方向，display-ready 后则继续按 80px 阈值翻页。不能改回非 ready 直接丢弃、ready 后忽略外层事件或按加载期事件数排队。
8. 有效书内目录、普通内部链接和存在目标的同章 fragment 跳转都应进入 back/forward 双栈，每栈最多 3 步；目录/书签 UI 入口先记录再执行纯跳转，Paginator 内部链接先发带 href 的 before 通知再路由，无效目标、外链和脚注不记录。ReaderView 转发给长生命周期 paginator 的回调必须使用 latest ref。
9. 章节在 iframe 中渲染，但脚本、表单、嵌套 iframe 等危险能力会被移除并由 CSP 再限制。
10. Tauri 与浏览器开发模式使用不同存储后端，但对 UI 暴露同一 `ShelfStore` 语义；浏览器 IndexedDB 仍会保存测试字节，不代表桌面持久化设计。
11. Tauri 新导入以 EPUB 完整字节 SHA-256 识别精确重复，正文留在用户原路径；同内容重命名/重新导入只更新本机绑定，不覆盖进度、书签和首次添加时间。
12. 可同步 `LibraryRecord` 不得出现绝对路径；设备 `DeviceBinding` 与最大 100 MiB 的缩略图缓存不得进入导出存档。源文件缺失或内容变化时保留记录并标记不可用，重新定位必须复核完整哈希。
13. 进度写入是单通道最新值优先；首次稳定值立即提交，后续更新合并，返回书架、隐藏和桌面窗口关闭前会 flush。首次打开的 `markOpened` 只能清除新书标记。
14. Windows 大型正文/封面 IPC 必须走 Tauri raw body；禁止恢复 `Array.from(bytes)` 数字数组。批量导入只把路径交给 Rust 流式处理，整批结束后一次更新书架。

## 高风险修改区域

- `src/render/paginator.ts`：布局时序和阅读位置高度耦合。
- `src/render/sanitize.ts` 与 `src/render/cssRewrite.ts`：规则可能影响所有 EPUB。
- `src/App.tsx`：包含大量跨界面状态与持久化副作用。
- `src/styles.css`：书架、阅读器和弹层共享，视觉改动容易互相影响。

修改这些区域时应优先增加最小复现和回归证据，而不是扩大改动范围。

## 文档导航

- 协作规范：`../CONTRIBUTING.md`
- 模块稳定契约：`MODULE_CONTRACTS.md`
- 隔离副本差异：`SOURCE_DELTA.md`
- Bug 选择记录：`BUGFIX_LOG.md`
- 渲染冲突台账：`rendering-layers.md`
- 开发与发布说明：`HANDOFF.md`
- 任务模板：`tasks/TEMPLATE.md`
- 当前测试入口：`RELEASE_0.1.9-beta.2.md`；beta.1 与正式版文档保留为历史，正式版历史为 `RELEASE_0.1.9.md` 与 `tasks/active/version-0.1.9-release-candidate.md`。
- 搜索到 RAG 的长期路线：`SEARCH_TO_RAG_ROADMAP.md`；插件模块架构：`AI_PLUGIN_ARCHITECTURE.md`；当前地基任务：`tasks/active/rag-plugin-foundation.md`（代码/自动化完成，Windows Tauri 待验收）。
