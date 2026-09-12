# EPUB Reader

基于 **Tauri 2 + React + TypeScript** 的桌面 EPUB 阅读器，支持 EPUB 2.0.1 与 EPUB 3.x。

目标：

- 做一个**跨平台、轻量、尊重书内排版**的 EPUB 阅读器；
- 渲染层尽量忠实呈现书籍自己的 CSS（版心、边距、浮动、插图、脚注等）；
- 阅读器只在必要处提供统一默认值（版心宽度、主题、字号、防溢出等）。

当前主要平台为 Windows；架构上可平移 macOS / Linux，浏览器开发模式可直接运行。

Tauri 桌面版采用单实例运行；重复启动会恢复并聚焦已经运行的主窗口，而不会再创建一个独立阅读器进程。

## 功能

### 书架

- 应用启动直接进入书架；空书架居中引导导入
- 文件对话框导入 / 拖拽导入，支持**批量导入**
- 只有能成功解析、且包含可阅读内容的 EPUB 才会入库，失败文件会报告原因
- 自动去重（EPUB 完整字节 SHA-256 相同才视为同一本书；改名不影响识别）
- 封面网格（无封面时生成书名占位封面）；桌面版只为接近视口的卡片生成有界缩略图
- 新导入书籍显示“新”标记，首次打开后自动清除
- 带动画的书架二级菜单：搜索、排序、排布密度、主题和存档操作集中管理；可按 OPF 作者、书名、语言及保存时间组合筛选
- 批量选择：支持批量删除（二次确认）；选择模式设计为通用能力，后续可扩展批量收藏/分类
- 阅读进度、最近阅读与百分比回写书架；点击卡片恢复到上次位置
- 阅读存档导入/导出：同步进度、书签和安全设置，不包含本机路径、EPUB 正文或封面缓存
- 单本删除与批量删除均带二次确认
- Tauri 环境只链接用户源 EPUB，不复制正文；源文件缺失时保留记录并支持同哈希重新定位，删除书架记录不会删除源文件
- 浏览器开发环境使用 IndexedDB 保存测试字节，只作为隔离预览后端

### 阅读器

- 当前打开书籍支持按需正文搜索：标准化短语/多关键词匹配、取消、结果高亮和原文锚点跳转；当前不包含跨书、语义或 AI 检索
- 正文选区可通过自定义右键菜单复制或添加笔记；笔记按时间查看，支持编辑、删除、原文跳转及撤销/前进
- 实验性“高性能模式”按下一篇优先准备前后相邻章节，顺序跨章命中时直接切换；默认关闭，固定版式禁用
- EPUB 2 / EPUB 3 双模解析：container → OPF（manifest/spine/guide/metadata）→ 目录
- 目录双模：EPUB 3 `nav` 优先、EPUB 2 `NCX` 兜底，缺失时用 spine 生成
- 章节隔离渲染：禁用书内脚本，危险标签/事件属性/`javascript:` 链接清除
- 自研 CSS 多栏分页：按页宽切列、翻页即滚动，自动处理图片加载重排与空列
- 阅读位置恢复：章节 + 页号 + 内容锚点，重排/设置变化后按锚点恢复
- 目录跳转（含页内锚点）、当前章节回跳开头、向前回翻自动停在上一章最后一页（加载完成后直接显示，无第一页闪帧）
- 书内脚注弹层（支持多看/掌阅类与脚本型注释模式；图片注释与超长注释可点击固定后滚动查看；弹层内不触发翻页，外链交系统浏览器）
- 主题：浅色 / 深色 / 羊皮纸，书架与阅读界面主题同步
- 排版设置：字号 12–32px；字重 300–700（细体/常规/中等/半粗/粗体）；行高、字间距、词间距
- 两套独立缩放：正文字号与界面缩放互不干扰
- 固定版式（pre-paginated）整页显示
- 问题日志：书籍不合规处分类记录，可查看
- DRM：检测到 ADEPT 等加密时明确提示，不渲染

