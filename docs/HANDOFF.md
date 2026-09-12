# 开发文档

本文档面向维护者与贡献者，介绍项目结构、开发命令、渲染分层规范与回归测试方式。

> 项目自述与功能列表见根目录 [README.md](../README.md)。

> 正文搜索、语义检索、智能分类、RAG 问答与正文总结的长期方向见 [SEARCH_TO_RAG_ROADMAP.md](SEARCH_TO_RAG_ROADMAP.md)。当前已完成 B-059/C-48 的当前书基础正文搜索，并在隔离副本实现 C-54 跨书全文检索；语义检索、智能分类、RAG 问答与正文总结仍是后续范围，不得视为已实现或稳定发布能力。

> C-53 已通过 Windows 验收。C-54 已在隔离副本接通 schema v3/trigram FTS、分批 staging、逐书真实建库、当前书/全部书籍 UI、索引管理和跨书锚点跳转；B-072/B-073 已修复 Windows 旧记录 `language=""` 和图片封面空正文导致的全库失败，解析版本升至 `visible-xhtml-v2`。自动化为前端 63/467、Rust 37/37，37 本真实 EPUB/3094 chunks 语料回放通过，等待 Windows 用原书库重新建库审核。真实模型、Embedding、向量、标签和生成仍未实现。架构见 [AI_PLUGIN_ARCHITECTURE.md](AI_PLUGIN_ARCHITECTURE.md)，当前任务见 [cross-book-fts-search.md](tasks/active/cross-book-fts-search.md)。

> C-56 已在隔离副本完成书架正文搜索与共享语料流水线，并随 `0.1.9-beta.2` 完成 Windows 基础全文搜索验收：书架和阅读器共用一个全库运行时与持久任务，生产包使用真实 module Worker；并发可按核心自动/手动配置，FTS 单写入，大书独占并在阅读加载时让出。模型、向量、标签和生成仍未接入，见 [shelf-library-search-pipeline.md](tasks/active/shelf-library-search-pipeline.md)。

> C-57 已为字体中心增加浏览器与 Windows 双通道拖放：字体面板内可批量拖入 TTF/OTF/WOFF/WOFF2，Windows 原生路径按坐标路由并复用原字体存储；多文件串行且不干扰面板外 EPUB 导入。主代理审核后前端 73/509、tsc、Vite 137 modules 通过，见 [font-drag-import.md](tasks/active/font-drag-import.md)。

> B-060/C-49 正文笔记首版已经进入隔离副本：选区右键、创建/编辑/删除、按时间列表、文本锚点跳转、CSS Highlight 下划线和 portable archive 均已接入。Windows WebView2 实机仍待审核，契约见 [reader-notes.md](tasks/active/reader-notes.md)。

> B-061/C-50 实验性“高性能模式”已经扩展为前后相邻三槽：默认关闭，后台严格先下一篇、后上一篇，槽位完全静默，顺序跨章命中后直接提升并保留反向缓存；固定版式和未命中保持标准加载。详细设置同时统一为主题色浅卡片与现代开关，纸色对比度已改善。Windows 性能、内存与视觉实机仍待审核，见 [next-chapter-preload.md](tasks/active/next-chapter-preload.md)。

> B-062/C-51 书架二级筛选抽屉已经进入隔离副本：作者/书名/保存时间/语言组合筛选、搜索/排列/密度/主题/存档迁移、轻量动画及书架顶部工具栏移除均完成。OPF language 已贯通浏览器、Rust 和 portable archive；旧记录不扫描源书，显示“未知语言”。B-063～B-066 已让滚动区填满抽屉标题以下空间、预留稳定滚动槽，并修复搜索图标视觉居中；展开筛选出现滚动条时选项宽度不再变化。Windows 原生导入与 100+ 本视觉性能待审核，见 [shelf-filter-drawer.md](tasks/active/shelf-filter-drawer.md)。

