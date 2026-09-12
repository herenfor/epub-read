# RAG C-57：模型资产管理（第一批）

## 状态

- **代码状态**：已在隔离副本实现；Windows Tauri dev 核心资产链路已通过，扩展/故障边界仍待发布版实机验收。
- **范围**：模型包清单、设备模型库、受管理/外链资产、下载任务恢复和开发管理入口。
- **不属于本任务**：Provider 创建或加载、正文读取、向量建库、Embedding/Generator 推理、公开模型市场。
- **历史编号消歧**：本文使用“RAG C-57”。项目历史中另有字体拖放功能的 C-57 编号，两者不是同一任务。

## 目标与边界

C-57 为后续 Embedding、生成式 AI 和 Provider 接入提供稳定的模型资产边界。模型包描述“运行什么”，ProviderManifest 描述“怎样运行”；两者不能互相替代，也不能把普通模型包当作可执行插件。

安装模型只负责登记、下载、验证和保存文件，不会：

- create/load/enable 任何 Provider；
- 读取 EPUB 正文或启动语料建库；
- 创建向量库、调用 Embedding/Generator 或执行推理；
- 修改阅读进度、存档或用户源 EPUB。

普通用户没有模型选择/运行 UI。开发构建提供受 `import.meta.env.DEV` 和 Rust debug gate 保护的最薄管理入口；正式版不显示公共模型市场。高级用户可通过约定目录导入或重新定位模型包，未来 Provider/模型选择仍由后续阶段设计。

## 清单契约

`ModelPackageManifest` 位于 Rust 模型资产层，支持多文件：

```text
schemaVersion
packageId / modelId / version / displayName
capabilities / format
files[{ relativePath, sizeBytes, sha256, purpose }]
dimensions / maxInput / recommendedBatch
minMemoryBytes / recommendedMemoryBytes
platform / arch
license / originalSource / homepage / requiresAcceptance
downloadMirrors[{ url, kind }]
providerKind（仅元数据，不创建 Provider）
```

清单严格校验稳定 slug、长度、重复 capability/mirror、HTTP(S) base URL、相对文件路径和文件白名单。支持的数据扩展名包括 `.onnx`、`.onnx_data`、`.gguf`、`.json`、`.txt`、`.model`、`.vocab`、`.merges`、`.tiktoken`；`.dll`、`.exe`、`.js`、`.py`、`.pkl`、`.pickle`、`.pt`、`.pth` 和未知扩展拒绝。文件缺失、大小错误、SHA-256 错误或 manifest 无效作为逐包/逐文件状态记录，不让同一扫描中的其他包消失。

开发探针 `c57-dev-probe` 只有 15 字节纯文本 fixture，固定 digest、源地址和许可证，声明能力仅用于验收展示，不是可推理模型；`findAvailableModelPackages` 明确排除 `text-fixture`/`mock`。

## 所有权与模型库

模型库是用户可配置的设备路径，不固定在 app data。设置路径时必须是绝对目录，拒绝已有非目录并检查可创建/写入；存在活动 queued/downloading/verifying 任务时禁止变更路径。相同规范化路径不会无故把已安装包标记 missing；真正换根目录只标记 managed 包 missing，linked 包不受影响。包目录、manifest 和模型文件路径另行逐组件拒绝 symlink/junction/reparse point。

| storageKind | 文件归属 | 路径语义 | 删除行为 |
|---|---|---|---|
| `managed` | 应用模型库内受管理文件 | 仅允许安全相对 `packageDir` | 删除记录；用户确认后只删除 DB 中精确且无 symlink/reparse 的包目录 |
| `linked` | 用户外部目录 | `linkedExternalPath` 设备私有绝对路径 | 永远只删除登记，不删除外部文件 |

linked 导入/重新定位必须读取 `model.json` 并验证所有文件的大小和 SHA；新清单与旧记录不一致时回滚旧路径。下载只接受 managed 包，不能借下载器改变 linked 所有权。目录扫描、verify 和删除逐组件拒绝路径逃逸、symlink、Windows junction/reparse alias；Windows 的真实 reparse、Defender 占用和异常 rename 仍需实机验收。

## SQLite 与任务状态

AI SQLite 独立于书架数据，schema 已从 v4 迁移到 v6：

- `model_packages`：模型身份、manifest 投影、`storage_kind`、`package_dir`、`linked_external_path`、状态；
- `model_package_files`：相对文件、大小/SHA、验证状态、下载字节、安装时间；
- `model_sources`：镜像 base URL 和来源类型；
- `model_download_tasks`：独立下载生命周期、当前文件/镜像、字节进度、错误、开始/完成时间；
- `model_license_acceptance`：按 package/license 内容绑定的接受记录。

包状态覆盖 `uninstalled/queued/downloading/paused/verifying/installed/missing/corrupt/failed`；下载任务独立覆盖 `queued/downloading/paused/verifying/completed/cancelled/failed`。v4→v5/v6 迁移将活动任务安全转为 paused 并保留已有进度，启动与退出不联网。

## Rust 下载器

`src-tauri/src/ai/download.rs` 为独立单 FIFO worker，单次只运行一个活动包；enqueue 通过 DB/CAS 防重复，取消、暂停、恢复和退出均保留可诊断状态。文件先写入：

