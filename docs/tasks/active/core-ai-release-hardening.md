# C-57.6：Core / AI 发行门禁补强

- 状态：代码与本地矩阵完成，待 Windows 双包验收
- 创建日期：2026-08-27
- 最后更新：2026-08-28
- 对应 Bug：无（C-57.5 的发行可靠性收口）

## 目标

在不改阅读、全文搜索、模型资产和数据库行为的前提下，把 C-57.5 已有的 Core/AI 编译隔离变成 fail-closed 的可重复发行流程：任何正式入口都只能生成前端、Rust feature、Tauri 配置、静态资源和输出目录一致的单一 edition；错误组合必须在构建期或应用首次挂载前明确失败。

完成后应满足：

- 裸默认构建是 Core，不会因为 Cargo 默认 feature 携带 AI；
- Core/AI 前端和 Rust 产物目录完全分离，连续或并行构建不会串包；
- 官方命令从一个 edition 参数派生全部前后端配置，不允许分别猜测；
- Core 不包含 AI 面板 JavaScript、AI CSS、开发探针或模型资产 IPC；
- AI debug 显式保留 C-57 开发能力，AI release 只暴露可用的资产管理操作；两者都不会覆盖 Core 安装或设备数据；
- 基础版热修复可以从稳定分支独立发布，并以同一提交回合并 AI 开发线。

## 非目标

- 不接入 GPU、ONNX、llama.cpp、Embedding、向量或生成式 AI。
- 不修改 Core v3 / AI v6 schema、`ai.sqlite3`、模型库路径或 portable archive。
- 不搬迁 `src/features/ai/indexing` 或拆分物理数据库；基础搜索与 AI 命名/组件版本边界另列后续任务。
- 不通过 edition 排除 TypeScript 源码检查；`tsc` 继续全量检查 `src`。
- 不让模型包携带 sidecar、DLL 或其他执行文件。
- 不决定稳定 AI 最终是否沿用 Core identifier；开发 AI 继续使用独立身份。

## 当前实现证据

### 已完成

- `__APP_EDITION__` 由严格解析器生成；未设置时安全默认为 Core，空值和未知值直接失败。
- Vite 分别写入 `dist/core`、`dist/ai`；Tauri overlay、Rust target、静态资源和机器可读 manifest 均按 edition 独立。
- Cargo `default = []`，正式构建显式且互斥地选择 `core` 或 `ai`；release 缺少或不匹配 expected edition 会在 `build.rs` 失败。
- 两版共有无副作用的 `app_build_info`；桌面启动在动态导入 `App` 前校验协议和 edition，失败时不会初始化 App、FTS 或 AI 前端运行时。
- AI CSS 由 lazy 面板持有，开发探针位于 `public-ai`；Core 产物门禁拒绝 AI UI、CSS、模型 IPC、探针和 AI identity。
- AI release 隐藏只在 debug 后端可用的 mock 与测试 catalog 操作，但保留模型库、linked、验证和受管理资产操作。
- PowerShell 只接收一次 `Core|AI` 选择，Tauri 的 edition-specific `beforeBuildCommand` 完成唯一一次前端构建。
- 本地已通过前端 83 files/537 tests、TypeScript、Core/AI 各 150 modules、Rust Core 45/AI 83、Rust fmt、Core dependency tree 和预期失败矩阵。

### 尚待完成

- Windows Core/AI 双安装包、identifier、窗口标题、app-data、核心功能和模型资产链路尚未完成同一轮实机验收。
- 人工构造 frontend/backend mismatch 的 Windows 错误页仍待验证；两种方向的契约与启动前阻断已有自动化覆盖。

## 架构原则

1. **Core 安全默认**：未显式选择 AI 时，前端、Rust、Tauri 和输出路径全部收敛到 Core。
2. **单一 edition 输入**：官方 wrapper 只接受一次 `core|ai`，再派生 Vite、Cargo、Tauri config、target 和产物断言。
3. **独立且不可复用的输出**：每个 edition 只读取自己的前端目录和 Rust target；不得从通用 `dist`/`target` 猜测最新产物。
4. **构建期校验 + 启动期兜底**：官方构建先拒绝 feature/edition 不一致，桌面启动再以通用 build-info IPC 防止手工混装。
5. **Core 内容边界**：基础全文搜索、`corpusWorker`、FTS 和稳定锚点必须保留；只裁掉模型资产、Provider 开发 runtime、AI UI/CSS和开发 fixture。
6. **一套源码、稳定线优先**：不复制第二个阅读器项目；Core 修复从稳定线发布后再合并到 AI 线。