### 渲染兼容性

阅读器注入样式按分层设计（安全 → 用户设置 → 默认版心 → 书内容 → 引擎兼容补偿），并在运行时测量修正：

- 书声明的 `width:%` 改写为 `min(百分比, 版心比例)`，窄容器中的百分比不会被误放大
- 直接子元素的书内 margin 两阶段测量，保持书的不对称缩进，同时提供默认居中
- CSS 多栏下的 `fit-content` / 浮动收缩异常补偿
- 全页插图、分隔图、脚注小图标等常见版式兼容

## 技术栈

- **外壳**：Tauri 2（Rust）
- **前端**：React 18 + TypeScript + Vite
- **解包**：fflate（前端 ZIP 解析，不依赖外部命令）
- **分页**：CSS multi-column（自研分页控制器）
- **持久化**：桌面链接书库（可同步记录 + 本机路径绑定 + 100 MiB 缩略图 LRU）；浏览器使用 IndexedDB 回退；可选 AI 派生数据使用独立 SQLite

## AI / RAG 扩展方向

RAG 计划作为本阅读器同一仓库、同一 Tauri 应用中的可选能力模块实现，不拆成独立产品，也暂不开放第三方 DLL/JavaScript 插件。

- 阅读、EPUB解析、普通全文搜索和原文跳转始终属于基础核心，不依赖模型。
- 智能检索模块将负责持久化语料、SQLite FTS、Embedding、向量与混合检索。
- 生成式模块将负责可替换 Provider、带引用问答和最终的分层正文总结。
- Provider 不绑定 OpenAI 或单一厂商；嵌入和生成模型分别配置。
- 默认本地 AI 不依赖 Ollama：先完成 C-57.6 发行门禁和 C-58-Prep 运行时合同，再建立 Windows GPU/后端探测与资源准入，之后才接入 GPU-first Embedding Provider；生成阶段优先采用固定版本的 GPU-first llama.cpp sidecar。普通模式为自动推荐，另提供 GPU 兼容、NVIDIA CUDA 和受限 CPU 兼容；Ollama/兼容 API 仅作为高级可选 Provider。
- 普通用户默认使用推荐模型并只调整必要的加速模式；高级替换通过校验过的 linked/约定目录或受控能力插件完成，不开放模型包安装任意可执行代码。
- 索引、向量和模型是可删除缓存，不进入阅读进度存档；AI结果必须保留原文引用。

当前已完成当前书与跨书基础正文搜索、书架正文入口、AI/RAG 地基以及 RAG C-57 模型资产基础：共享结构化语料、稳定切块、SQLite FTS、真实 Worker 语料流水线、可配置设备并发、Provider/capability 注册、mock 生命周期、模型 manifest、managed/linked ownership、独立下载任务和 dev-only 模型管理入口均已接入。模型资产只管理文件和元数据，不创建/加载 Provider、不读取正文、不建向量、不推理；正式构建不显示公共模型市场。真实 ONNX/GGUF/Ollama/API Provider、Embedding、向量检索、RAG 问答和总结仍未实现。详细路线见 [搜索到 RAG 路线](docs/SEARCH_TO_RAG_ROADMAP.md)，内部模块边界见 [AI/RAG 架构基线](docs/AI_PLUGIN_ARCHITECTURE.md)，C-57 任务见 [模型资产管理](docs/tasks/active/rag-model-asset-management.md)。

Core / AI发行已在编译期分开，但仍维护同一套源码：Core是默认Windows正式构建，保留全文搜索且不包含模型资产/下载/Provider运行层；AI是独立安装身份和数据目录的开发edition。Windows命令：

```powershell
# 默认基础版
.\scripts\build-windows.ps1

# 显式基础版
.\scripts\build-windows.ps1 -Edition Core

# 独立AI开发版
.\scripts\build-windows.ps1 -Edition AI
```