```text
<model-library>/.staging/<package>-<task>/<relative>.part
```

每个文件分块写入、按阈值回写实际进度，并在暂停/取消及文件完成边界 flush/sync；随后逐文件 size/SHA 校验，全部通过后才原子安装，绝不覆盖已存在正式包。支持：

- HTTP/HTTPS，最多 5 次重定向；
- Range 206 的 Content-Range 起点/总长校验；200 从零安全重启；416 仅在本地完整文件校验通过时收敛；
- 镜像串行切换，源级 digest 错误删除 part 后尝试下一镜像；
- connect/读写空闲超时，而不是多 GB 下载的整体请求 deadline；
- 磁盘剩余空间按当前 `.part` 和安全余量计算，并在每个文件开始复查；
- 完成目录/commit 窗口的无网络崩溃恢复；失败保留诊断 staging，cancel 才精确清理；
- Windows rename 占用的有限重试。

下载器不通过 WebView 传大数组，不接 Provider、Embedding 或正文链路。

## 开发入口

开发面板位于 `src/features/ai/ui/ModelAssetsDevelopmentSection.tsx`，由 `AiFoundationPanel` 组合，状态由独立 controller/view model 管理，`App.tsx` 不新增模型资产真源。首开只并行 `getLibraryPath`、`listPackages`、`download.list`；仅活动任务每秒轮询，完成后刷新一次包列表；不会自动 scan/verify/hash/network。目录选择使用 Tauri dialog，不接受任意文本写入路径。

UI 只提供目录设置、linked 导入/重新定位、显式 verify、安全删除、固定 dev catalog 登记和下载任务控制；能力只显示 badge。许可证必须在同一 controller operation 中先接受再入队，失败不会继续下载。浏览器 `pnpm dev` 只显示“需要桌面开发构建”的提示，不调用 Tauri。

`public/c57-dev-probe/probe.txt` 会随 Vite dist 进入开发产物，但仅 15 字节纯文本、无代码、无推理能力；release 命令稳定返回开发 catalog 不可用，正式 UI 没有入口。

## 验证证据

- Rust：`cargo fmt --all -- --check`、`cargo test --locked`（74 passed）、`cargo check --locked`；
- 前端：全量 Vitest 77 files/521 tests，模型资产定向测试覆盖 controller、Strict Mode dispose/restart、action matrix、adapter/download；
- `tsc --noEmit` 通过；Vite production build 143 modules 通过。

Windows 首轮 `pnpm tauri dev` 暴露的永久“读取中”已归入 B-075：开发 Strict Mode 会执行 effect setup → cleanup → setup，而原 controller 在 cleanup 后不可重启。现已允许下一次 `start()` 使用新 generation 安全恢复，旧 IPC Promise 不能覆盖新状态；待主机重新同步后复验模型库选择和测试包登记。

第二轮 Windows 验收暴露 B-076：Tauri `devUrl` 使用 `http://localhost:5173`，旧开发探针却请求 `127.0.0.1`，在 Windows Vite 只绑定 localhost/IPv6 时连接失败。探针现与 `devUrl` 统一；重新登记 catalog 会替换旧 source，已有 failed 任务可直接重试，无需删除 AI 数据库。

第三轮 Windows 验收暴露 B-077：校验 SHA 使用的 1 MiB 局部数组耗尽 Windows Tauri command 线程栈并触发 `STATUS_STACK_OVERFLOW`。缓冲现改为256 KiB堆分配，仍逐块读取大模型；新增256 KiB小栈回归，避免以后重新引入大型栈缓冲。

2026-08-24 用户完成 Windows Tauri dev 核心验收：首次进入不自动扫描/下载且无卡死；D 盘模型库路径可选择并跨面板保持；固定探针登记、许可证确认和下载成功；应用重启后安装状态保持；显式 SHA 校验成功、无重复文件且未启动 Provider/正文/向量/推理。删除、linked 导入/重新定位及下述真实大文件故障矩阵尚未由用户报告通过，不得据此标记完整 C-57 发布验收完成。

删除正式模型文件已由用户确认，但发现历史失败任务空 staging 残留并归入 B-078。删除链路现按数据库精确 task IDs 清理该包全部非活动 staging，保留 `.staging` 根和其他包/相似前缀目录；待 Windows 复验后才能将 managed 删除完整标记通过。

自动化仍不能替代 Windows 验收：真实大文件慢速/断网、错误 digest 的真实镜像回退、可控磁盘不足、多进程/真实 IPC 并发、Windows junction/Defender 文件占用、重启后真实 `.part` 续传和最终安装目录都需在主机发布版验证。

## 未做项与 C-58 交接

以下明确留给后续阶段：真实 ONNX Runtime embedding、GGUF/llama.cpp、Ollama、OpenAI-compatible/其他厂商 API、Provider 创建/加载、模型选择 UI、国内源/ModelScope/自定义源下载策略、公开模型市场、向量存储和推理。

C-58 应在不改变 C-57 ownership/schema/下载安全边界的前提下，让 Provider registry 消费现有“已安装、全部文件 verified、匹配 capability、非 dev probe”的元数据查询，并由 Provider 自己决定是否实例化运行时。`findAvailableModelPackages` 目前只是纯元数据过滤，不能 create/load Provider，也不能读正文或启动向量任务。
