# 开发文档

本文档面向维护者与贡献者，介绍项目结构、开发命令、渲染分层规范与回归测试方式。

> 项目自述与功能列表见根目录 [README.md](../README.md)。

> 正文搜索、语义检索、智能分类、RAG 问答与正文总结的长期方向见 [SEARCH_TO_RAG_ROADMAP.md](SEARCH_TO_RAG_ROADMAP.md)。当前已完成 B-059/C-48 的当前书基础正文搜索；跨书检索、语义检索、智能分类、RAG 问答与正文总结仍是后续范围，不得视为已实现或稳定发布能力。

> B-060/C-49 正文笔记首版已经进入隔离副本：选区右键、创建/编辑/删除、按时间列表、文本锚点跳转、CSS Highlight 下划线和 portable archive 均已接入。Windows WebView2 实机仍待审核，契约见 [reader-notes.md](tasks/active/reader-notes.md)。

> B-061/C-50 实验性“高性能模式”已经扩展为前后相邻三槽：默认关闭，后台严格先下一篇、后上一篇，槽位完全静默，顺序跨章命中后直接提升并保留反向缓存；固定版式和未命中保持标准加载。详细设置同时统一为主题色浅卡片与现代开关，纸色对比度已改善。Windows 性能、内存与视觉实机仍待审核，见 [next-chapter-preload.md](tasks/active/next-chapter-preload.md)。

> B-062/C-51 书架二级筛选抽屉已经进入隔离副本：作者/书名/保存时间/语言组合筛选、搜索/排列/密度/主题/存档迁移、轻量动画及书架顶部工具栏移除均完成。OPF language 已贯通浏览器、Rust 和 portable archive；旧记录不扫描源书，显示“未知语言”。B-063～B-066 已让滚动区填满抽屉标题以下空间、预留稳定滚动槽，并修复搜索图标视觉居中；展开筛选出现滚动条时选项宽度不再变化。Windows 原生导入与 100+ 本视觉性能待审核，见 [shelf-filter-drawer.md](tasks/active/shelf-filter-drawer.md)。

> 0.1.9 已完成发布收口；当前隔离副本为 `0.1.9-beta.1` 修复测试版。B-067 为阅读器菜单增加稳定滚动槽，修复展开详细设置后卡片突然变窄。

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

## 开发命令

```bash
pnpm install
pnpm dev          # 浏览器开发模式（localhost:5173）
pnpm test         # 单元测试（当前 407 项）
pnpm build        # TypeScript 检查 + 生产构建
pnpm tauri dev    # 桌面窗口调试（需要系统 Tauri 依赖）
pnpm tauri build  # 桌面打包
```

Windows 一键打包见 `scripts/build-windows.ps1`；0.1.9 的 WSL→Windows 安全同步与测试版验收见 `docs/RELEASE_0.1.9.md`。0.1.8 文档仅保留为阶段历史。
当前 Windows 核心搜索修复测试入口见 `docs/RELEASE_0.1.9-beta.1.md`。

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