AI edition当前只开放C-57模型资产开发链路，不代表GPU、Embedding、向量或生成已经实现。隔离细节和Windows待验收矩阵见[Core / AI发行隔离任务](docs/tasks/active/core-ai-edition-split.md)。

C-57.6 发行门禁已经在隔离副本完成代码与本地自动化：Core/AI 分别输出到 `dist/core`、`dist/ai` 和独立 Rust target；Cargo 默认不启用 AI；非法或混合 edition 会在构建期失败；桌面端在加载 `App` 前通过无副作用的 `app_build_info` 校验后端 edition。AI CSS 与开发探针也已从 Core 产物移除。Windows 双安装包与实际安装身份仍待实机验收，详见 [C-57.6 发行门禁补强](docs/tasks/active/core-ai-release-hardening.md)。

## 目录结构

```
src/
  core/        解析内核（纯 TS，无 DOM 依赖）
    zip.ts          ZIP 解包 + mimetype 校验
    book.ts         加载编排（manifest/spine/guide/目录/字体/DRM）
    opf/ncx/nav     包文档与目录解析
    fonts.ts         IDPF 字体混淆还原
    search.ts        当前书按需正文提取、标准化、搜索与锚点映射
    paths/xml       路径解析与 XML 解析
  render/      渲染层
    sanitize.ts     章节消毒 + 阅读器分层样式注入
    cssRewrite.ts   CSS url() 改写与宽度兼容
    paginator.ts    分页/翻页/锚点/进度/运行时排版修正
    resources.ts    书内资源服务
    footnotes.ts    脚注识别
  ui/          界面
    ShelfView.tsx   书架
    ReaderView.tsx  阅读视图
    Toolbar / TocPanel / MenuPanel / SearchPanel / NotesPanel / FootnotePop / LogPanel
    shelf.ts        链接书库/IndexedDB 统一接口
    libraryArchive  无设备路径的存档校验与合并
    thumbnail.ts    近视口缩略图调度与派生
    storage.ts      设置与阅读进度
  test/        测试夹具与单元测试
src-tauri/    Tauri 2 壳 + Rust 链接书库后端
scripts/      构建/自检工具
```

## 开发环境运行

维护者开发文档见 [docs/HANDOFF.md](docs/HANDOFF.md)（架构、分层规范、测试与发布检查清单）。

使用隔离副本或不同 AI/对话协作维护时，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与
[docs/SOURCE_DELTA.md](docs/SOURCE_DELTA.md)。后者集中记录隔离副本相对真实源仓尚未同步的变化。

需要 Node.js ≥ 20 与 pnpm：

```bash
pnpm install
pnpm dev          # Core 浏览器开发模式（http://localhost:5173）
pnpm dev:ai       # 显式 AI 浏览器开发模式
pnpm test         # 单元测试
pnpm build        # Core：TypeScript 检查 + dist/core + 产物门禁
pnpm build:ai     # AI：TypeScript 检查 + dist/ai + 产物门禁
pnpm tauri:dev:core
pnpm tauri:dev:ai
```

浏览器开发模式下，书架使用 IndexedDB 持久化测试字节；阅读和渲染链路与桌面端一致，真实链接路径、重新定位与本机缓存行为需在 Tauri 中验证。

## 在 Windows 上构建桌面应用

前置条件：

1. Node.js ≥ 20
2. pnpm
3. Rust stable（MSVC 工具链）
4. WebView2 Runtime（Win10/11 一般自带）

正式 release 构建必须通过 edition 脚本提供前后端一致的构建意图；裸 `pnpm tauri build` 会因缺少 `EPUB_READER_EXPECTED_EDITION` 主动失败。

```powershell
pnpm install
pnpm build:windows        # 默认 Core
# 或
.\scripts\build-windows.ps1
.\scripts\build-windows.ps1 -Edition Core
.\scripts\build-windows.ps1 -Edition AI
```

产物：