> 0.1.9 已完成发布收口；当前隔离副本为 `0.1.9-beta.2` 测试版。它包含 beta.1 修复以及 C-53～C-56 的跨书全文搜索、书架入口、共享状态和真实 Worker 流水线；beta.1 文档继续作为历史记录。

> `0.1.9-beta.1` 的 B-068 修复 Windows 发布版正文搜索始终空结果：搜索正文解析现在与渲染链路一致，先按 XML/XHTML 严格解析，仅在 parser error 时回退 HTML。自动化覆盖自闭合 head 标签和畸形旧 HTML；仍需 Windows 原故障书确认。

> `0.1.9-beta.1` 的 B-069 修复正文选区菜单：锚点取选区最后一个可见片段，菜单打开后由 iframe selectionchange 更新或关闭；正文左键取消选区、Escape 和宿主外部关闭均结束菜单生命周期。全量 Vitest 52/411、tsc、Vite 110 modules 通过。

> `0.1.9-beta.1` 的 B-070 隐藏 WebView2 原生 search 清除装饰，只保留应用自定义按钮；长查询维持单行内部滚动，面板不扩宽且按钮不被文字遮挡。Luna High 实现，主代理审核及全量 Vitest 52/414、tsc、Vite 110 modules 通过。

> `0.1.9-beta.1` 的 B-071/C-52 将全部阅读器前台层收敛到单一 `ReaderForeground` 判别联合：普通 panel 严格互斥，脚注/选区 transient 替换 panel，笔记 modal 独占全窗口；字体中心是菜单子视图。Luna High 迁移、主代理审核，全量 Vitest 53/420、tsc、Vite 111 modules 通过，见 [reader-foreground-arbitration.md](tasks/active/reader-foreground-arbitration.md)。

## 技术栈

- 外壳：Tauri 2（Rust）
- 前端：React 18 + TypeScript + Vite
- EPUB 解包：fflate（纯前端 ZIP 解析）
- 分页：CSS multi-column（自研分页控制器）
- 测试：Vitest（单元测试）+ Playwright（端到端回归）

## 架构分层

```
src/
  core/        解析内核（纯 TS，无 DOM 依赖）
    zip.ts         ZIP 解包 + mimetype 校验
    book.ts        加载编排（manifest/spine/guide/目录/字体/DRM）
    opf/ncx/nav    包文档与目录解析
    fonts.ts        IDPF 字体混淆还原
    paths/xml      路径解析与 XML 解析
  render/      渲染层
    sanitize.ts     章节消毒 + 阅读器分层样式注入
    cssRewrite.ts   CSS url() 改写与宽度兼容
    paginator.ts    分页/翻页/锚点/进度/运行时排版修正
    resources.ts    书内资源服务
    footnotes.ts    脚注识别（含图片/富文本注释）
  ui/          界面
    ShelfView.tsx   书架（网格/搜索/排序/密度/主题/批量选择）
    ReaderView.tsx  阅读视图
    Toolbar / TocPanel / MenuPanel / FootnotePop / LogPanel
    shelf.ts        Tauri 链接书库 + IndexedDB dev 的统一接口
    libraryArchive  无设备路径的存档 schema、校验与合并
    thumbnail.ts    近视口缩略图队列与派生
    storage.ts      设置与阅读进度
  test/        测试夹具与单元测试
src-tauri/    Tauri 2 壳（Rust 链接书库、缩略图缓存与字体命令）
scripts/      构建/自检/测试工具
```

AI/RAG 代码已经按独立 `src/features/ai` 与 `src-tauri/src/ai` 职责落地；`App.tsx` 只组合入口、书籍投影与跳转。后续 Provider、向量、标签和生成继续通过 feature controller/store 与语料 sink 扩展，禁止把任务或模型状态重新集中进 `App.tsx`。

## 开发命令

```bash
pnpm install
pnpm dev              # Core 浏览器开发模式（localhost:5173）
pnpm dev:ai           # AI 浏览器开发模式
pnpm test             # 单元测试（当前基线 83 files / 537 tests）
pnpm build            # Core：TypeScript + dist/core + 产物门禁
pnpm build:ai         # AI：TypeScript + dist/ai + 产物门禁
pnpm tauri:dev:core   # Core 桌面调试
pnpm tauri:dev:ai     # AI 桌面调试
```

