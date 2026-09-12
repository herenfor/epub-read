# 维护与交接约定

本文是人类维护者和不同 AI 模型共同遵循的协作规范。产品说明见 `README.md`，技术概览见 `docs/HANDOFF.md`，本地隔离环境说明见 `docs/PROJECT_CONTEXT.md`。

## 1. 仓库角色

本项目使用“隔离开发副本 → 人工审核 → 真实源仓”的工作方式：

- `<PROJECT_ROOT>/epub-reader`：允许 AI 修改、运行和验证的隔离副本。
- `<PROJECT_ROOT>/eupb-read`：真实 Git 仓库，仅由用户负责同步、提交与推送。

所有 AI 都必须在开始工作前读取 `docs/SOURCE_DELTA.md`。除非用户明确改变流程，否则不得直接写入真实源仓。

## 2. 单写入者原则

- 同一时间只允许一个 AI 修改和测试代码。
- 不需要为多个 AI 同时写同一工作树设计文件认领、锁或并行合并流程。
- 不同对话通过任务文档、Bug 记录和源仓差异文档交接，而不是依赖聊天记录。
- 新对话若发现前一任务未结束，应先沿用其任务文件，不要另建重复方案。

### Core / AI 发布线

- Core与AI始终来自同一套业务源码，不复制第二个阅读器项目。
- 当AI功能进入独立开发分支时，稳定Core线只接收阅读器/全文搜索修复和已经审核的基础变更；未完成AI提交不得反向进入Core发布线。
- Core Bug先在稳定线修复、验证和发布，再将同一提交合并或cherry-pick到AI线，禁止分别实现两份修复。
- AI线每次合入都必须保持Core构建矩阵通过；但当前`tsc`全量检查整个`src`，因此损坏的AI checkout不承诺仍能构建Core，紧急发行应从最新稳定Core tag/分支创建。
- edition用于编译和打包裁剪，Git分支用于隔离未完成开发；两者不能互相替代。C-57.6 的发行门禁代码与本地矩阵已经落地，Windows 双包仍待验收，实施状态见`docs/tasks/active/core-ai-release-hardening.md`。

## 3. 模块职责

| 区域 | 责任 | 不应承担 |
|---|---|---|
| `src/core` | EPUB 解包、路径、XML、OPF、NAV/NCX、字体与 DRM | React、浏览器布局、Tauri 文件系统 |
| `src/render` | 消毒、资源改写、iframe 章节渲染、分页和脚注识别 | 书架业务、持久化 UI、窗口外壳 |
| `src/ui` | React 界面、书架抽象、设置和阅读会话编排 | 重新实现 EPUB 包解析 |
| `src-tauri` | 本地文件读取、书架文件持久化、系统插件接入 | EPUB 内容解析与分页算法 |
| `scripts` | 构建、自检和本地复现辅助 | 产品运行时逻辑 |

更具体的边界和稳定契约见 `docs/MODULE_CONTRACTS.md`。

## 4. 标准工作流程

1. 阅读 `docs/PROJECT_CONTEXT.md` 和 `docs/SOURCE_DELTA.md`。
2. 为非平凡任务从 `docs/tasks/TEMPLATE.md` 创建任务记录。
3. 写明目标、非目标、预计修改文件和验收标准。
4. 先复现或定位，再做最小修改；不要顺带清理不相关代码。
5. 本地运行与风险相称的测试。
6. 修 Bug 时补充 `docs/BUGFIX_LOG.md`；涉及 CSS/布局时也更新 `docs/rendering-layers.md`。
7. 更新任务文件和 `docs/SOURCE_DELTA.md`，注明验证结果及是否建议同步。
8. 把同步、Git 提交和 GitHub 推送交给用户。

## 5. 本地验证规则

常用命令：

```bash
pnpm test
pnpm build          # Core + Core产物门禁
pnpm build:ai       # AI + AI产物门禁
pnpm check <book.epub>
```

桌面开发使用显式的 `pnpm tauri:dev:core` / `pnpm tauri:dev:ai`。正式 Windows 发行使用 `scripts/build-windows.ps1 -Edition Core|AI`；不要把缺少 expected-edition 元数据的裸 `pnpm tauri build` 当作发布入口。

- 测试只要求在本地通过，不要求将测试工程、私有 EPUB、临时复现脚本或运行产物上传仓库。
- 稳定且不包含私有内容的单元测试可以跟随功能代码同步；一次性或书籍专用复现留在本地。
- 如果当前 WSL 中 `pnpm` 命中了 Windows shim，应先启用 WSL 原生 Node/pnpm，再判断项目是否失败。
- 无法运行的验证必须如实记录，不能写成“已通过”。

## 6. 必须记录的变化

| 变化类型 | 必须更新 |
|---|---|
| 任意待同步文件变化 | `docs/SOURCE_DELTA.md` |
| Bug 修复 | `docs/BUGFIX_LOG.md` |
| 渲染/CSS 兼容变化 | `docs/rendering-layers.md` 冲突台账 |
| 新的跨模块设计约束 | `docs/MODULE_CONTRACTS.md` |
| 尚未完成的阶段任务 | 对应的 `docs/tasks/active/*.md` |
| 用户已同步到源仓 | 清空当前未同步清单，并追加同步历史 |

## 7. 禁止事项

- 未授权修改 `<PROJECT_ROOT>/eupb-read`。
- 把 `node_modules`、`dist`、Rust target、Playwright 浏览器、截图或私有测试书列入同步内容。
- 为单本书新增没有触发条件、测试证据和记录的散装 CSS 特判。
- 用页码代替内容锚点作为重排后的唯一恢复依据。
- 让书内脚本、表单或 iframe 在章节中恢复执行。
- 在修 Bug 的同时进行大范围命名、格式化或架构重构。

## 8. 交接输出

完成者至少说明：

- 改了什么以及为什么；
- 哪些文件建议同步；
- 运行了哪些验证，结果如何；
- 是否存在本地专用文件，不应同步；
- 仍有哪些风险或未决问题。

## 9. 贡献许可

除非贡献者明确书面说明，否则向本项目提交的代码、文档和其他贡献，均视为按照 Apache License 2.0 提供，并且不附加额外条款。贡献者应确保其有权提交相关内容。
