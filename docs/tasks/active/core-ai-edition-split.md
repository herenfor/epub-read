# C-57.5：Core / AI 发行隔离

- 状态：待用户审核
- 创建日期：2026-08-27
- 最后更新：2026-08-27
- 对应 Bug：B-079

> 这是C-57.5首轮隔离的历史记录。2026-08-28起，Cargo默认feature、前端输出目录、Tauri命令和build-info门禁已经由[C-57.6](./core-ai-release-hardening.md)收口；本文件下方关于“Cargo默认AI/共享dist”的描述只说明当时状态，不能作为当前操作指引。

## 目标

在同一套源代码和数据契约上建立可重复的 `core` 与 `ai` 两种编译产物，使基础阅读器发生 Bug 时可以脱离未完成的模型/GPU开发快速验证和发布。

## 非目标

- 不复制第二套长期维护的项目代码。
- 不在本任务接入 GPU、ONNX、llama.cpp、向量或生成式 AI。
- 不从基础版移除当前书/跨书全文搜索、结构化语料、SQLite FTS和稳定锚点。
- 不改变正式版书架、阅读进度或 portable archive schema。

## 当前现象与证据

- `src/features/ai` 同时包含基础全文搜索和模型/Provider预留，不能按目录整体删除。
- `App.tsx` 静态导入 AI runtime/UI；现有 `import.meta.env.DEV` 只控制可见性，不保证生产包裁掉代码。
- Rust 当前总是编译并注册模型资产/下载模块，`reqwest` 与 `fs2` 也不是可选依赖。
- `scripts/build-windows.ps1` 只有单一构建路径，不能明确复现Core与AI产物。

## 必须保持的行为

- Core版保留阅读、书架、笔记、字体、当前书搜索和跨书FTS全文搜索。
- Core版不得初始化或暴露模型资产、Provider、GPU探测、向量或生成能力。
- AI版继续复用同一基础核心，不复制搜索、EPUB解析或书架实现。
- GPU/RAG开发失败不得阻断Core版编译和发布。
- GPU/模型失败不得通过运行时字符串或隐藏按钮影响Core版。

## 预计修改文件

- 前端构建配置、edition常量、`App.tsx`及测试：编译期裁剪智能能力入口。
- `src-tauri/Cargo.toml`、`src-tauri/src/ai/*`、命令注册及测试：Cargo feature裁剪模型资产层。
- `scripts/build-windows.ps1`、`package.json`：提供显式Core/AI构建入口。
- RAG架构、路线、模块契约、交接和差异文档：记录发行边界与热修复流程。

## 实际修改

- 前端新增`APP_EDITION`编译期常量和edition-aware runtime adapter；Core生产构建不生成AI runtime/面板/模型资产chunk，AI production以懒加载chunk保留开发面板。
- Rust新增Cargo `ai` feature；Core不编译`models/download`、不注册模型资产IPC且不启用可选`reqwest/fs2`，但完整保留FTS/store/task/cache。
- schema按edition分层：Core新库到v3，AI到v6；AI从Core v3升级时幂等补齐`provider_models`和模型资产表，Core可打开已知v6而不访问模型数据。
- Windows构建脚本新增`-Edition Core|AI`且默认Core；两者使用独立target目录。AI overlay使用`dev.epubreader.ai`、独立app-data和“AI（开发）”标题。
- RAG Windows验证脚本改为显式AI前端和Cargo feature，避免产生前后端edition不一致的验证包。
- 联调修复B-079：Windows 8.3短路径别名与canonical长路径不再使合法模型staging被误判为越界；真实越界、symlink和reparse防护保持。

## 验收标准

- [x] Core前端生产构建不包含模型资产面板或Provider runtime入口。
- [x] Core Rust不编译/注册模型资产下载命令，且不启用其网络/磁盘依赖；Windows Cargo check/test已通过。
- [x] Core保留全文搜索实现，前端全量和Rust Core 38项测试通过。
- [x] AI前端构建保留现有C-57开发链路并生成独立懒加载chunk。
- [x] Windows脚本能用明确参数分别构建Core和AI；真实打包待Windows执行。
- [ ] Core与AI的Windows安装包、独立安装身份和核心人工链路全部验收。

## 本地验证

| 命令/操作 | 结果 | 日期 |
|---|---|---|
| `node node_modules/vitest/vitest.mjs run` | 78 files / 523 tests通过 | 2026-08-27 |
| `node node_modules/typescript/bin/tsc --noEmit` | 通过 | 2026-08-27 |
| `VITE_EDITION=core node node_modules/vite/bin/vite.js build` | 146 modules；无AI runtime/面板/模型资产chunk或目标字符串 | 2026-08-27 |
| `VITE_EDITION=ai node node_modules/vite/bin/vite.js build` | 146 modules；生成runtime/capabilities/AiFoundationPanel独立chunk | 2026-08-27 |
| Windows Cargo Core `fmt/check/test --no-default-features` | 通过；38 tests | 2026-08-27 |
| Windows Cargo AI `check/test --no-default-features --features ai` | 通过；72 tests，含Core v3→AI v6迁移 | 2026-08-27 |
| PowerShell Core/AI真实Tauri打包 | 待Windows | 2026-08-27 |

## 不应同步的本地文件

- 构建产物、`dist`、Rust `target`和测试模型文件。

## 待完成与风险

- C-57.5当时为兼容直接`pnpm tauri dev`仍默认启用`ai` feature；C-57.6现已改为空默认并增加显式`core/ai` feature。裸`pnpm tauri build`会因缺少expected-edition元数据失败，正式发布必须使用C-57.6命令。
- AI开发版现与Core使用独立设备数据目录；未来稳定AI是否迁回Core identifier需要单独迁移设计。
- Windows仍需打包后实测Core全文建库/搜索以及AI C-57模型资产链路，确认PowerShell参数、安装身份和Tauri overlay行为。
- 后续只读审查确认 C-57.5 仍有共享 `dist`、Cargo 默认 AI、未知 edition 静默回退、AI 全局 CSS 和缺少前后端握手等发行门禁缺口；这些不回填扩大本任务，统一进入 [`core-ai-release-hardening.md`](./core-ai-release-hardening.md)（C-57.6）。

## 交接说明

继续时以[`core-ai-release-hardening.md`](./core-ai-release-hardening.md)为当前发行入口，再读`docs/AI_PLUGIN_ARCHITECTURE.md`、`docs/MODULE_CONTRACTS.md`、前端edition配置、`src-tauri/src/ai/mod.rs`与Windows构建脚本。Windows双包验收完成前不要进入真实C-58 Provider。

## 源仓同步状态

- [x] 已更新 `docs/SOURCE_DELTA.md`
- [ ] 用户已审核
- [ ] 用户已同步到真实源仓
- 源仓提交：待用户填写
