# 目录色块宽度与页面百分比间距修复

- 日期：2026-09-12
- 状态：本地修复、原书对照和回归完成，待 Windows WebView2 复验；未同步源仓。
- 对应：首轮 B-085～B-087；追加 B-088～B-090；C-04/C-16/C-16b/C-08/C-25/C-31。
- 工作边界：只修改 epub-reader。标题页背景图显示不全明确不属于 Bug，保持原行为；不改测试 EPUB，不提交或同步源仓。

## 定位与修复

| 目标 | 根因 | 修复结果（1280px，16px 字号） |
|---|---|---|
| 相容同居 01，中间蓝色盒子 | 用户补充后定位到 message.xhtml 制作信息页；中间是直接子、上下嵌套于链接，作者边距分别走不同限宽路径 | 三块由 608/640/608px 统一为 608px，左右缘同为 336/944px |
| 前辈 04，TOC.xhtml 目录卡片 | 对称 5% margin 触发 C-16 全页布局豁免，max-width 被解除 | 两侧 5% 改按版心取值，卡片由 1143px 收到 576px，仍保留双侧留白 |
| 国王求婚 06，TOC.xhtml 竖排引文 | 横排 Canvas 补偿误把竖排行厚度当作浮动塌缩，且竖排被版心 float 门控排除 | 约 384px 的错误宽度恢复为 28.7969px，无 inline width，右缘 921.609px，保留作者 2em 留白 |

共用规则只作用于无作者 sizing 意图的普通横排自动宽度块；固定长度边距进一步要求容器含块级内容，保留仅含行内内容的 div 展示标题。固定/未知 sizing、非对称/负 margin、fit/max-content、h1～h6 标题及原 C-40 居中例外保留。竖排 float 只在明确横排包含块下按物理方向收进版心，不改变书写模式。

## 验证

- [x] 三个目标原书的修复前后截图、元素宽度和边界对照。
- [x] 1280×720 / 16px / light，900×720 / 24px / dark，640×720 / 16px / light；再返回 1280/16/light，无宽度累计偏差。
- [x] 同一章节文档在 1280→900→640→1280 的真实 reflow 中复验，三处几何断言通过。
- [x] 三本 title.xhtml 的节点几何及页数在三种组合下前后一致，不改标题背景图行为。
- [x] 历史样本：赤月 contents.xhtml 单侧百分比、金木犀 contents.xhtml right float、みかみ目录居中、すめらぎ目录、玩具堂左对齐标题。五本的节点几何和页数均与修改前对照，尤其保留玩具堂左对齐标题的原盒宽/左缩进。
- [x] Vitest 87 文件 / 552 用例，tsc，Core/AI 前端各 150 modules，两个 artifact gate 通过；浏览器矩阵 pageerror=0。
- [ ] Windows WebView2 与用户当前窗口设置下的人工复验。

## 可同步代码

- `src/render/paginator.ts`：对称边距版心计算、设置临时值的恢复链；正交 float 的版心位置与横排 Canvas 补偿边界。
- `src/render/paginator.test.ts`：横排包含块内竖排 float 与不支持组合回归。
- `src/render/percentageInsets.test.ts`：双侧百分比/固定边距、窄容器、content-box、字号、作者 sizing 和未知/不安全布局边界。
- 本任务、BUGFIX_LOG、rendering-layers、SOURCE_DELTA、PROJECT_CONTEXT 及活动目录登记。

## 本地证据与复验

`.cache/toc-width/` 为本地专用目录，不同步：原书 CSS/目录提取、截图、probe.mjs、matrix.mjs、reference-extra.mjs、reflow.mjs、各 JSON/log。`paginator-before.ts` 从只读 beta.1 源仓复制出布局对照，使用当前相同 sanitizer 与真实资源；未写源仓。

前端：`node node_modules/vitest/vitest.mjs run`、`node node_modules/typescript/bin/tsc --noEmit`、`node scripts/build-frontend.mjs build core`、`node scripts/build-frontend.mjs build ai`。

本轮没有 Rust 改动，因此未重复运行后端测试或构建 Windows 安装包。测试用本机 Vite 5193 和已有 Chromium/.pw-libs，服务收尾关闭。私有书籍和截图均未上传。


## 2026-09-12 追加反馈：B-088～B-090

状态：代码和本地原书回归完成，待用户与汇报人确认观感、Windows WebView2 复验。首轮“标题页保持原样”仅指首轮范围；本轮用户明确授权修复相容同居标题的百分比上边距，仍不修改背景图设计。