## 目标构建拓扑

```text
edition argument: core | ai
        │
        ├─ frontend wrapper
        │    ├─ strict edition parser
        │    ├─ Vite compile literal
        │    ├─ dist/core | dist/ai
        │    ├─ publicDir: false | public-ai
        │    └─ edition-manifest.json
        │
        ├─ Rust/Tauri wrapper
        │    ├─ core feature | ai feature
        │    ├─ expected edition env
        │    ├─ tauri core | ai overlay
        │    └─ target-core | target-ai
        │
        └─ post-build validator
             ├─ frontend/backend metadata一致
             ├─ Core禁止项扫描
             ├─ AI必需项扫描
             └─ identifier/产物路径核对
```

## 1. Build profile 与严格解析

以下单一 `BuildProfile` 契约已经由 Node wrapper、Vite 与 Tauri 配置共同实现：

```ts
type AppEdition = "core" | "ai";

interface BuildProfile {
  edition: AppEdition;
  frontendOutDir: string;
  publicDir: string | false;
  tauriConfig: string;
  cargoFeatures: readonly string[];
  cargoTargetDir: string;
  identifier: string;
}
```

解析规则：

- 无显式输入：Core；
- 显式输入只允许大小写规范化后的 `core` 或 `ai`；
- 空字符串、`aii`、`preview` 等未知值直接抛错；
- `pnpm dev`、`pnpm build` 和裸 Cargo 均保持 Core 安全默认；AI 必须使用显式命令；
- 官方脚本从同一个 `-Edition` 参数同时设置前端 edition 和 Rust expected edition，禁止由两处独立环境变量人工拼装。

实际命令：

```text
pnpm dev                 → Core browser
pnpm dev:core            → Core browser
pnpm dev:ai              → AI browser
pnpm build               → Core frontend
pnpm build:core          → Core frontend
pnpm build:ai            → AI frontend
pnpm tauri:dev:core      → Core Tauri dev
pnpm tauri:dev:ai        → AI Tauri dev
pnpm build:windows       → Core Windows
pnpm build:windows:core  → Core Windows
pnpm build:windows:ai    → AI Windows
```

跨平台 Node wrapper 负责设置环境并调用本地 TypeScript/Vite 二进制，避免在 `package.json` 使用只适用于 cmd、PowerShell 或 Bash 的环境变量语法。

## 2. 前端产物与静态资源隔离

目标目录：

```text
dist/core/
dist/ai/
src-tauri/target-core/
src-tauri/target-ai/
public-ai/c57-dev-probe/probe.txt
```

- 使用 `dist/core` 与 `dist/ai`，继续由现有 `dist/` ignore 规则统一排除构建产物。
- Core Tauri 配置只读取 `../dist/core`；AI overlay 只读取 `../dist/ai`。
- 每次构建只清理自己的 edition 子目录，不删除另一个 edition 的结果。
- 当前开发探针移到 `public-ai`；Core 不再通过关闭整个通用 `public` 目录间接排除它。
- 未来共享静态资源优先通过 `src/assets` 进入模块图；确需原样复制时再建立受控 `public-core`/共享复制规则。

### AI CSS

将以下样式从全局 `src/styles.css` 移入 `src/features/ai/ui/ai.css`：

- `.ai-foundation-*`；
- `.model-assets-*`。

由 AI lazy module 导入该 CSS。Core 不产生对应 CSS chunk；AI 面板加载时由 Vite 同步加载其样式。不得把 AI CSS 改为更宽泛的全局选择器。

## 3. Cargo 与 Tauri edition

目标 Cargo feature：

```toml
[features]
default = []
core = []
ai = ["dep:fs2", "dep:reqwest"]
```