Windows 正式打包使用 `scripts/build-windows.ps1 -Edition Core|AI`；裸 `pnpm tauri build` 因缺少 release expected-edition 元数据会主动失败。0.1.9 的 WSL→Windows 安全同步与测试版验收见 `docs/RELEASE_0.1.9.md`。0.1.8 文档仅保留为阶段历史。
当前 Windows 测试发行入口见 `docs/RELEASE_0.1.9-beta.2.md`。

## 渲染分层规范

阅读器注入样式遵循五层模型，避免规则互相打架：

| 层 | 职责 | 示例 |
|---|---|---|
| L1 安全/消毒 | 删除脚本、危险属性、隐藏脚注 aside | `#viewer aside[epub:type=footnote]{display:none!important}` |
| L2 用户设置 | 字号、主题、行高、字重、间距 | `html{font-size:...!important}`、主题色 |
| L3 阅读器默认版心 | 40rem 版心、页面级居中、图片防溢出 | `:where(#viewer .reader-top){max-width:40rem}` |
| L4 书内容布局 | 书的 margin/width/max-width/float/font 设计 | 不注入，运行时测量后决定 |
| L5 引擎兼容补偿 | CSS 多栏的 fit-content / float 收缩异常 | 运行时按触发条件兜底 |

完整说明、每条规则的冲突台账与新增规则检查清单见 [rendering-layers.md](rendering-layers.md)。

## 关键设计

### 分页与阅读位置

- 页面宽度 = 窗口全宽，内容宽度由 40rem 版心控制；
- 阅读位置 = 章节索引 + 页号 + 内容锚点（元素序号 + 元素内横向比例 + 字数位置）；
- 字号/窗口变化后按锚点恢复，页号只在锚点失效时兜底。

### 宽度百分比兼容

书里的 `width:X%` 按“页面 ≈ 版心”书写，阅读器页面是全窗口宽。为避免 90% 的盒子占满整页、同时又避免误伤 td 等窄容器，改写为：

```css
width: X% → width: min(X%, X/100 × 40rem)
```

页面级取版心比例，窄容器由浏览器按真实包含块取较小值；`>100%` 的出血意图保持原样。

### 脚注弹层

- 支持多看/掌阅类和脚本型 `<note>` 两类结构；
- 支持图片注释（弹层渲染富内容 HTML）；
- 悬停临时展示，点击固定；固定后可在弹层内滚动超长内容；
- 弹层内滚轮不触发翻页；返回链接跳回正文标记；外链交系统浏览器。

### 书架存储

- Tauri 环境使用链接式书库，用户源 EPUB 留在原路径，不复制到应用目录，也不会在删除书架条目或卸载时被应用删除。
- 可同步状态保存为 `app_local_data_dir()/linked-library/library-records.json`；本机绝对路径、stat 与封面 ZIP 定位单独保存为 `device-bindings.json`。书籍 ID 是 EPUB 完整字节的小写 SHA-256。
- 设备缩略图位于 `app_local_data_dir()/linked-library/thumbnails/`，最大 240×360、全局四并发、单项 5 MiB、LRU 总上限 100 MiB；启动会清理索引外孤立文件和临时文件。
- 重复导入只更新同哈希的本机绑定，不覆盖进度、书签或首次添加时间；源文件缺失时保留记录，重新定位必须再次匹配完整哈希。
- “导出存档”产生不含路径、正文、封面和缩略图的 v1 JSON；浏览器开发环境仍使用 IndexedDB 保存测试字节，只是 UI 语义回退，不代表桌面持久化设计。
- 完整实现与 Windows 待验收项见 `docs/tasks/active/linked-library-refactor.md`，不要恢复旧 `shelf.json`/`books/<id>` runtime 命令。

## 测试

### 单元测试

