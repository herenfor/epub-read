# 基础阅读器修复：预加载设置、笔记入口、已索引书籍删除

- 状态：本地修复与验证完成，待 Windows 用户书库复验；尚未同步源仓。
- 日期：2026-09-11
- 对应 Bug：B-082、B-083、B-084

## 范围与结果

1. 高性能模式：每个槽位记录实际渲染设置，后台创建取最新设置；调度/提升核对设置身份。换章取消 150ms 设置防抖时，章节 load 同时应用新设置，避免下一 HTML 使用旧主题/字号。
2. 笔记：选区菜单先关闭，再打开笔记 modal，修复同一批 React 更新把编辑框覆盖为 none。
3. 已索引书籍删除：原生清理移到 blocking worker；批量选择共用一次 IPC/数据库事务和书架文件写入。最后一个索引采用同 schema 的 FTS 清空路径；其余选择按指纹集合合并删除。失败书籍保留在前端。

保留 Core/AI 身份和 schema 版本、稳定文本锚点、显示门、共享资源所有权。未升级依赖或版本，未接入新 AI 能力，未删除用户源 EPUB。

## 验收记录

- [x] 三个设置时序回归在修改前失败，修改后通过；连续主题/字号/字体资源变更也覆盖，共 4 项。
- [x] 添加笔记真实 React 点击回归在修改前为 none、修改后为 composer。
- [x] Chromium 1280×900 合成三章 EPUB：目录切深色 24px 后下一章正常；再切浅色 18px，下一章及回翻颜色/字号/可见性正确。
- [x] Chromium 选区右键添加笔记、保存、返回书架重开、列表读取、编辑保存通过；pageerror 为 0。
- [x] 删除测试覆盖批量 IPC、失败项保留、不循环重试；Rust 覆盖 FTS/chunks/staging/jobs 清理范围、旧 rowid、空/重复/非法指纹、事务回滚、遗留行保护、清空后重建、版本不变以及不初始化未使用数据库。
- [x] 前端 86 files / 547 tests、tsc；Core/AI 构建各 150 modules，两版 artifact gate 通过。
- [x] WSL Rust Core 49/49、AI 87/87、fmt 通过。
- [x] 合成数据库前后对照完成，见下表。
- [ ] Windows WebView2 与原书籍复验；Windows 端到端删除耗时/磁盘故障测试。

## 删除性能对照

固定随机种子生成 20,000 段，每段 600 个中文字符；相同 SQLite 文件复制后分别执行原逐本事务和新批量/清空算法。索引与正文表约 193 MiB。测试只覆盖 SQL 清理，不含 IPC、书架 JSON、Windows 杀毒/磁盘影响，不把数值当作所有书籍的保证。

| 数据分布及删除操作 | 修改前 | 修改后 |
|---|---:|---:|
| 100 本，每本 200 段，删除其中 1 本 | 0.220s | 0.217s |
| 同库删除 50 本 | 6.084s | 4.360s |
| 同库删除全部 100 本 | 13.986s | 1.291s |
| 仅有 1 本、占 20,000 段，删除该书 | 10.196s | 1.082s |

仅删除部分索引时仍需实际 FTS 删除，不能承诺单本秒删；后台 worker 防止该工作直接占住 UI 线程。最后索引清空后仍保留数据库文件及其可复用空间，不执行 VACUUM。

## 可复验命令与本地产物

在 `epub-reader` 使用本机 Node 22.23.2：

```sh
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node scripts/build-frontend.mjs build core
node scripts/build-frontend.mjs build ai
```

在 `src-tauri` 使用现有 Rust 工具链及 `/home/herenfor/.cargo` 依赖缓存：

```sh
cargo test --offline --no-default-features --features core --lib
cargo test --offline --no-default-features --features ai --lib
cargo fmt --check
```

本地复现脚本、合成 EPUB、截图和测量 JSON 存在 `.cache/core-fixes/`，仅本地验证，不属于同步内容：`smoke.mjs`、`delete-benchmark.py`、`delete-benchmark.json`（100 本矩阵）、`delete-benchmark-1x20000.json`（单本大索引）。浏览器测试使用项目已有 Chromium 和 `.pw-libs`；应用内浏览器工具在 WSL cwd 初始化时失败，因此使用本地 Playwright 完成页面验证。

## 边界与同步

- 所有改动只在隔离副本；真实源仓只读复核为 `main` / 本地 `origin/main` / `v0.1.9-beta.1` 的 `4aaa87137e5af237d0594bb64a2d9a285c2dd08c`，工作区干净。
- 源仓差异历史曾按 v0.1.6 登记，本轮已更正当前比较基线，但没有把历史差异表当作完整的新补丁清单。
- SQLite 清理自身有事务回滚；多个 JSON 仍沿用各自原子写入，不是跨文件统一事务。建库未结束时同时删除及 Windows 磁盘/文件占用压力场景尚未验证。
- C-57.6 双安装包和其他原任务待验收内容保持原状态。