- 裸 Cargo build 等同 Core 安全代码路径；
- 直接 Cargo 矩阵中 Core 使用 `--no-default-features --features core`，AI 使用 `--no-default-features --features ai`；
- Tauri 2.11 CLI 不暴露 `--no-default-features`，官方 dev/build 只传 `--features core|ai`；由于清单固定 `default=[]`，实际激活集合等价且 build.rs 继续校验 expected edition；
- `core + ai` 同时出现必须在 `build.rs` 失败；
- 现有 `cfg(feature = "ai")` 与 `cfg(not(feature = "ai"))` 本阶段不做大规模重写。

Tauri base config 保持 Core-safe；另提供显式 Core/AI overlay。两份 overlay 必须覆盖：

- 对应的 `beforeDevCommand` / `beforeBuildCommand`；
- 对应 `frontendDist`；
- product name、identifier 和窗口标题；
- AI 继续使用 `dev.epubreader.ai`，Core 使用 `dev.epubreader.app`。

PowerShell 外层不再预先执行一次完整前端 build；Tauri 的 edition-specific `beforeBuildCommand` 只构建一次。测试、Cargo check 和产物扫描由独立 validate 阶段执行，不能靠重复 build 代替。

## 4. 构建元数据与混合包阻断

### Rust 编译元数据

`build.rs` 根据 `CARGO_FEATURE_CORE`/`CARGO_FEATURE_AI` 计算实际 backend edition，并写入编译期常量。官方 wrapper 同时传入：

```text
EPUB_READER_EXPECTED_EDITION=core|ai
```

规则：

- release 构建缺少 expected edition：失败，强制走官方 wrapper；
- expected edition 与 Cargo feature 不一致：失败；
- `core + ai`：失败；
- debug/test 可在未传 expected edition 时按实际 feature 工作，便于独立 Cargo 测试。

### 通用 build-info IPC

Core/AI 都注册只读 `app_build_info`：

```ts
interface AppBuildInfo {
  version: string;
  edition: "core" | "ai";
  protocolVersion: 1;
  target: string;
  profile: string;
  debug: boolean;
}
```

该命令只返回编译常量，不读取 `AiState`、不打开 SQLite、不扫描模型目录、不访问网络。

桌面启动在挂载 `App` 前比较 backend edition 与前端 `APP_EDITION`：

- 一致：正常启动；
- 不一致：显示独立的“发行组件不匹配”错误页；
- mismatch 状态不得初始化 AI runtime、FTS runtime、模型目录或后台任务；
- 不允许自动采用 backend 值继续运行。

浏览器开发模式没有 Tauri IPC，直接使用编译期前端 edition。

### 前端 edition manifest

每次 Vite build 在自己的输出目录生成 `edition-manifest.json`：

```json
{
  "schemaVersion": 1,
  "edition": "core",
  "version": "0.1.9-beta.2",
  "expectedBackendFeature": "core",
  "identifier": "dev.epubreader.app"
}
```

它用于构建后扫描和诊断，不替代 Rust build-info，也不作为运行能力判断依据。

## 5. 产物门禁

Core 前端必须不存在：

- `AiFoundationPanel`、模型资产 controller/adapter/runtime chunk；
- `.ai-foundation-*`、`.model-assets-*` CSS；
- `ai_model_*` 模型资产 IPC 字符串；
- `c57-dev-probe`；
- AI edition identifier或产品标题。

Core 前端必须保留：

- `corpusWorker`；
- 当前书搜索和跨书 FTS；
- 书架、阅读、字体、笔记和稳定锚点链路。

AI 前端必须存在 AI edition manifest、AI lazy JS/CSS chunk和模型资产入口，但不要求存在真实模型、GPU runtime 或推理结果。

Rust/Cargo 门禁：

- Core `cargo tree` 不得通过 active feature 引入 `reqwest`、`fs2`；锁文件中存在可选 crate 不视为失败；
- Core handler 不得注册 `ai_model_*`；
- AI handler必须注册 C-57 模型资产命令；
- 两个 edition 都必须保留基础全文搜索命令。

## 6. TypeScript 与 Git 分支边界

`tsconfig.json` 继续全量包含 `src`。C-57.6 只保证产物裁剪，不承诺在 AI 源码已经出现语法/类型错误时，同一 checkout 仍能通过 Core 的全量 `tsc`。

推荐发布线：