当前 `pnpm test` 基线为 35 个测试文件、319 项；另有 Rust 13 项测试。覆盖解析内核、消毒与 CSS 改写、脚注识别、链接书库/存档/缩略图、桌面单实例恢复顺序、阅读历史状态机、书架纯函数、怪书容错及分页交互回归等。

### 端到端回归

使用项目内 Playwright 无头浏览器，重点覆盖：

- 书架：导入/批量导入、去重、进度恢复、批量选择删除、搜索排序、主题同步；
- 阅读：翻章、回翻上一章停在最后一页（无第一页闪帧）、目录跳转、页内锚点；
- 脚注：图片注释、固定弹层、超长滚动、弹层上不翻页；
- 渲染：多字号版心居中、书内百分比宽度兼容。

运行端到端脚本需要先构建前端（`pnpm build`），并准备好无头浏览器依赖（见 `scripts/setup-pw-fonts.mjs` 与 Playwright 文档）。

## 桌面构建

跨平台原则：各平台使用本机工具链原生编译，不做交叉编译。

- Windows：MSVC + WebView2，`scripts/build-windows.ps1`；
- Linux：需 `pkg-config`、GTK/WebKitGTK 开发包；
- macOS：需要 macOS 系统与 Xcode Command Line Tools。

版本号需保持四处一致：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、根包在 `src-tauri/Cargo.lock` 中的版本。

## 第三方许可材料（草案已存在，暂时搁置）

当前项目原创代码采用 Apache License 2.0。截至 2026-08-22 的锁文件审计没有发现会强制整个项目改用 GPL/AGPL 的依赖；Rust 锁文件包含 5 个 MPL-2.0 crate（`cssparser 0.36.0`、`cssparser-macros 0.6.1`、`dtoa-short 0.3.5`、`option-ext 0.2.0`、`selectors 0.36.1`）。`r-efi 5.3.0/6.0.0` 的声明为 `MIT OR Apache-2.0 OR LGPL-2.1-or-later`，草案按 MIT/Apache-2.0 选项记录；Windows WebView2 不按 GPL/LGPL 组件处理。Linux 若捆绑 WebKitGTK，需要另做 LGPL 分发审计，不能直接沿用 Windows 结论。

网络波动前启动的修改在 2026-08-22 交接文档首次写入后延迟落盘。当前已经存在以下**草案材料**：

- `THIRD_PARTY_LICENSES.md` 与 `third-party-licenses/` 中 9 份标准许可证文本；
- `NOTICE` 的第三方说明，以及 README 的第三方许可证入口；
- `package.json`、`src-tauri/Cargo.toml` 的 `Apache-2.0` 字段和已更新的 Cargo authors；
- `CONTRIBUTING.md` 的 Apache-2.0 入站贡献条款；
- `src-tauri/tauri.conf.json` 的 `bundle.license` 与许可材料 `resources`；
- 根 `LICENSE` 权限已为 `644`。

这些文件**尚未完成最终验收，当前明确暂时搁置，等待进一步补充**。剩余事项如下：

- `THIRD_PARTY_LICENSES.md` 目前以主要直接依赖和许可证类型为主，尚未逐项确认所有实际进入 Windows 二进制的传递依赖、逐包版权声明及上游 NOTICE 是否完整；
- 尚未人工复核草案中的版本、版权年份、源码链接和标准许可证文本是否与锁文件/上游原文完全一致；
- Tauri bundle 虽已声明 resources，但尚未在新的 Windows NSIS 安装目录和免安装分发包中验证文件实际存在、可读；是否另加 `bundle.licenseFile` 也尚未决定；
- 应用图标的来源、原创性或再分发授权尚未留档；
- 尚未建立目标平台感知的许可证/SBOM 自动生成、依赖升级复核和 GPL/AGPL/LGPL-only/未知许可证 CI 门禁；
- Linux WebKitGTK 的 LGPL 分发策略尚未制定。