- Core 安装包：`src-tauri\target-core\release\bundle\nsis\EPUB Reader_<版本>_x64-setup.exe`
- Core 免安装版：`src-tauri\target-core\release\epub-reader.exe`
- AI 安装包：`src-tauri\target-ai\release\bundle\nsis\EPUB Reader AI_<版本>_x64-setup.exe`
- AI 免安装版：`src-tauri\target-ai\release\epub-reader.exe`

桌面调试窗口使用 `pnpm tauri:dev:core` 或 `pnpm tauri:dev:ai`。裸 `pnpm tauri dev` 仍是安全的 Core debug 入口，但不作为双 edition 的正式命令。

## 测试

`pnpm test`（当前基线为 83 个测试文件、537 个用例）覆盖：

- 解析内核：路径解析、EPUB 2/3 加载、目录双模与兜底、字体混淆还原、DRM 拒绝、缺资源容错
- 渲染层：XHTML 消毒、URL/CSS 改写、分层样式注入、宽度百分比兼容、图片与脚注处理
- 书架：书本 ID 去重、排序、搜索、时间格式化
- 阅读功能：正文搜索、笔记与锚点、跳转历史、前台面板仲裁、设置边界和阅读进度
- 怪书测试库：mimetype 错误、spine 空/幽灵 item、百分号编码路径、`linear=no` 跳读、data: URI 图片等不合规输入的容错

当前隔离副本为前端 83 files/537 tests，`tsc --noEmit` 通过；Core/AI Vite production build 各 150 modules，产物门禁均通过。WSL Cargo Core 45/45、AI 83/83 tests 与 fmt/check 通过，Core active dependency tree 不含 `reqwest`/`fs2`；冲突 feature、错误期望 edition 和 release 缺少期望 edition 均按设计失败。Windows PowerShell 5.1 语法解析通过，双安装包仍需实机验收；模型资产还需验证真实大文件/断网、镜像 digest 回退、磁盘不足、重启续传、多进程 IPC、junction/reparse、Defender 占用和中文/日文长路径。

另有 Playwright 端到端回归：书架导入/持久化/进度恢复/批量导入/批量选择删除，翻章与目录跳转、回翻上一章无闪帧，脚注图片/固定/滚动交互，主题同步，以及多字号下的版心居中。

## 常见问题

- **`pnpm install` 报 esbuild build scripts 被忽略**：项目已放行 esbuild；如仍提示，执行 `pnpm approve-builds`。
- **打开书提示受 DRM 保护**：当前不支持 DRM 解密。
- **NSIS 打包失败**：多为首次下载 NSIS 工具链的网络问题，重试即可。
- **Linux 下构建 Tauri**：需要系统安装 `pkg-config` 与 GTK/WebKitGTK 开发包（如 `libwebkit2gtk-4.1-dev`、`libgtk-3-dev` 等）。
- **分发**：目标电脑需要 WebView2 Runtime（Win10/11 一般自带）。

## 路线图

- `0.1.9-beta.2` 的 Windows WebView2、跨书索引与多核流水线发布验证已完成
- C-57.6 Core/AI 发行门禁代码与本地矩阵完成，等待 Windows 双包验收
- 验收 RAG C-57 模型资产在 Windows 下的大文件续传、磁盘/文件占用和长路径边界
- 跨书 SQLite FTS 全文检索与结果跳转
- 可选 AI/RAG 模块地基：稳定语料切块、Provider 注册、独立缓存与后台任务
- 语义检索、相似内容、建议标签和智能书架
- 带原文引用的生成式问答与分层正文总结
- macOS / Linux 官方打包与测试矩阵

## 许可

本项目原创代码采用 [Apache License 2.0](LICENSE)。

项目包含分别采用 MIT、Apache-2.0、MPL-2.0、BSD、ISC、Zlib、Unicode-3.0 等许可证的第三方组件。完整清单、版权声明、许可证文本和源码位置见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

本项目许可证不改变第三方组件各自的许可证。