```text
main 或 release/core     稳定 Core 与基础全文搜索
develop/ai               C-58 及后续 AI 集成
hotfix/core-*            从最新 Core tag 创建的短期修复
```

流程：

1. Core Bug 在稳定线修复并发布；
2. 同一提交合并或 cherry-pick 到 `develop/ai`；
3. AI 线每次合入都必须保持 Core 构建矩阵通过；
4. 未完成 AI 提交不得反向进入 Core 发布线；
5. 禁止复制第二份业务代码或在两条线分别实现同一个 Bug 修复。

若未来明确要求“损坏的 AI checkout 仍可单独 typecheck Core”，应另建 TypeScript workspace/project-reference 任务；不得在本阶段用 `exclude` 或 `@ts-ignore` 伪造隔离。

## 7. 实际修改文件

- `src/config/editionValue.ts`及测试：严格 edition 解析。
- `vite.config.ts`：edition build profile、独立 outDir/publicDir。
- `src/features/ai/ui/AiFoundationPanel.tsx`、新 `ai.css`、`src/styles.css`：AI CSS lazy 隔离。
- `public/`、新 `public-ai/`：开发探针归属。
- `package.json`、新 frontend edition wrapper：显式 Core/AI 命令。
- `src-tauri/Cargo.toml`、`src-tauri/build.rs`：安全默认、互斥 feature 和 backend metadata。
- `src-tauri/src/lib.rs`、新 build-info 模块及测试：通用 IPC。
- `src/main.tsx`、`src/appBootstrap.tsx`、`src/config/appBuildInfo.ts`、`appBuildSession.ts`及测试：桌面 edition 握手、只读启动会话、release开发动作门控和 mismatch 错误页。
- `src-tauri/tauri.conf.json`、Core/AI overlay：before command、frontendDist和安装身份。
- `scripts/build-windows.ps1`、新产物断言脚本：单次构建与门禁。
- `scripts/validate-windows-rag-foundation.ps1`：改用显式 AI dev/build入口。
- 相关 README、维护与交接文档：记录真实命令、实现边界和验证结果。

## 8. 验收矩阵

| 检查 | Core | AI |
|---|---|---|
| 全量 Vitest / `tsc --noEmit` | 必须 | 同一全量结果 |
| 前端目录 | `dist/core` | `dist/ai` |
| Cargo | `--features core` | `--features ai` |
| Rust target | `target-core` | `target-ai` |
| Tauri overlay/identifier | Core / `dev.epubreader.app` | AI / `dev.epubreader.ai` |
| 基础全文搜索 | 必须正常 | 必须正常 |
| AI JS/CSS/探针/模型IPC | 必须不存在 | 必须存在开发链路 |
| 实际模型推理 | 不要求 | 不要求 |

自动化必须覆盖：

- 未设置 edition 默认 Core；未知 edition 失败；
- Core/AI Vite 输出互不删除、互不读取；
- Core、AI 和 `core+ai` Cargo feature 组合；
- release 缺失/错误 expected edition 失败；
- build-info 不创建 `ai.sqlite3`；
- Core frontend + AI backend、AI frontend + Core backend 都进入 mismatch 且不初始化运行时；
- Core forbidden/required artifact scan；
- AI lazy JS/CSS 与探针断言；
- PowerShell 5.1 语法和 UTF-8 配置读取。

Windows 人工验收：

1. 分别构建 Core/AI 安装包和免安装 executable；
2. 两者安装路径、进程、窗口标题和 app-data 不覆盖；
3. Core 导入、阅读、进度、笔记、字体、当前书/跨书全文搜索正常；
4. Core 没有 AI 菜单、模型目录访问或额外网络；
5. AI C-57 面板、模型库、linked、下载/取消/校验/删除正常；
6. 复验 B-078/B-079 及 D 盘中文/长路径；
7. 有意构造一次 edition mismatch，确认应用 fail-closed。

## 9. 完成标准

- [x] Cargo 默认不启用 AI，正式 Core/AI feature 显式且互斥。
- [x] 前端、Rust target、Tauri配置和静态资源按 edition 独立。
- [x] AI CSS/探针不进入 Core。
- [x] 未知 edition 与错误前后端组合能够自动失败。
- [x] 构建元数据、通用 build-info和启动握手完成。
- [x] 官方 PowerShell 不重复构建前端，本地双 edition 门禁通过。
- [ ] Windows 双安装包及人工矩阵完成。
- [x] 文档从“设计”更新为真实实现和验证证据。