恢复本项时，应先对草案做目标平台感知的逐包审计，再补齐归属/NOTICE，最后在 Windows 安装包与免安装压缩包中验收。完成这些步骤之前，不要把“第三方许可合规与发行包落地”标记为完成，也不要把草案状态表述为正式法律审查结论。

## 发布前检查清单

1. `pnpm test` 全部通过；
2. `pnpm build` 通过；
3. 真机（各目标平台）至少执行一次书架导入/阅读/返回/重启恢复；
4. 版本号三处一致；
5. 更新 README 功能列表与本文档变更记录；
6. 若对外分发，确认第三方许可暂缓项已经完成，或明确本次发行仍不包含其合规收口。

## 2026-08-24 跨书索引恢复交接

- “全部书籍”现在只探测索引状态，必须由用户确认硬件/耗时提示后才开始读取 EPUB 和建库。
- 取消按钮位于固定进度区；取消是异步收口操作，会停止后续书本，并等待当前 read/parse/staging 完成回收。
- 已完成书本按原子事务保留；半本书不会成为可见索引。应用异常退出后，启动会回收运行中任务和 staging，再按缺失/版本过期书续建。
- 已增加统一派生缓存结构，目前只有 `full-text-index`；缓存清理命令不会删除书架、源 EPUB、阅读进度、书签、笔记或 Provider 配置。本轮按要求不添加书架缓存清理 UI。
- 部分索引可搜索，但查询只匹配当前 parser/normalizer/chunker 版本。该基础全文搜索链路已随 `0.1.9-beta.2` 通过 Windows 验收；后续仍必须保持版本过滤和半本 staging 不可见边界。
- 该阶段当时的自动化基线：前端 66 files/485 tests，Rust 38/38；TypeScript、Rust fmt 和 Vite production build 均通过。最新总基线见本文 C-57.6 交接。

## 2026-08-24 RAG C-57 模型资产交接

`0.1.9-beta.2` 的基础全文搜索 Windows 验收已完成。RAG C-57 的 Windows Tauri dev 核心资产链路也已通过：首次读取、D 盘模型库、探针登记/许可/下载、重启持久化及显式校验均正常；当前剩余删除、linked 和真实大文件故障矩阵的发布版验收。实现位于 `src/features/ai/models`、`src/features/ai/ui/ModelAssetsDevelopmentSection.tsx` 和 `src-tauri/src/ai/models.rs`/`download.rs`/`store.rs`。

本轮已完成：多文件 `ModelPackageManifest` 与纯数据扩展白名单；managed/linked ownership 和设备模型库路径；schema v4→v6 的模型包、文件、来源、任务和许可证表；单 FIFO 下载器的 Range、`.part`、SHA、磁盘、镜像、暂停/恢复/取消、原子安装和退出恢复；dev-only catalog/UI/controller。模型资产不会 create/load Provider，不读 EPUB、不建向量、不推理；能力插件与模型包分离，Provider `builtin/sidecar/http/mock` 契约不变。

开发入口首开只调用模型库路径、包列表和下载任务列表；scan/verify/hash/network 都需要显式操作。`c57-dev-probe` 是 15 字节纯文本 fixture，release 命令拒绝，正式版不显示公共模型市场。C-58 后续才可把已安装且 verified 的资产交给 Provider registry 实例化；`findAvailableModelPackages` 目前只是元数据查询。

路线决策补充：默认本地 AI 不依赖 Ollama。C-58 已调整为 C-58A Windows GPU/后端探测与资源准入、C-58B GPU-first Builtin ONNX Embedding Provider；生成阶段使用项目构建、审计并固定版本的 GPU-first llama.cpp sidecar。普通 UI 仅提供“自动推荐 / GPU 兼容 / NVIDIA CUDA / CPU 兼容”：NVIDIA 性能路径为 CUDA，AMD/Intel/其他已验收设备使用 WinML/DirectML（Embedding）与 Vulkan（生成），CPU 只显式限额启用且禁止 GPU 故障静默回退。Ollama/OpenAI-compatible 只作为后置高级 HTTP Provider，未配置时不探测、不联网；高级替换必须经过 C-57 manifest/linked 校验或未来受控能力插件，模型包不能携带运行二进制。