| 目标 | 定位与处理 | 1280×720 / 16px 结果 |
|---|---|---|
| 世界啊臣服于吾之火焰 01，TOC.xhtml | 旧 C-25 将带尾随宽空格的 inline 色块原子化，宽空格参与宽度使色块等宽；优先保留 inline，仅在简单横排右对齐行、全部非空白文字都在行内时以 overflow-x:clip 裁掉外溢空白背景 | 恢复长短不一的可见色块，保留文字、章号位置和链接；分页统计同步排除这部分已裁掉的空白，640px 下仍 1 页，无新增空白页 |
| 赤月 02，contents.xhtml | 目录容器 width:auto + 左 margin:1.75em，被 C-04 平移完整 40rem，右缘超出；含块级内容的自动宽度容器将非负固定边距计入版心内，保留作者 width/min/max-width 与标题原路径 | 目录条目 640→612px，x=348，right=988→960；悬停背景跟随收窄。用户确认仅为“疑似”，先修复测得的条目越界；右下人物定位未改，待其与汇报人交谈 |
| 相容同居 01，title.xhtml | margin-top:40% 实际相对 1280px viewer 计算；页面级间距改按有效 min(包含块宽度,40rem)，百分比计算仍以宽度而非高度为依据 | margin-top=512→256px，2 页→1 页；大字号/窄窗仍允许内容正常分页 |

### 百分比间距边界

- 新增 `percentageSpacing.ts`：读取 Typed OM 最终级联，只替换计算值里的百分比项，保留 calc/min/max/clamp 的已解析长度项，交还浏览器计算；不扫描任意匹配规则猜测获胜值。
- 处理 html/body 的百分比 padding，以及普通页面直接子的上下 margin/四向 padding；先调整根 padding 再计算分页尺寸。逻辑属性由引擎映射到物理属性。
- 嵌套容器继续按自己的实际包含块计算，不二次投影；窄窗、非百分比、绝对定位、浮动、竖排、已超过版心的全宽盒和 fullpage 图片布局保留。没有 Typed OM 时保守跳过。
- 每次 measure 与 cleanup 都恢复原 inline 值及 priority；不修改 EPUB、文本、链接、背景图、百分比高度或 DOM 结构。
- C-25 的裁剪仅用于已证明文字完整可见的简单行；复杂布局继续原有保守补偿。分页只对本轮登记的裁剪行及后代计入可见边界，不全局改写内容范围。

### 追加验证

- [x] 8 个原书目标章节 × 4 组窗口/字号/主题：1280/16/light、900/24/dark、640/16/light、320/24/light，共 32 个记录；每组返回初始设置，并做 1280→700→1280 同文档 reflow，数值无累计偏差。
- [x] 火焰色块保留 inline、可见宽度多样、全部非空白字形在裁剪区内；640/16 为 1 页、900/24 为 2 页，无额外空白末页；真实后续列不被裁剪统计吞掉。
- [x] 上一轮蓝色卡片等宽、前辈百分比卡片、国王竖排 float 继续通过；国王/前辈两本背景标题页三种配置的几何和页数与首轮一致。
- [x] 历史目录另做 18 组 before/after：三上、金木犀的完整节点几何/页数一致；玩具堂标题保持一致，目录条目同样命中 B-089，收回右缘；1280/16、640/16 均保持 1 页，900/24 原先越界产生的第 3 页消失，恢复为 2 页。
- [x] 合成 Chromium 页面：root/top/nested padding、calc、逻辑 margin/padding、获胜的 px!important、窄容器、绝对定位/全宽/竖排/fullpage 排除、inline 恢复与再次应用均通过。
- [x] Vitest 89 files / 558 tests；Core/AI 构建含 tsc 与产物门禁通过（各 151 modules）。本轮无 Rust 改动。
- [ ] Windows WebView2 和汇报人观感确认。

可同步代码追加：`src/render/percentageSpacing.ts`、`percentageSpacing.test.ts`、`paginator.clippedExtent.test.ts`，以及 paginator.ts、paginator.test.ts、percentageInsets.test.ts 和本轮文档。现共用助手名为 `getReaderAutoBlockInsets`，取代首轮 `getReaderSymmetricInsets`，以表达新增的单侧固定留白支持。

本地证据：`.cache/width-spacing/` 中的 before/natural/after 原书截图、matrix.mjs/json/log、spacing.mjs/json、references.mjs/json/log、Vitest 和构建日志。原书提取和临时脚本均不列入同步。