## 10. 后续阶段，不在本任务实施

C-57.6 完成后再依次处理：

1. **C-57.7 边界整理**：基础全文搜索移出 AI 命名空间的方案、组件 schema 版本、SQLite实际/支持版本诊断、`busy_timeout`与跨进程 owner/lease；是否物理拆库由证据决定。
2. **C-58-Prep**：`HardwareProbeResult`、`ResourceGovernor`、Provider 生命周期、完整 `IndexManifest`、mock OOM/崩溃/取消和可恢复假向量 staging。
3. **C-58A**：真实 Windows GPU/后端探测，不加载模型。
4. **C-58B**：先接单一通用 GPU Embedding 路径；是否将 ONNX 置于受控 sidecar 在实现前作最终决定，CUDA后续按性能证据增加。

## 本地验证

| 命令/操作 | 结果 | 日期 |
|---|---|---|
| 全量 Vitest | 83 files / 537 tests 通过 | 2026-08-28 |
| `tsc --noEmit` | 通过 | 2026-08-28 |
| `pnpm build:core` / `pnpm build:ai` | 各 150 modules；分别写入独立目录，产物门禁通过 | 2026-08-28 |
| Rust Core / AI tests | Core 45/45；AI 83/83；`cargo fmt --check` 通过 | 2026-08-28 |
| Core active dependency tree | 未包含 `reqwest` 或 `fs2` | 2026-08-28 |
| Cargo expected-edition 负向矩阵 | `core+ai`、edition mismatch、release 缺 expected 均按预期失败 | 2026-08-28 |
| 严格前端 edition 负向矩阵 | wrapper 未知 edition、`VITE_EDITION=preview` 均按预期失败 | 2026-08-28 |
| Windows PowerShell 5.1 parser | 两份发行/验证脚本语法通过；未执行真实打包 | 2026-08-28 |
| B-080 Windows wrapper修复 | 原`spawnSync pnpm.cmd EINVAL`已改为当前Node直接运行本地CLI；WSL Core/AI各150 modules及门禁通过，Windows待复验 | 2026-08-28 |
| B-081 Tauri参数修复 | Tauri 2.11 `dev/build`的Core/AI四组`--features ... --config ...`解析通过；移除其不支持的Cargo专用参数，Windows待复验 | 2026-08-28 |

## 不应同步的本地文件

- `dist/`、Rust target、安装包、测试模型、日志和故障注入临时目录。

## 待完成与风险

- 代码与本地自动化已经完成，但 Windows 双包尚未验收，因此不能标记为完整发布验收通过。
- Windows首次前端验收发现并修复B-080；用户必须重新同步`build-frontend.mjs`后再继续双包验收，旧missing dist无需单独处理。
- 随后的Tauri dev验收发现并修复B-081；Windows发行脚本也已同步修正，因此下一次应同时更新`build-frontend.mjs`与`build-windows.ps1`。
- AI production 仍保留模型资产管理面板；mock Provider 和开发 catalog 已按已验证 build-info 的 `debug` 标记隐藏。
- 开发 AI 与 Core 设备数据保持隔离；稳定 AI 的迁移和共享书架策略不在本任务决定。
- 同一模型库被不同 AI 安装并发使用的锁策略属于 C-57.7/C-58-Prep，真实 Provider 前必须完成。

## 交接说明

下一次先读本文件、`core-ai-edition-split.md`、`AI_PLUGIN_ARCHITECTURE.md`、`MODULE_CONTRACTS.md`、`vite.config.ts`、`src-tauri/Cargo.toml`、`src-tauri/build.rs`和Windows构建脚本。代码阶段已经完成，下一步固定为 Windows Core/AI 双包与人工矩阵；验收前不要同时接入 C-58。

## 源仓同步状态

- [x] 已更新 `docs/SOURCE_DELTA.md`
- [ ] 用户已审核
- [ ] 用户已同步到真实源仓
- 源仓提交：待用户填写