该阶段历史基线为前端 Vitest 77 files/521 tests、`tsc --noEmit`、Vite production build 143 modules；Rust fmt/check 和 74 tests。C-57.5 当时的总基线为前端 78/523、Core 38、AI 72，最新总基线见下方 C-57.6。B-075～B-077 已获得 Windows 实机证据；B-078 与 B-079 已分别修复 staging 清理和 Windows 短路径别名误报，待 Windows 复验。真实慢速/断网大文件、错误 digest 镜像回退、磁盘不足、多进程/真实 IPC 并发、重启 `.part` 续传、junction/reparse、Defender 占用以及中文/日文长路径仍待验证。

## 2026-08-27 C-57.5 Core / AI发行隔离交接

Core与AI现在从同一代码树按编译edition生成，不维护两套阅读器。Windows官方脚本默认`-Edition Core`：前端`VITE_EDITION=core`，Tauri 2.11传`--features core`且Cargo清单`default=[]`，保留当前书/跨书全文搜索但不生成AI面板/模型chunk、不编译模型下载模块或注册相关IPC。`-Edition AI`使用前端AI edition、Cargo `ai` feature、独立target及`dev.epubreader.ai`设备目录，并在production包显示C-57模型资产面板。

Rust schema边界为Core v3、AI v6；AI从Core升级会幂等补`provider_models`及模型资产表，Core打开已知v6不降级或访问模型表。这里记录的是C-57.5首轮状态；C-57.6现已把Cargo默认feature改为空并让裸debug入口安全归Core。桌面双edition开发仍必须优先使用`pnpm tauri:dev:core|ai`，正式发布必须使用`scripts/build-windows.ps1 -Edition Core|AI`。

已验证前端78 files/523 tests、tsc、Core无AI chunk/目标字符串/开发探针、AI独立lazy chunks和探针，以及Windows Cargo Core 38/AI 72 tests。PowerShell双安装包与Core全文搜索/AI模型资产人工链路仍须在Windows完成。先读`docs/tasks/active/core-ai-edition-split.md`，不要开始C-58A，直到双安装包确认。

## 2026-08-28 C-57.6 发行门禁实现交接

C-57.6代码与本地矩阵已经完成。Core/AI分别写入`dist/core`、`dist/ai`和`target-core`、`target-ai`；Cargo空默认并显式互斥`core/ai`；未知前端edition、冲突Cargo feature、release缺失/错误expected edition都会失败。两版共有无副作用`app_build_info`，前端在动态导入`App`前完成协议/edition握手，失败时不初始化App、FTS或AI前端运行时。

AI CSS和开发探针已移入lazy AI资源与`public-ai`，Core门禁同时拒绝AI UI/CSS、模型IPC、探针和AI identity；AI release根据已验证build-info隐藏mock和测试catalog操作。正式命令为`pnpm build[:ai]`、`pnpm tauri:dev:core|ai`及`scripts/build-windows.ps1 -Edition Core|AI`，裸`pnpm tauri build`有意fail-closed。

本地证据：前端83 files/537 tests、tsc、Core/AI各150 modules及双产物门禁；Rust Core45/45、AI83/83、fmt、Core active tree无`reqwest/fs2`；预期失败矩阵与PowerShell 5.1解析通过。Windows首次验收依次发现B-080 `spawnSync pnpm.cmd EINVAL`与B-081 Tauri不接受Cargo专用参数；现已改为当前Node直接运行项目本地CLI，并仅向Tauri传其支持的显式edition feature，WSL构建和Tauri四组参数解析通过，等待Windows重新同步确认。未修改schema、app-data、Provider、GPU或向量逻辑。下一步只做Windows双安装包、安装身份、核心/模型资产链路和人为mismatch验收；完成前不要进入C-58真实Provider。详见`docs/tasks/active/core-ai-release-hardening.md`。
