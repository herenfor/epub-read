# Bug 修复选择记录

本文不记录抽象的“技术偏好”，而记录真实 Bug 如何迫使项目选择当前方案。目的不是证明旧方案永远正确，而是避免新对话在不了解故障背景时撤销关键修复。

CSS 规则的逐项冲突编号仍以 `rendering-layers.md` 为准；本文记录跨模块原因与用户可见现象。

## 记录要求

修复非简单 Bug 时，追加一条记录，至少包含：

- 用户可见现象与触发操作；
- 可复现的 EPUB、合成章节或输入条件；
- 根因及其所在层；
- 修复必须满足的约束；
- 最终方案以及为什么选择它；
- 考虑但未采用的方案及原因；
- 修改文件；
- 本地验证和仍存风险。

## 记录模板

```markdown
## B-XXX：简短标题

- 状态：调查中 / 已修复 / 部分修复 / 已撤销
- 发现日期：YYYY-MM-DD
- 现象：
- 触发条件或样本：
- 根因：
- 约束：
- 选择的修复：
- 为什么这样修：
- 未采用方案：
- 修改文件：
- 验证：
- 剩余风险：
- 关联：C-xx、任务文件或提交
```

## 已知历史修复

以下内容根据现有代码、注释和渲染冲突台账回填，日期统一记为建档前。

## B-001：回翻上一章先闪第一页

- 状态：已修复
- 现象：在章节第一页继续向前翻时，新章节加载后先显示第一页，随后才跳到最后一页。
- 触发条件或样本：跨章向前翻页，上一章有多页内容。
- 根因：iframe 加载、字体等待和分页测量均为异步；内容在最终页数算出前已经可见。
- 约束：不能通过猜测页数提前滚动，也不能影响正常进入章节的显示。
- 选择的修复：`startAtEnd` 加载期间隐藏 viewer，完成测量并设置最后一页后再恢复可见。
- 为什么这样修：定位动作必须依赖真实页数；显示门能保证用户只看到最终位置。
- 未采用方案：加载后立即调用 `setPage`，因为此时 `pageCount` 仍可能是 1；用固定延时，因为字体和图片加载时间不稳定。
- 修改文件：`src/ui/ReaderView.tsx`、`src/render/paginator.ts`
- 验证：跨章回翻、快速连翻和无第一页闪帧的本地回归。

## B-002：旧章节延迟重排污染新章节

- 状态：已修复
- 现象：快速翻章或图片延迟加载时，阅读器可能停在错误页、沿用上一章页数或表现为卡在章末。
- 触发条件或样本：章节切换与旧章图片加载、ResizeObserver 或防抖 reflow 重叠。
- 根因：旧文档的异步测量完成后仍可能写回共享分页状态。
- 约束：不能取消所有图片重排，也不能让快速操作串行阻塞界面。
- 选择的修复：用 `loadSeq` 和 `reflowSeq` 标记当前代次，所有异步回调写回前核对代次并丢弃过期结果。
- 为什么这样修：代次校验不依赖底层异步任务是否支持取消，并能覆盖字体、动画帧、计时器和图片事件。
- 未采用方案：只清除定时器，因为已经进入 Promise/rAF 的测量仍会完成；全局互斥锁，因为会增加翻章等待。
- 修改文件：`src/render/paginator.ts`
- 验证：快速连续翻章、窗口重排和图片延迟加载本地回归。

## B-003：非 void 自闭合标签吞掉后续正文

- 状态：已修复
- 现象：某些 XHTML 章节在宽松 HTML 解析后丢失大片正文，或目录中后续字符被错误包进前一个 span/script。
- 触发条件或样本：`<script .../>`、`<span .../>` 等 XML 合法但 HTML5 不视为自闭合的标签。
- 根因：严格 XML 降级到 HTML 或 EPUB 3 HTML 解析时，HTML5 解析器忽略这些标签的自闭合斜线。
- 约束：`img`、`br` 等真正的 void 标签必须保持；脚本仍必须最终删除。
- 选择的修复：解析前把非 void 自闭合标签补成显式开闭标签，再执行正常消毒。
- 为什么这样修：在解析器吞内容之前修正结构，之后仍能统一应用危险标签删除规则。
- 未采用方案：解析后修 DOM，因为丢失的层级边界已经无法可靠恢复；永远强制 XML，因为不合规 EPUB 需要宽松容错。
- 修改文件：`src/render/sanitize.ts`
- 验证：消毒单测及相关目录页本地样本。

## B-004：宽屏下百分比盒子远宽于正文版心

- 状态：已修复
- 现象：书中 `width:90%` 的信息框在宽窗口几乎占满整页，而正文仍是 40rem；直接换成固定 em 后又会撑坏窄表格和注释容器。
- 触发条件或样本：宽窗口页面级百分比容器，以及 `td`、`note`、authorbox 等窄父容器。
- 根因：书籍通常按“页面约等于正文版心”设计百分比，阅读器的分页列却等于整个窗口宽度。
- 约束：页面级盒子不能过宽，窄父容器中的百分比仍必须相对真实父容器，超过 100% 的有意出血应保留。
- 选择的修复：把适用的 `width:X%` 改写为 `min(X%, X/100 × 40rem)`，并跳过纯标签、组合器、浮动和全页图等场景。
- 为什么这样修：浏览器可在真实包含块百分比和版心比例上限之间选择较小值，不再靠运行时猜父容器宽度。
- 未采用方案：统一固定 em 会撑坏窄容器；只按选择器类名特判无法覆盖未知 EPUB。
- 修改文件：`src/render/cssRewrite.ts`、`src/render/sanitize.ts`
- 验证：CSS 改写单测、sanitize 单测和宽度本地复现。
- 关联：`rendering-layers.md` C-07。

## B-005：多栏中的 float 与 fit-content 塌缩

- 状态：已修复
- 现象：聊天气泡、简介框等元素在 Chromium CSS 多栏中变成逐字窄条或异常宽度。
- 触发条件或样本：无显式宽度的浮动元素、`max-width:fit-content` 元素进入分页多栏。
- 根因：Chromium 多栏环境下 shrink-to-fit 和 fit-content 的使用宽度计算异常。
- 约束：书籍正常布局不应被统一定宽；补偿只能命中已经塌缩的元素，并在重新测量前恢复。
- 选择的修复：分页测量阶段检测异常；float 使用 Canvas 测量 max-content 后按父容器可用宽度写回，fit-content 使用版心上限补偿。
- 为什么这样修：只有浏览器完成真实布局后才能确认是否触发引擎问题，运行时条件比书名/类名特判更通用。
- 未采用方案：全局覆盖 float/fit-content，因为会破坏正常书籍设计；按单本书类名修复，因为无法扩展。
- 修改文件：`src/render/paginator.ts`
- 验证：相关真实书样本与布局诊断。
- 关联：`rendering-layers.md` C-08、C-09。

## B-006：默认居中覆盖书籍不对称 margin

- 状态：已修复
- 现象：目录交错缩进、namebox 等书内布局被阅读器默认居中规则抹平；简单移除居中又会让普通无布局章节贴边。
- 触发条件或样本：viewer 直接子元素具有书籍自定义 margin，或书籍存在通用 `div{margin:0}` reset。
- 根因：阅读器 L3 默认 margin 与书籍 L4 具体布局在同一元素上发生优先级冲突。
- 约束：普通直接子仍要默认居中，通用 reset 不应被误判为具体设计，嵌套布局应完全由书控制。
- 选择的修复：只标记 viewer 直接子；先按默认规则布局，再临时移除阅读器 margin 读取纯书值，对真正非零且非自动居中的不对称 margin 进行第二遍写回。
- 为什么这样修：两阶段测量能够区分“书没有意见”“书只是 reset”与“书明确设计了偏移”。
- 未采用方案：给所有元素强制居中会破坏嵌套布局；完全尊重 margin 会失去阅读器默认版心；类名白名单不可维护。
- 修改文件：`src/render/sanitize.ts`、`src/render/paginator.ts`
- 验证：目录交错、namebox、普通正文居中的本地回归。
- 关联：`rendering-layers.md` C-03、C-04。

## B-007：内联 CSS 子选择器在章节序列化后失效

- 状态：已修复
- 发现日期：2026-08-17
- 现象：`div > p` 一类子选择器不生效；相邻兄弟 `+`、通用兄弟 `~` 和后代选择器正常。
- 触发条件或样本：`<PROJECT_ROOT>/测试用epub/【测试专用】选择器.epub` 的 `message.xhtml` 内联样式 `.parent>.direct-child`。
- 根因：章节消毒完成后经 `XMLSerializer` 输出，`<style>` 文本中的 `>` 被转义为 `&gt;`；输出又作为 HTML 装载，而 style 属于 raw-text 元素，不会把它还原成 CSS 子组合器。
- 约束：不能整份 HTML 反转义；尤其必须保持 `<` 的转义，避免重新引入 `</style>` 逃逸；外部 CSS 和其他组合器不得变化。
- 选择的修复：在 `XMLSerializer.serializeToString(doc)` 之后，仅匹配序列化输出中的 `<style>...</style>` 块，把其中的 `&gt;` 恢复为 `>`；不恢复 `&lt;`，也不触碰 style 之外的文本、属性或外部 CSS blob。
- 为什么这样修：故障发生在 XML 到 HTML 的序列化边界，应该在该边界修复，避免改写或降级作者选择器；限定 raw-text 区域可以让 CSS 子组合器恢复，同时保持章节消毒与 URL 改写路径不变。
- 未采用方案：把所有 `>` 子选择器改成后代选择器，因为语义不同，会命中更深层后代；对整份 HTML 执行实体解码，因为会破坏属性/文本并产生注入风险；改用纯 HTML 序列化，因为会扩大 XHTML、自闭合标签和命名空间行为的变化面。
- 修改文件：`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`docs/rendering-layers.md`、`docs/tasks/archive/child-combinator-serialization.md`。
- 验证：严格 XML 与 HTML 降级回归均通过；`vitest` 全量 10 个文件、131/131 通过；`tsc --noEmit` 通过；用户测试 EPUB 的 `message.xhtml` 经项目 `loadBook`/`sanitizeChapter` 后保留 `.parent>.direct-child`。Chromium computed style 验证子选择器匹配 2 个（背景 `rgb(237, 233, 254)`、边框 `rgb(139, 92, 246)`），相邻兄弟匹配 1 个，通用兄弟匹配 3 个，预期样式均生效。
- 剩余风险：实现针对当前 XMLSerializer 的 `&gt;` 输出；若将来更换序列化器并输出数字字符引用，需另行验证。浏览器验证所用 `.pw-browsers`、`.pw-libs` 和 `/tmp` 临时脚本不属于同步内容。
- 关联：`docs/tasks/archive/child-combinator-serialization.md`。

## B-008：div 分页容器污染作者后代选择器

- 状态：已修复
- 发现日期：2026-08-17
- 现象：标题章节 body 顶层的“测试”“测试2”被 `div p{background-color:yellow}` 错误匹配，呈现整行黄色背景。
- 触发条件或样本：`【测试专用】选择器.epub` 的 `title.xhtml`。
- 根因：消毒器把全部正文包进新增的 `<div id="epub-viewer">`，改变了作者 CSS 的祖先类型关系。
- 约束：必须保留独立分页容器和直接子标记，不得破坏分页测量。
- 选择的修复：使用 `<epub-viewer id="epub-viewer">` 作为分页容器，并在阅读器注入 CSS 中显式设为 `display:block`；分页器仍按 `#epub-viewer` 查找容器。
- 为什么这样修：自定义标签不再成为作者 `div p`、`section p` 等常见类型选择器的祖先，同时保留现有 ID、直接子 `reader-top` 标记和分页 API。
- 未采用方案：针对 title 章节覆盖 `div p`，因为不能恢复所有未知作者选择器的结构语义；换成另一常见 HTML 标签同样可能污染类型选择器；移除容器会破坏分页器契约。
- 修改文件：`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`docs/rendering-layers.md`、`docs/tasks/archive/selector-pseudo-state-compat.md`。
- 验证：先写的回归在旧实现失败；最终严格 XML 逻辑回归证明 body 顶层 p 无 div 祖先、作者 div 内 p 仍匹配。全量 `vitest` 11 文件、136/136 通过，`tsc --noEmit` 通过。真实测试 EPUB Chromium 中“测试/测试2”背景均透明，`.titlebox p` 仍为黄色，分页容器标签为 `EPUB-VIEWER`。
- 剩余风险：自定义标签仍是额外 DOM 祖先；它避免常见 HTML 类型选择器污染，但无法还原 `body > *` 一类被包装结构改变的选择器，后续遇到样本需单独评估分页容器架构。
- 关联：C-14、`docs/tasks/archive/selector-pseudo-state-compat.md`。

## B-009：阅读器接管锚点后 :target 状态丢失

- 状态：已修复
- 发现日期：2026-08-17
- 现象：点击 `#target1/#target2` 能执行阅读器定位，但目标元素没有 `:target` 高亮。
- 根因：分页器阻止浏览器默认锚点导航后只调用 `jumpToAnchor`，没有更新 iframe 的 `location.hash`。
- 约束：脚注和跨章链接不受影响；更新 fragment 后仍由分页器控制最终列位置。
- 选择的修复：纯 fragment（且非脚注）先经 `getFragmentNavigation` 解析原始 hash 与解码后的目标 ID，安全写入当前 iframe 的 `location.hash`，再调用 `jumpToAnchor`。空 fragment 忽略，畸形百分号编码回退原文，iframe location 不可访问时吞掉异常而仍尝试分页定位。
- 为什么这样修：Chromium 最小复现确认 `location.hash` 才会激活原生 `:target`；保留原始编码给 URL、解码后查 DOM 同时覆盖标准 EPUB 链接和带空格/`#` 的 ID。
- 未采用方案：`history.replaceState` 已证实不改变 `:target`；放开默认锚点导航会绕开分页器的列定位；统一处理所有 `#...` 会破坏脚注的弹层优先分支。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/tasks/archive/selector-pseudo-state-compat.md`。
- 验证：先写的 helper 回归在旧实现失败；最终覆盖编码、空 fragment、畸形编码和不可访问 location。全量 `vitest` 11 文件、136/136 通过，`tsc --noEmit` 通过。真实测试 EPUB Chromium 中点击 `#target1/#target2` 后 hash 与粉色目标高亮同步切换，前一个目标恢复基础背景。
- 剩余风险：作者若用 `:target` 大幅改变目标尺寸，仍可能触发页数变化；当前样本只改变边框、背景与阴影，不改变盒子尺寸。
- 关联：`docs/tasks/archive/selector-pseudo-state-compat.md`。

## B-010：安全消毒删除全部 input 导致状态伪类失效

- 状态：已修复
- 发现日期：2026-08-17
- 现象：`:enabled/:disabled/:checked` 测试模块没有输入控件和状态样式。
- 根因：`STRIP_TAGS` 无差别删除所有 `<input>`。
- 约束：只恢复明确安全、无提交能力的 input 类型；事件属性继续删除，form 与危险控件继续禁止，CSP 不放宽。
- 选择的修复：从 `STRIP_TAGS` 移除 input，新增窄白名单：`text`、`checkbox`、`radio` 和 HTML 默认文本的空 type；其余类型整元素删除。
- 为什么这样修：这三类控件可提供所需的 `:enabled/:disabled/:checked` 状态和本地交互，不具备文件选择或提交/按钮语义。form 仍删除，事件属性仍在统一属性消毒中移除，CSP 的 `form-action 'none'` 未放宽。
- 未采用方案：恢复所有 input 或扩大到 password/date/hidden 等无本任务必要的类型，会扩大可交互表面且降低最小权限；只保留 checkbox/radio 会让默认文本控件失去 `:enabled/:disabled` 兼容性。
- 修改文件：`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`docs/tasks/archive/selector-pseudo-state-compat.md`。
- 验证：先写的严格 XML 与 HTML 路径回归在旧实现失败；最终验证 `checked`、`disabled`、label `for` 保留，事件属性被删除，file/submit/image/button/reset/hidden 和 form/button/select/textarea 被删除。全量 `vitest` 11 文件、136/136 通过，`tsc --noEmit` 通过。真实 iframe 中 enabled/disabled 初始背景正确，checkbox/radio 点击后状态与相邻 label 紫色高亮同步变化。
- 剩余风险：白名单刻意只覆盖 text/checkbox/radio；未来若需更多 input 类型必须单独安全评审。
- 关联：`docs/tasks/archive/selector-pseudo-state-compat.md`。

## B-011：顶层链接包裹块级正文时贴窗口左缘

- 状态：已修复
- 发现日期：2026-08-17
- 现象：`<a href="x.xhtml"><p>第一章</p></a>` 作为章节顶层内容时，文字版心贴在窗口左侧。
- 触发条件或样本：viewer 直接子为默认 inline 的 a，内部包含 p/div 等块级内容。
- 根因：`reader-top` 的 max-width 与左右 auto margin 标记在 a 上，但 inline 元素不应用这组块级版心尺寸。
- 约束：不能把所有书内链接强制定宽；作者明确声明的 display 应继续优先。
- 选择的修复：为 `a.reader-top` 增加零特异性 `display:block` 默认值，使页面级链接参与既有 40rem 版心布局；嵌套链接不受影响。
- 为什么这样修：问题只发生在 viewer 顶层链接，复用已有 reader-top 边界即可精准命中，不需要改写书籍 DOM 或给内部 p 追加错误的页面级标记。
- 未采用方案：给所有 a 强制 block 会破坏行内链接；给内部 p 添加 reader-top 会违反“只标记 viewer 直接子”的布局契约。
- 修改文件：`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`docs/rendering-layers.md`。
- 验证：`sanitize.test.ts` 44/44、全量 Vitest 11 文件 137/137、`tsc --noEmit` 通过。Chromium 1200px 视口实测 viewer 宽 1200px，顶层链接与内部 p 均宽 640px、左缘 280px，链接 computed display 为 block。
- 剩余风险：作者若明确把顶层链接设回 inline，阅读器尊重作者声明，版心行为由书负责。
- 关联：C-15。

## B-012：百分比 margin 与 fit-content 被二次推向右侧

- 状态：已修复
- 发现日期：2026-08-17
- 现象：测试书标题作者信息严重靠右并溢出到第二页；简介盒也整体靠右。
- 触发条件或样本：`【测试专用】[七菜なな].男女之间存在纯友情吗？（不，不存在！）.03.epub` 的 title/summary。
- 根因：`applyBookMargins` 对页面相对的百分比 margin 又叠加居中版心 base；auto margin 判断使用 content-box width，未计 padding/border，导致 fit-content 盒被误判为不对称 margin。
- 约束：通用修复，禁止类名/书名特判；重排可恢复；既有小幅 em 缩进、auto 居中和 C-09 保持。
- 选择的修复：auto-like 判断统一改用 border-box 宽度；对作者明确的 inline 水平百分比 margin，按需解除阅读器默认 max-width，读取并原位写回包含块相对布局，不再叠加版心 base。margin/max-width 临时写回同时保存值和优先级，重排前完整恢复。
- 为什么这样修：两处异常均来自同一个二阶段 margin 决策，而非 CSS 百分比改写器本身。
- 未采用方案：删除书的 35% margin 或强制 `.summary` 居中属于单书特判；统一取消 margin 补偿会复发 B-006。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/rendering-layers.md`、`docs/tasks/archive/percent-margin-fit-content-layout.md`。
- 验证：定向 49/49、全量 140/140、`tsc --noEmit` 通过。真实 Chromium 中标题由 2 页恢复为 1 页且不再右溢出；简介中心为 viewer 中心 x=640；字号放大两档重排后两页位置均无累计漂移。
- 剩余风险：当前百分比分支识别作者 inline style；若未来样本把水平百分比 margin 仅写在外部 CSS 中，需要在保持级联准确性的前提下扩展声明来源识别。
- 关联：C-16、`docs/tasks/archive/percent-margin-fit-content-layout.md`。

## B-013：inline SVG 图片页超过可视高度被裁切

- 状态：已修复
- 发现日期：2026-08-17
- 现象：多看格式的彩图/标题页使用 `div > svg > image` 包装时，图片下部超出显示范围；制作信息页的顶层 `<hr/>` 曾出现水平偏移。
- 触发条件或样本：`【测试专用】（多看）面对摆出姐姐架子的初恋对象、我是绝对不会屈服的！.epub` 的 `title.xhtml`、`title-zh.xhtml`、`contents-illus.xhtml` 与 `messa.xhtml`。
- 根因：纯图片页检测只统计 HTML `img`，未识别 SVG 的 `<image>`，因此页面没有进入 `fullpage-image` 模式；顶层 div 受 40rem 版心限制后，SVG 按 `viewBox` 固有比例得到 908.6px 高，超过 739px viewer 但仍被统计为 1 页。`hr` 则带有 UA 双侧 1px border，旧的 content-box margin 判断会产生与 B-012 相同的误判。
- 约束：不按书名/章节名/类名特判；文字页、多个图片的排版页和固定限宽 HTML 图片页不得放大；保留 SVG 的 `viewBox`、`preserveAspectRatio` 与内部 `<image>` 尺寸。
- 选择的修复：把“无文字、单个带 viewBox 的 SVG，且 SVG 直接包含单个 image”纳入纯图片页；全页高度只传递给 HTML 包装祖先，SVG 视口使用 100% 宽高，内部 image 继续由书的 `preserveAspectRatio` 控制。为 `hr` 增加显式 border-box 单测，不再新增运行时代码，因为 B-012 已通用修复。
- 为什么这样修：触发条件描述的是内容结构和流体尺寸意图，能覆盖同类多看 EPUB，又不会把正文 SVG 图标或信息图升级为整页图；复用现有 fullpage 生命周期，不增加新的分页补偿时序。
- 未采用方案：给所有 SVG 强制 `max-height`/固定像素高会误伤正文矢量图；按 `title.xhtml` 或 `title.jpg` 特判不能覆盖其他书；直接改 `<image>` 的 width/height 会破坏 SVG 坐标系与作者比例设计。
- 修改文件：`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`src/render/paginator.test.ts`、`docs/rendering-layers.md`、`docs/tasks/archive/svg-image-and-hr-layout.md`。
- 验证：定向 51/51、全量 Vitest 11 文件 142/142、`tsc --noEmit` 通过。真实 Chromium 1280×800 中三章 SVG 页均为 1/1 页且 `scrollHeight === clientHeight === 739`；标题图片高度由裁切的 908.6px 降为可视区内 678.2px。窗口缩至 900×650 后彩图仍为 1 页且完整显示。制作信息页所有 `hr` 在 1280px 与 900px 两种列宽、包括第二列中，border-box 中心均与列中心一致且没有运行时 margin 写回。
- 剩余风险：当前只接纳 SVG 直接包含一个 image 的纯图片结构；若以后出现合法的 `<defs>`/`<g>` 包装图片页，需要在不误判正文 SVG 的前提下扩展结构识别。
- 关联：C-17、`docs/tasks/archive/svg-image-and-hr-layout.md`。

## B-014：多个 fit-content 简介盒按内容长度横向散开

- 状态：已修复
- 发现日期：2026-08-17
- 现象：同一简介页的三个灰色盒没有沿同一正文轴排列：第一个近似居中、第二个明显偏左、第三个贴近页面左侧并在换列后继续错位。
- 触发条件或样本：`【测试专用】[final][こりんさん].班上的原偶像，总之就是举止可疑.02.epub` 的 `summary.xhtml`；页面级盒同时使用 `max-width:fit-content` 和后置 `div.summary{margin:1em}`。
- 根因：`measure()` 先按 Chromium 多栏中尚未补偿的异常 fit-content 宽度计算并写回 margin，之后才把 max-width 固定到 40rem，导致位置基于旧宽度、显示基于新宽度。其次，二阶段 margin 把左右相等的正值 1em 当成 `ml>0` 单向缩进，使正常双侧留白额外右移。
- 约束：不按 summary 类或书名特判；B-012 的百分比 margin、auto 居中和 border-box 判断保持；真正不对称的书籍缩进继续生效；无水平 margin 的 fit-content 左对齐语义保持。
- 选择的修复：测量稳定后先执行 fit-content 宽度补偿，再基于最终 border-box 宽度处理页面级 margin；通过本轮 fit-content 补偿元素集合保留原始收缩意图。新增正对称水平 margin 判定：仅正有限值且左右差小于 0.5px 时保持 reader auto 居中，负 margin 仍视为可能的双侧出血。
- 为什么这样修：盒宽是 margin 定位的输入，先稳定宽度才能得到确定位置；正对称留白没有左右方向，不应进入单向缩进分支。两项判断均由布局属性触发，可覆盖未知 EPUB。
- 未采用方案：强制 `.summary{margin:auto}` 会成为类名特判；统一忽略所有书 margin 会复发 C-04；禁止盒子跨页会改变内容分页并可能制造大片空白。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/rendering-layers.md`、`docs/tasks/archive/fit-content-symmetric-margin-layout.md`。
- 验证：先写的 symmetric margin 回归在旧实现失败；定向 52/52、全量 Vitest 11 文件 143/143、`tsc --noEmit` 通过。真实 Chromium 中 1280×800 的所有盒/跨列碎片均以 640px 宽在所属列居中；900×650 同样对齐。字号由 16px 放大到 20px 后盒宽变为 800px、页数由 2 变 3，所有碎片仍居中且无 `data-reader-margin-fixed` 累计写回。B-012 标题/简介实书脚本复跑通过。
- 剩余风险：正对称负 margin 被刻意保留为潜在出血布局；若未来真实样本需要对称负 margin 也相对版心处理，应独立评估。
- 关联：C-18、`docs/tasks/archive/fit-content-symmetric-margin-layout.md`。

## B-015：章节首次显示时稳定盒子仍横向闪动

- 状态：已修复
- 发现日期：2026-08-17
- 现象：首次进入简介等需要二阶段布局补偿的章节时，灰色盒会在一瞬间从偏左/偏右位置移到居中；已有 `startAtEnd` 隐藏只覆盖回翻上一章，普通入口仍会显示中间帧。
- 触发条件或样本：`【测试专用】[final][こりんさん].班上的原偶像，总之就是举止可疑.02.epub` 的简介页；首次逐帧记录还发现，组件挂载遗留的同尺寸 `ResizeObserver` 回调会在 ready 后再次撤销补偿约两帧。
- 根因：blob iframe 一加载即可绘制，但 `measure()` 要等待字体和双 rAF 后才应用 fit-content/margin/float 二阶段补偿。旧 `recompute()` 的自愈重试又是 fire-and-forget，外层 `.finally(showViewer)` 无法知道最终分页是否稳定。同尺寸 reflow 仍执行 `measure()`，会先恢复补偿值再等待，造成揭示后的第二次跳动。
- 约束：隐藏期间必须继续参与真实布局，不能用 `display:none`；普通进入、目录锚点、阅读锚点和 `startAtEnd` 共用同一稳定边界；快速切章的旧任务不能揭示新章；错误、超时和销毁不能留下永久空白；P1/P2 仅预留，不在本轮建立缓存池或动画。
- 选择的修复：新增独立 `VisibilityGate`，在 load、blob 导航和 iframe load 边界用带代次的 `visibility:hidden!important` 管理整个 iframe，并原样恢复既有 inline 值。把首次准备集中到 `prepareChapterForDisplay()`；`recompute()` 改为 Promise，能够等待内部最多两次测量自愈，随后执行目录锚点/章末定位再解除显示门。显示门提供 20 秒兜底，错误和 dispose 同样恢复。记录最近一次完整测量的 iframe 尺寸，尺寸未变时跳过 ResizeObserver 空转。
- 为什么这样修：隐藏 iframe 能阻止 blob 文档任何未稳定首帧漏出，同时 `visibility:hidden` 不改变尺寸和 CSS 多栏计算；代次门延续 B-002 的过期任务规则。将“准备完成”定义为可等待流程，也给以后相邻章节预渲染留下单一 ready 边界，而不提前引入缓存复杂度。
- 未采用方案：固定延时无法覆盖字体、图片和两次自愈；只在 `measure().finally()` 显示会早于异步 recompute 重试与最终定位；`opacity:0` 仍可接收指针事件且本轮不需要淡入；`display:none` 无法测量分页；立即实现前后章 iframe 池会把缓存失效、内存和竞态带入当前闪帧修复。
- 修改文件：`src/render/displayGate.ts`、`src/render/displayGate.test.ts`、`src/render/paginator.ts`、`docs/PRELOAD_PLAN.md`、`docs/PROJECT_CONTEXT.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/tasks/archive/initial-render-visibility-gate.md`。
- 验证：`displayGate.test.ts` 4/4，覆盖代次转交、原始 priority 恢复、超时与 dispose；全量 Vitest 12 文件 147/147、`pnpm build` 通过。真实 Chromium 逐帧检查中，简介页 load 时错误盒左缘 448/310/5 与中间帧 343/127/5/1299 均只在 hidden 状态出现；首个可见帧左缘 320/320/320/1614 与最终帧完全一致，揭示后 500ms 无再次跳动。从第二章回翻时目标章 load/首帧隐藏，首个可见帧即第 10/10 页且 `scrollLeft=11646`。1280→900 视口、16→20px 字号以及选择器整书的 `:target/:checked` 回归继续通过。
- 剩余风险：20 秒是防永久空白的可见性兜底；极端字体或引擎停滞超过上限时可能先显示当前最佳布局，但状态不会被伪造为 ready。P1 相邻章缓存和移动端真机内存/动画仍未实施。
- 关联：C-19、`docs/PRELOAD_PLAN.md`、`docs/tasks/archive/initial-render-visibility-gate.md`。

## B-016：隐藏渲染期间持续滚轮被吃掉

- 状态：已修复
- 发现日期：2026-08-17
- 现象：在章节末页持续向下滚轮进入下一章，虽然隐藏布局结束并显示了新章，但阅读器不再接着向下翻，用户必须重新滚动。
- 触发条件或样本：任意跨章滚轮；Chromium 自动回归使用 `【测试专用】[final][こりんさん].班上的原偶像，总之就是举止可疑.02.epub`，从第一章第 10/10 页持续滚向第二章。
- 根因：B-015 使用 `visibility:hidden` 保留布局，但 hidden iframe 不参与鼠标命中，加载阶段的 wheel 会落到外层 `.reader`。第一次修正只让外层在非 ready 时保存一个方向；真实使用继续暴露浏览器的滚轮目标锁定：同一段连续滚动开始命中外层后，即使 iframe 已显示，后续 wheel 仍可能发给外层，而第一次修正此时因 `isReady` 直接忽略，所以稳定停在第 2 页（反向为倒数第 2 页）。更早的旧逻辑还会把进入分页器的非 ready 输入直接丢弃。
- 约束：页数未知时仍不能立即翻页；大量 wheel 事件不能变成多页队列；方向反转时以最后输入为准；必须在 B-015 的字体、分页自愈、锚点/章末定位和显示门解除之后消费；空章、错误、换书和 dispose 不得误执行旧意图。
- 选择的修复：新增 UI 层 `TurnIntentBuffer` 单槽状态机。非 display-ready 时只覆盖保存最后方向，display-ready 后取出并清空一次；ready 状态立即放行。`ReaderView` 始终接收外层 `.reader` 的 wheel：新增 `WheelTurnAccumulator`，用与 iframe 分页器一致的 80px 有符号累计阈值把外层连续 delta 转成翻页，因而滚轮目标锁定跨过 ready 后仍可继续。分页器在 `prepareChapterForDisplay()` 成功、最终入口定位完成且显示门解除后触发独立 `onDisplayReady`；跨章请求立即标为 loading，错误和销毁 reset 缓冲与累计量。
- 为什么这样修：单槽表达“加载时仍想往最后方向继续”，而不是重放加载期硬件事件；一次准备最多消费一次。ready 后的事件已经是当前持续输入，应按阈值逐页执行，而不是继续压缩。独立 display-ready 回调避免目录锚点或 `startAtEnd` 被抢跑，有符号累计又兼容高分辨率触控板的小 delta 与中途反向。
- 未采用方案：取消非 ready 防护会按临时页数错误跨章；累计每个 wheel 会在高分辨率滚轮/触控板下瞬间跳过很多页；改回 `opacity:0` 仅为接收事件会重新引入透明内容的交互与无障碍问题；固定延时后翻页无法判断布局和最终定位是否完成。
- 修改文件：`src/ui/turnIntent.ts`、`src/ui/turnIntent.test.ts`、`src/ui/ReaderView.tsx`、`src/render/paginator.ts`、`docs/PROJECT_CONTEXT.md`、`docs/MODULE_CONTRACTS.md`、`docs/PRELOAD_PLAN.md`、`docs/rendering-layers.md`、`docs/tasks/archive/wheel-intent-during-hidden-render.md`。
- 验证：`turnIntent.test.ts` 7/7，新增覆盖小 delta 阈值、正反抵消与 reset；全量 Vitest 13 文件 154/154，`pnpm build` 通过。第一阶段回归仍证明 hidden 时 20 个向下事件只消费一次、`[下, 下, 下, 上]` 以最后方向为准。滚轮目标锁定回归让同一个外层目标每 25ms 持续发事件跨过 hidden→visible：向下由第一章 10/10 跨到第二章并继续至 11/23（1 个 hidden、9 个 visible 事件）；向上由第二章 1/23 跨到第一章末尾后继续至 2/10（1 个 hidden、7 个 visible 事件），不再停在第 2/倒数第 2 页。
- 剩余风险：单槽刻意不保留加载期间的滚轮力度和事件数量，因此非常长的加载也只自动推进一次；display-ready 后仍在发生的锁定滚轮事件会正常连续快进。后续若做移动端手势/惯性动画，应在 P2 单独定义速度与取消语义，不能把加载期缓冲扩成无限队列。
- 关联：C-20、B-015、`docs/tasks/archive/wheel-intent-during-hidden-render.md`。

## B-017：短目录页被 body padding 撑出原生滚动条

- 状态：已修复
- 发现日期：2026-08-17
- 现象：目录内容没有占满一页，iframe 右侧仍出现纵向滚动条。
- 触发条件或样本：`【测试专用】[いのり。].我的推是坏人大小姐.02.epub` 的 `contents.xhtml`；书给 `.contpage` 设置 `padding:1em 0 2em`。
- 根因：阅读器把 `html/body` 固定为 `height:100%`，但没有规定盒模型。该书的 body 仍为 content-box，739px 内容高度再加 16px/32px 上下 padding 后变成 787px，根元素 `scrollHeight=787`，超过 739px iframe；这与正文是否填满无关。
- 约束：不能清零书籍 body padding（C-05 明确保留）；正文仍只由 `#epub-viewer` 分页，不能转回根页面原生滚动；水平 padding 参与既有可用页宽计算。
- 选择的修复：在根页面 L1/L3 契约中给 `html/body` 设置 `box-sizing:border-box`，使书籍 padding 包含在 100% 高度内；同时以 `overflow:hidden!important` 明确禁止根页面原生滚动，实际内容继续由 viewer 多栏分页。
- 为什么这样修：border-box 修正了真实几何，而不是只把滚动条视觉藏掉；overflow 底线防止绝对定位等书籍内容重新启用 iframe 根滚动。书的 16px/32px padding 仍保留，viewer 高度按内容区自然变为 691px。
- 未采用方案：`padding:0!important` 会复发 C-05 并破坏书籍留白；只隐藏滚动条但保持 787px body 会让 viewer 继续越出根盒；按 `.contpage` 或书名处理不能覆盖其他带 body padding 的 EPUB。
- 修改文件：`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/tasks/archive/toc-overflow-and-dashed-border.md`。
- 验证：先写的合成章节回归在旧实现失败；修复后 `sanitize.test.ts` 47/47、全量 Vitest 13 文件 156/156、`pnpm build` 通过。真实 Chromium 1280×800 中 iframe/html/body 均为 `clientHeight=scrollHeight=739`，body padding 仍为 16px/32px，viewer 为 `clientHeight=scrollHeight=691`，无根页面可滚动溢出。
- 剩余风险：作者若刻意依赖 body 原生滚动将不再生效；这与本阅读器“viewer 独占分页”的既有架构不兼容，属于明确不支持的书籍行为。
- 关联：C-05、C-21、`docs/tasks/archive/toc-overflow-and-dashed-border.md`。

## B-018：目录项虚线与文字在多栏断点被拆开

- 状态：已修复
- 发现日期：2026-08-17
- 现象：目录页底部出现一条没有文字的虚线，而对应目录文字被移到下一页，表现为 `border-bottom:1px #000 dashed` 没有正确跟随条目。
- 触发条件或样本：`【测试专用】[kiki].「凭妳也想讨伐魔王？」被勇者小队逐出队伍，只好在王都自在过活.04.epub` 的 `contents.xhtml`；结构为 `a > div + p`，虚线在 div 上，p 用负上 margin 叠在虚线上。
- 根因：CSS 子组合器和 border 级联均正常：浏览器计算结果始终是 `1px dashed rgb(0,0,0)`。真正问题是默认 inline 的 a 包含两个块级子元素，Chromium 多栏在第 20 条处把同一锚点拆成两列：线位于第一列 `(320,703)`，文字位于第二列 `(1624,35)`，锚点合并矩形横跨 1912px。
- 约束：不能给所有 div/段落统一 `break-inside:avoid`；普通行内链接保持 inline；合法 border 的宽度、线型、颜色和作者负 margin 均不改写；作者明确的 display/break 规则应可覆盖阅读器默认值。
- 选择的修复：增加零特异性 L3 默认规则，只匹配“直接包含常见块级结构元素”的锚点，为其提供 `display:block` 和 `break-inside:avoid`。普通只含文本/span/img 的行内链接不命中；过高、无法容纳一页的链接仍由 CSS fragmentation 规则自然拆分。
- 为什么这样修：链接包裹块级结构本身表达一个可点击的复合条目，将锚点设为块并避免在内部断开比猜测外层 div 类名更通用；零特异性保留 L4 作者规则优先级，也延续 B-011 对页面级块链接的处理方向。
- 未采用方案：改写 border 简写没有作用，因为计算样式早已正确；给所有 div 禁止分页会制造大片空白并误伤正文盒；只匹配 `a>div+p` 过度依赖当前书的结构；用书名/目录类特判不可维护。
- 修改文件：`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/tasks/archive/toc-overflow-and-dashed-border.md`。
- 验证：先写的不可拆块规则回归在旧实现失败；修复后 `sanitize.test.ts` 47/47、全量 Vitest 13 文件 156/156、`pnpm build` 通过。真实 Chromium 中 27 条目录链接 computed display/break 为 `block/avoid`；断点处第 20 条的虚线和文字一起移到第二列，拆分条目从 1 个变为 0，页数仍为 2，border 仍为 1px dashed 黑色。
- 剩余风险：规则使用现代 Chromium 支持的 `:has()`；当前 WSL Chromium/Tauri 目标满足。若未来支持不具备 `:has()` 的旧 WebView，需要在消毒阶段给块链接打等价标记，而不是删除本规则语义。
- 关联：C-22、B-011、`docs/tasks/archive/toc-overflow-and-dashed-border.md`。

## B-019：小头像 float 被文字收缩补偿错误撑宽

- 状态：已修复
- 发现日期：2026-08-17
- 现象：模拟评论盒中 24px 人物头像与用户名之间出现约 58px 的异常空隙；头像自身纵向位置正常。
- 触发条件或样本：`【测试专用】[あさのハジメ].要是和只对我冷淡的友利同学说『我知道你有隐藏账号』的话会怎么样？.01.[美化版].epub` 第一话；头像位于无显式 width、只含缩进空白与 `img` 的 `float:left` 容器中。
- 根因：C-08 以 computed width 不超过 48px 识别多栏中的文字 shrink-to-fit 塌缩，正常的 27.1875px 头像容器也满足该阈值。Canvas 测量又把 `img` 前后的源码缩进文本当成可见内容累加，最终写入 `width:82.2px`，而浏览器原生宽度应为 24px 图片加 3.1875px 右 padding。
- 约束：保留 C-08 对真实文字气泡的补偿；不按书名、类名或图片 alt 特判；不修改作者的 `float`、负 margin、padding，也不处理本书评论盒的跨栏拆分。
- 选择的修复：在 C-08 Canvas 测量前识别“有效内容只有直接 `img/svg`”的媒体 float；源码格式化空白和注释不视为内容，这类容器保留浏览器原生 shrink-to-fit。只要存在可见文字、其他元素或没有媒体，就继续走原有判断。
- 为什么这样修：替换元素已有可靠的浏览器固有尺寸，不需要文字 max-content 补偿；以内容类别区分正常窄媒体和异常窄文字，比调整 48px 阈值更准确，并使未知书籍中的同结构小头像同样受益。
- 未采用方案：全局忽略空白文本会低估两个 inline 元素间合法的折叠空格；降低宽度阈值会漏掉真实文字塌缩；删除 C-08 会让既有聊天气泡回归；`.twitter-tweet`/`miaotter` 特判不可维护。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/rendering-layers.md`、`docs/tasks/archive/media-only-float-avatar.md`。
- 验证：新增回归在旧实现下 2 项失败；修复后 paginator 9/9、全量 Vitest 13 文件 158/158、`tsc --noEmit` 通过。真实 Chromium 1280×800 中 14 个头像容器均不再被写入 width，computed width 为 27.1875px，头像到用户名间距为 3.1875px，章节仍为 18 页；作者的 `margin-top:-0.2em` 保持 -3.1875px，评论盒拆分数量仍为 4，证明本轮没有改变分页策略。
- 剩余风险：本轮有意只覆盖直接 `img/svg`；若未来出现 `picture` 或多层 inline 包裹的同类误判，应基于新实书扩展“媒体专用”定义，不能递归跳过可能含文字语义的任意容器。
- 关联：C-08、C-23、`docs/tasks/archive/media-only-float-avatar.md`。

## B-020：Windows 批量导入把 EPUB 展开成巨型 JSON 数组

- 状态：已修复，待 Windows 发布包性能确认
- 发现日期：2026-08-17
- 现象：Windows 发布版导入 EPUB，尤其批量导入时，速度远慢于 WSL 浏览器预览且 CPU 占用很高；导入期间书架逐本刷新。重复上传仍完整执行解析、保存和封面覆盖，只是旧进度碰巧被合并保留。
- 触发条件或样本：`<PROJECT_ROOT>/测试用epub/` 中任意多本 EPUB；15.21 MiB 样本的 `Array.from` 本地同类基准增加约 140 MiB JS 堆，JSON 参数约 54.25 MiB。
- 根因：Tauri 存储把正文和封面从 `Uint8Array` 转为普通 `number[]`，再经 JSON IPC 反序列化成 `Vec<u8>`；原生拖放还用 `Promise.all` 一次读入全部文件，导入循环每成功一本就更新 React 书架并立即读回封面。旧重复 ID 仅由 identifier/文件名/大小的 32 位哈希构成，且判重发生在覆盖文件之后。
- 约束：浏览器与 Tauri 保持同一 `ShelfStore` 语义；Rust 继续独占目标路径生成；旧 ID 和书籍目录不能迁移；重复书不能修改文件、进度、首次添加时间或新书状态；内容不同的 EPUB 不应因同名同大小而覆盖。
- 选择的修复：以 EPUB 原始字节 SHA-256 作为新书 ID 和独立 `contentHash`；0.1.5 旧条目只对同大小候选懒读并补录指纹。导入改成逐本读取、指纹判重后才解析保存，批次结束后一次性合并书架。Tauri 文件输入使用 raw body，原生拖放直接复制来源路径，正文/封面先暂存再单次提交索引；存储层提交前再次按指纹拒绝重复。单本重复显示指定红色文案，批量最多展示两个截断书名并在更多时追加“等书”。
- 为什么这样修：内容指纹表达精确重复，不依赖不稳定文件名或不可靠 EPUB identifier；raw IPC/路径复制直接消除主导 CPU 和内存放大；前端预检与后端复检同时保证性能和存储幂等性。
- 未采用方案：继续沿用旧 ID 只能识别同名同大小文件且仍有 32 位碰撞；Base64 仍会扩大正文并增加编码 CPU；启动时扫描整个旧书架会把迁移成本转成每次启动卡顿；内容变化时自动覆盖旧书会混淆版本并带来进度迁移语义。
- 修改文件：`src/App.tsx`、`src/ui/shelf.ts`、`src/ui/importBooks.ts`、`src/ui/importBooks.test.ts`、`src-tauri/src/lib.rs`、协作文档。
- 验证：新增导入纯逻辑 8 项；全量 Vitest 15 文件 170/170、`pnpm build`、Rust 2/2 单测及 `cargo fmt --check` 通过。真实 Chromium 验证单本重复不增书、三本重复只列两个书名并追加“等书”、0.1.5 无指纹条目在改名重传后仍识别且进度不变。Windows WebView2/NSIS 包的绝对耗时仍需用户编译后复核。
- 剩余风险：原生路径从首次读取到 Rust 复制之间若源文件被同大小替换，当前只用长度防变化；这是极小时间窗，若真实出现再让 Rust 同步校验内容指纹。Android 不支持 Tauri raw body，本项目当前目标为 Windows 桌面。
- 关联：`docs/tasks/active/import-performance-duplicates-and-progress.md`、B-021。

## B-021：阅读进度异步写入没有最终顺序与退出保证

- 状态：已修复
- 发现日期：2026-08-17
- 现象：书架阅读进度可能保存失效，重新打开后回到旧章节或旧页；失败没有任何提示。
- 触发条件或样本：快速连续翻页后立即返回书架、刷新或关闭；新书第一次打开时还会同时触发 `markOpened` 与进度更新。
- 根因：每个 ready 状态都独立发起异步 `updateProgress`，没有串行化、同书最新值合并或退出前 flush，返回书架也不等待落盘，异常被静默吞掉。`markOpened` 完成后曾用整条旧返回记录替换 UI，可能覆盖较新的内存进度；Rust 多个变更命令还共用固定 `shelf.json.tmp`，没有写入互斥契约。
- 约束：翻页不能等待磁盘；最后稳定位置必须胜出；章节、页码、百分比、锚点和最近时间保持一致；第一次打开只允许清除 `isNew`；写入失败不能让窗口无提示地关闭。
- 选择的修复：新增单通道 `ShelfProgressWriter`，同一本书在写入进行中只保留最新待写位置，失败在 flush 时重试一次。每次翻页先乐观更新内存书架，再后台写入；返回书架、页面隐藏和 Tauri 关闭窗口时主动 flush。`markOpened` 只合并 `isNew:false`。Rust 所有索引变更通过同一个 `Mutex` 串行，继续用临时索引替换。
- 为什么这样修：写入队列让顺序成为显式契约，既不阻塞翻页也不允许旧请求晚到覆盖新位置；乐观内存更新解决“立即返回再打开”的窗口；退出 flush 覆盖最后一个尚未完成的请求。
- 未采用方案：只增加固定防抖会在窗口关闭前丢掉最后位置；每翻一页同步等待 Rust 会让输入卡顿；只依赖 localStorage 会让浏览器与 Tauri 书架进度继续分裂；仅显示错误而不串行化无法消除旧写覆盖。
- 修改文件：`src/App.tsx`、`src/ui/progressWriter.ts`、`src/ui/progressWriter.test.ts`、`src/ui/shelf.ts`、`src/ui/shelf.test.ts`、`src-tauri/src/lib.rs`、协作文档。
- 验证：进度写入器 3 项覆盖快速翻页合并、跨书顺序和失败重试；书架合并测试证明清除新书标记不覆盖页码/锚点。真实 Chromium 把多页样本读到第 5/11 页、第三章、55%，返回并刷新后仍恢复第 5/11 页；旧条目懒补指纹前后第 4 页、第三章、46% 完全不变。全量 Vitest 170/170、生产构建和 Rust 单测通过。
- 剩余风险：浏览器标签被操作系统强杀时无法等待异步 IndexedDB；正常返回、隐藏、刷新和 Tauri 窗口关闭已覆盖。Windows 安装包关闭事件仍需最终人工确认。
- 关联：`docs/tasks/active/import-performance-duplicates-and-progress.md`、B-020。

## B-022：目录页百分比 margin 被误叠加版心偏移导致翻页异常

- 状态：部分修复，已由 B-023 替代
- 发现日期：2026-08-18
- 现象：《试着向准备跳下去的同班同学提议「和我XX吧！」02》目录页被拆成两页，第二页只有 326px 的右边缘残片。
- 触发条件或样本：目录页末尾 `.ri.ti20er{margin-left:70%;margin-right:1.5em}` 的图片容器。
- 根因：C-16 已能识别 inline style 的水平百分比 margin，但该书百分比写在 `<link>` 样式表的类规则里，`hasPercentageHorizontalMargin(el.style)` 只查 inline style，未命中。于是 margin 修正把 70% 的 `margin-left` 当作“相对居中版心的缩进”，叠加 `base=(parentW-width)/2`，元素被推到 `x=1625`，溢出页宽并产生第二页残片。
- 约束：不改变书籍百分比 margin 的包含块语义；继续保留 C-04 对 em/px 缩进的解释；不能为书名/类名特判。
- 当时选择的修复：新增 `hasPercentageHorizontalMarginInRules(doc, el)`，扫描文档样式表（含 @media）中匹配元素的规则；在当时 WSL Chromium 中能使该书恢复一页。
- 为什么不足：该扫描只是对声明来源的推测，不能代表临时移除 L3 auto margin 后的最终获胜级联；不可读外链样式表还会使负结果不可靠。用户随后仍在实际环境复现两页，故不能继续记为完整修复。
- 未采用方案：仅按 computed px 阈值判断大 margin 会误伤未来以 em 表达的右侧定位；扫描书名类名不可维护；继续只查 inline 会复发。
- 修改文件：`src/render/paginator.ts`、`docs/BUGFIX_LOG.md`、`docs/SOURCE_DELTA.md`。
- 当时验证：全量 Vitest 16 文件 174/174、`pnpm build` 通过；一次 WSL Chromium 测量曾显示该书为 `第 1/1 页`。该证据不足以覆盖用户实际环境，最终验证见 B-023。
- 后续：B-023 改为最终级联的 CSS Typed OM 主路径，并保留安全回退和严格几何兜底。
- 关联：C-16、B-023、`docs/rendering-layers.md`。

## B-023：外链百分比 margin 的 CSSOM 推测在不同 WebView 中不稳定

- 状态：已修复，待用户审核
- 发现日期：2026-08-18
- 现象：`【测试专用】[赤月ヤモリ].试着向准备跳下去的同班同学提议「和我XX吧！」.02.epub` 的目录页仍可能从一页扩展为两页；末页是右侧内容残片。
- 触发条件或样本：目录最后的顶层 `.ri.ti20er`，作者外链 CSS 为 `margin-left:70%; margin-right:1.5em`，元素自身以 inline `width:6em` 定宽。
- 根因：B-022 的样式表扫描不等于最终级联。阅读器 L3 的 `reader-top` auto margin 正在生效时，传统 `getComputedStyle()` 已把作者百分比解析为 px；CSSOM 只能猜测某条匹配规则，外链样式表若不可读还无法给出可靠否定。因此 C-04 在某些环境仍把已相对包含块的左 margin 再加一次版心 `base`，导致越列。
- 约束：不按书名、类名或 `70%` 特判；普通 `margin-left:2em` 版心缩进、C-16 inline 百分比/`calc(...%)`、auto 居中和 C-18 对称 margin 均须保持；作者原位本就越列的布局不得被阅读器伪装成安全布局。
- 选择的修复：`applyBookMargins()` 先仅临时移除阅读器 `reader-top` 的 auto margin（不禁用整张 override sheet，L2 字号等仍稳定），再用 CSS Typed OM 读取最终获胜的 `margin-left/right` 指定值；`%` 和 `calc(...%...)` 直接走 C-16 的包含块原位分支。旧 WebView 无 Typed OM 时才回退 inline/CSSOM；每张 stylesheet 的 `cssRules` 单独捕获，任何不可读表都会把“未发现”保留为未知而不是 false。最终未知时，只有作者原位仍有明确余量、加 C-04 base 才越列、且不是 auto-like 余量，才保留原位。
- 为什么这样修：Typed OM 读取的是实际胜出的 CSS 值而非选择器猜测，能覆盖外链规则、简写和 `calc`；严格几何兜底只防止“阅读器额外 base 造成的新增越列”，不会把普通缩进、已分配的 auto 余量或作者本来就溢出的设计改写掉。
- 未采用方案：继续仅扫描 CSSOM 仍受可访问性和级联时序影响；按计算后的大 px margin 判断会误伤大 em 缩进；直接取消 C-04 会回归既有目录/标题布局；按书名或 `.ti20er` 特判不可维护。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/tasks/active/toc-percent-margin-resilience.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md`。
- 验证：新增分页器定向 12/12，覆盖 Typed OM `70%`/`calc(...%)`、不可读 stylesheet、普通 2em、赤月几何、原位越列和非对称 `right:auto` 已解析余量；全量 Vitest 16 文件 177/177、`tsc --noEmit`、Vite 生产构建通过。真实 Chromium：1280×800 时目录为 `第 1/1 页`，viewer `scrollWidth=1270`，目标 margin 为 `889px/24px`；900×650 时为 `第 1/1 页`，`scrollWidth=890`，目标 margin 为 `623px/24px`。
- 剩余风险：不支持 Typed OM 且样式表不可读的旧 WebView 只能依靠严格几何兜底；它故意不覆盖原位无余量、复杂负 margin 或作者本身越列的布局。当前 Windows 发布包仍需用户最终人工复验。
- 关联：C-16、B-012、B-022、`docs/tasks/active/toc-percent-margin-resilience.md`。

## B-024：C-18 的正对称 margin 豁免使目录 Contents 再次贴回版心左缘

- 状态：已修复，待用户审核
- 发现日期：2026-08-18
- 现象：`【测试专用】[relea][zhs][玩具堂]侦探年与敏锐的山田学 包夹我的双胞胎擅自展开推理[01].epub` 的目录页中，彩色 `Contents` 比下方目录条目的竖线明显偏左；同类现象曾在 0.1.2 出现并于 0.1.3 修复，本版回归。
- 触发条件或样本：`TOC.xhtml` 的顶层 `h3.ctt` 使用 `width:auto; max-width:40rem`（阅读器默认）和作者外链 CSS `font-size:2em; text-align:left; margin:1.3em .75em .5em`。1280×800 时当前版把标题放在 x=320，下方 `.toc` 左缘为 x=348；0.1.3 同书标题为 x=344。
- 根因：0.1.3 的 C-04 会把作者 `.75em` 水平 margin 映射为“正文版心左缘 + 24px”。0.1.5 为修复 fit-content 简介盒新增 C-18 后，只要计算后的左右 margin 为相等正值就直接保留 L3 auto 居中，范围超过了原始的 intrinsic-size 灰框，普通目录标题的显式缩进因此再次被吞掉。B-023 的百分比 margin 分支未参与本问题。
- 约束：禁止书名或 `.ctt` 特判；恢复普通 width:auto/固定宽度元素的 C-04 语义；C-18 的 fit/max-content 灰框仍须逐列居中；作者真正的 `margin:auto` 即使计算成 px 也不能被误判为显式对称 margin；B-023 的 70% margin 目录继续保持单页。
- 选择的修复：把“正对称 margin 保持居中”的判断收窄为元素具有 fit/max-content 原始意图（由分页器已有 `fitContentFixes` 和最终计算样式共同判定）。在此之前单独用包含块、border-box 宽度和两侧已解析余量判断真实 auto 居中：只有两侧余量相等且等于 `(parentWidth-width)/2` 才直接保留。其他普通元素即使左右显式 margin 相等，也继续由 C-04 相对正文版心写回。
- 为什么这样修：判据来自通用的 CSS 尺寸意图和实际几何，不依赖书名、标签或类名；它精确保留 C-18 原始目标，同时让 0.1.3 的目录标题行为恢复。auto 与显式相等数值分开判断，也避免固定宽度盒被错误归类。
- 未采用方案：重新取消全部对称 margin 豁免会让 C-18 简介盒错位；按 `.ctt` 或当前书特判不可维护；用 `text-align:left` 区分会误伤大量左对齐但应居中的信息框；把所有相等 margin 当 auto 无法区别作者显式 `margin:1em`。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/tasks/active/toc-symmetric-margin-regression.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md`、`docs/PROJECT_CONTEXT.md`。
- 验证：新增 2 项分页 margin 决策回归，先在旧实现下失败；修复后 paginator 14/14、全量 Vitest 16 文件 179/179、`tsc --noEmit`、Vite 生产构建通过。真实 Chromium 1280×800 中标题从 x=320 恢复为与 0.1.3 完全一致的 x=344（书 margin 写回 339px/291px），目录仍为 1/1 页；900×650 为 x=154、1/1 页。C-18 简介盒在 1280×800、900×650 和 20px 字号下所有跨列碎片仍逐列居中且无 margin 写回。B-023 赤月目录 1280×800 仍为 1/1 页、目标 margin 889px/24px、viewer `scrollWidth=1270`。
- 剩余风险：Windows WebView2 发布包尚需用户人工确认；未来若出现非 fit/max-content 但确实希望把显式正对称 margin 仅解释为无方向双侧留白的实书，应依据该书的尺寸/几何语义扩展通用判据，不能重新扩大为“所有相等值”。
- 关联：C-04、C-18、C-24、B-014、B-023、`docs/tasks/active/toc-symmetric-margin-regression.md`。

## B-025：目录可见行内色块被尾随全角空白推过行尾

- 状态：已修复，待用户审核
- 发现日期：2026-08-18
- 现象：`【测试专用】[すめらぎひよこ].世界啊臣服于吾之火焰.01.试着把魔王城点了.epub` 的 `TOC.xhtml` 中目录色块整体错位、部分色块越过目录段落右缘；窄视口时末尾“后记”落到下一列，旧状态还可能显示为单页而无法到达。
- 触发条件或样本：顶层 `.ctit` 右对齐段落中的可见 inline 盒，盒文本尾部含 U+3000/NBSP（可混合普通空格），并有背景、边框或水平 padding。Chromium 1280×800 下父段落右缘为 960px，色块右缘达到 997/1013/1077/1125/1141/1205px；清除父段落 `text-indent` 单独无效。
- 根因：Chromium 在 right/end 对齐行中把手工补齐的不可折叠空白作为 inline 盒外的 hanging whitespace，导致带视觉背景的 inline 盒 `getBoundingClientRect()` 越过其最近块包含段落的 inline-end；多栏分页随后把残余几何扩展成额外列。这是 L5 行内盒测量问题，不是 C-04/C-18 顶层 margin 决策。
- 约束：不得按书名、`.ctit`/`.tbox` 类名或文本特判；普通行内文字、无视觉盒、非 computed-right 对齐、未越界以及行内链接、ruby、脚注语义不能改变；原子化后仍越界或宽度超过包含块必须恢复原值；重排、字号重载、换章和销毁不能留下临时 inline 写回。
- 选择的修复：在分页器测量最后增加通用几何门控：只筛 computed `display:inline`、尾部至少含 U+3000/NBSP（允许其后混合普通空格）、具有可见背景/边框/水平 padding、最近块为物理 `text-align:right` 且真实越过 inline-end 的元素。逻辑 `text-align:end` 暂不命中，因为未结合 direction 不能安全解释 RTL。临时以 `display:inline-block!important`、`text-indent:0!important` 原子化并强制回流；仅当新右缘回到包含块内且新宽度不超过包含块才登记写回，否则立即恢复。保存并恢复原始 inline 值及 priority，并在恢复时移除 per-measure 标记；遍历时先检查尾随空白再取 computed style；跳过元素自身为链接/ruby/脚注语义节点及其 ruby/sup/脚注祖先。
- 为什么这样修：它直接修复浏览器产生越界的行内盒几何，保留作者可见盒尺寸和右对齐语义；只作用于有明确手工补齐空白与视觉外观的真实越界，不扩大到普通正文。用“写回后再次验证”的事务式门控，避免 inline-block 在其他书中继续撑宽或越列。
- 未采用方案：清除所有 `text-indent` 只改变段落首行，实测不能消除色块越界；统一把所有 span/a 改为 inline-block 会破坏行内链接、ruby 和脚注；按 `.ctit`/`.tbox` 或书名特判不可维护；直接取消多栏或改写作者空白会改变正文语义。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/tasks/active/toc-inline-box-overflow.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md`、`docs/PROJECT_CONTEXT.md`。
- 验证：分页器定向 19/19；全量 Vitest 16 文件 184/184；`tsc --noEmit`、Vite build 通过。真实 Chromium：目标书 1280×800 所有越界色块右缘回到 960px、宽 249px、目录 1/1；900×650 当前列右缘回到 770px，状态变为可达的 1/2，键盘下一页后显示 2/2，最后“后记”位于第 2 列且已原子化；resize 后标记可恢复并重新写入。B-023 赤月仍 1/1、margin 889/24px；B-024 侦探少年 Contents 左缘 344px、目录 1/1。
- 剩余风险：Windows WebView2 发布包仍需用户人工确认；不支持现代 CSS 几何行为的旧 WebView 可能有不同 inline fragmentation，但门控失败会恢复原值，不会留下半修复状态。一次性 Chromium 脚本和测试书不属于同步内容。
- 关联：C-25、C-04、C-18、B-023、B-024、`docs/tasks/active/toc-inline-box-overflow.md`。

## B-026：书内目录/链接跳转无法撤销

- 状态：已修复，待用户审核
- 发现日期：2026-08-18
- 现象：从目标书第 9 章目录点击 iframe 内第一章链接后，阅读器历史返回按钮仍禁用；同章纯 `#fragment` 跳转也不会进入历史。
- 根因：`ReaderView` 创建 `ChapterPaginator` 的 effect 只依赖 `[book, server]`，构造器回调捕获首次 render 的旧 `onInternalLink`，首次闭包通常仍处于 loading 阶段。纯 fragment 则在 paginator 内直接同步 hash 和定位，没有通知 App。
- 约束：有效普通内部链接和存在目标的 fragment 每次只记录一条跳转前快照，最多保留 10 步；目录、书签不能与 paginator 通知重复入栈；外链、脚注、无效跨章 href 和缺失 fragment 目标不得进入阅读位置历史；回退须恢复章节、页码和内容锚点。
- 选择的修复：App 抽取 `captureReaderHistory(href)` 与只执行 href 的 `navigateReaderHref()`；capture 先以 book/spine 校验跨章目标，目录/书签先捕获再执行。Paginator 普通内部链接先以解析后的 href 调用 `onBeforeInternalNavigate` 再调用路由；fragment 只有目标存在且可 jump 时才通知，缺失目标仍可同步 hash。ReaderView 通过 latest ref 转发两个长生命周期回调，避免旧闭包。
- 为什么这样修：历史快照的责任集中在 App，Paginator 只报告“即将改变阅读位置”，保留分页器对 fragment 的原地定位语义，同时让跨章/同章跳转共享同一撤销链；外链和脚注仍保持各自弹层/系统打开语义。
- 未采用方案：让 paginator 直接维护 UI 历史会复制章节状态并破坏单向编排；把 fragment 强制重载为新章会造成闪现且失去原地 `:target` 行为；仅扩大 effect 依赖会频繁重建 paginator、清空章节生命周期状态。
- 修改文件：`src/App.tsx`、`src/ui/ReaderView.tsx`、`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/MODULE_CONTRACTS.md`、`docs/BUGFIX_LOG.md`、`docs/tasks/active/reader-history-internal-links.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md`、`docs/PROJECT_CONTEXT.md`。
- 验证：Paginator 定向 20/20；全量 Vitest 16 文件 185/185；`tsc --noEmit`、Vite build 通过。真实 Chromium：目标书第 9 章目录 → iframe 第一章链接后撤销按钮启用，点击后恢复第 9 章且按钮禁用；选择器测试书同章 fragment 跳转后按钮启用，撤销恢复原页且按钮禁用；无效跨章 href 与缺失 fragment 均保持按钮禁用；单次跨章跳转撤销后无残留第二条历史。
- 剩余风险：Windows WebView2 发布包仍需用户人工确认；书籍内部链接目标是否符合作者预期仍由 EPUB 解析结果决定，当前只保证无效目标不污染撤销历史。
- 关联：`docs/MODULE_CONTRACTS.md`、`docs/tasks/active/reader-history-internal-links.md`、阅读跳转历史和书签任务。

## B-027：自定义 CSS 每字符重载与浅色主题 bgcolor 层级

- 状态：已修复，待用户审核
- 发现日期：2026-08-18
- 现象：自定义 CSS textarea 每输入一个字符都会触发 App 提交和章节重载，造成不必要的分页/CPU 开销；旧实现把浅色书籍 `body bgcolor` 作为位于用户 CSS 之后的 `!important` 规则，压过用户背景，且背景图层级容易被误伤。
- 触发条件或样本：菜单详细设置中的自定义 CSS；含 `<body bgcolor="#8ac9e8">` 的章节，使用普通 `body { background-color:#123456; background-image:... }` 用户 CSS 的合成回归。
- 根因：textarea 直接调用父级 `onCustomCssChange`，每次受控变化都进入 sanitize/reload；旧 sanitize 将安全 `bgcolor` 追加成独立且位于 userCss 之后的 `!important` 规则，必然压住普通用户 CSS；主题若使用 `background` 简写会清掉书籍背景图。
- 约束：保存必须是明确动作，支持清空；父值外部变化须同步草稿；只接受安全颜色；浅色才使用书籍 bgcolor，深色/纸色保持主题；用户 CSS 在同一 override style 最后；不改变背景图；不得实现未设计的多 CSS 预设。
- 选择的修复：MenuPanel 保存本地 draft，只有“保存并应用”且内容变化时调用回调。sanitize 安全解析 bgcolor，浅色把它作为主题 body 的 `background-color` 默认值写入同一 override style，读取后移除 legacy 属性以消费重复来源；用户 CSS 保持末尾，且只写 background-color 不重置 background-image。
- 为什么这样修：提交边界从每字符变为显式保存，避免重载风暴并保留清空语义；同一 style 的自然级联让普通用户规则覆盖浅色默认值，同时不需要全局 `!important`；移除的仅是已消费的 legacy 背景色提示，书籍其余样式和背景图仍保留。
- 未采用方案：debounce 仍会在编辑时重载且关闭时机不明确；blur 自动保存不可发现；追加 bgcolor `!important` 会阻止用户 CSS；使用 `background` 简写会清除背景图；多个 CSS 预设留待 schema/UI CRUD/旧值迁移设计。
- 修改文件：`src/ui/MenuPanel.tsx`、`src/ui/menuPanel.test.ts`、`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、任务与契约文档。
- 验证：全量 Vitest 17 个文件 186/186，`tsc --noEmit`、Vite build 通过。真实 Chromium 连续输入 5 字符期间 iframe load=0，保存一次 load+1，清空保存再次 load+1；无强制作者规则的测试章节浅色 computed 背景为 `rgb(18,52,86)`且背景图保留，深色/纸色清空后分别为 `rgb(30,30,30)`/`rgb(244,236,216)`。
- 剩余风险：作者 CSS 自己声明 `background-color: !important` 时仍按 CSS 优先级胜出，这是有意保留的书籍规则语义；Windows WebView2/安装包仍待用户确认。
- 关联：C-01、`docs/tasks/active/custom-css-commit-and-theme-bgcolor.md`。

## B-028：工具栏窄窗口标题侵入控件

- 状态：已修复，待用户审核
- 发现日期：2026-08-18
- 现象：工具栏使用 `1fr minmax(0,42%) 1fr` 时，窗口变窄后左侧按钮实际内容超过分配列；由于左右容器允许溢出，按钮会侵入标题区域。标题两行布局在窄屏也不能显示标准省略号。
- 触发条件或样本：阅读器工具栏，1080×760 与 640×480，UI scale 1 与 1.3；长书名和短书名均检查。
- 根因：左右 grid track 是可被压缩的 `1fr`，而按钮组有不可压缩的实际内容宽度；标题列固定占 42% 并不能代表剩余空间。单纯使用不对称 `max-content` 侧轨又会让可完整显示的标题偏离窗口中心。
- 约束：左右功能按钮不得隐藏或裁切；标题不得与按钮重叠；宽屏保留两行；窄屏变为单行省略；字号继续使用 `clamp(9px,1.05vw,13px)` 且不低于 9px；不改变正文标题或 EPUB CSS。
- 选择的修复：Toolbar 用 `ResizeObserver` 测量左右控件的实际 layout `scrollWidth`，取最大值写入对称 `--toolbar-side-width`，宽屏使用对称侧轨和可收缩中间轨；720px 以下切回不对称 `max-content minmax(0,1fr) max-content`，让按钮在 ellipsis 模式下完整留在视口内。标题同时切换为 block、nowrap、hidden、ellipsis，保留 `title` 属性查看完整标题。
- 为什么这样修：布局约束直接来自控件真实宽度，不依赖按钮数量或书名；宽屏两侧取相同最大宽度使标题中心稳定，窄屏放弃不必要的居中要求换取按钮完整可用，只有标题可收缩且省略行为符合 CSS 标准。
- 未采用方案：继续使用三列 `1fr` 会在不同 UI scale 下复发；全局缩小或隐藏按钮损害可用性；修改 EPUB 正文标题与本 UI 问题无关；按某一本书名设置断点不可维护。
- 修改文件：`src/ui/Toolbar.tsx`、`src/styles.css`、`docs/MODULE_CONTRACTS.md`、`docs/BUGFIX_LOG.md`、`docs/tasks/active/toolbar-narrow-layout.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/SOURCE_DELTA.md`、`docs/PROJECT_CONTEXT.md`。
- 验证：Chromium 1080×760 宽屏标题中心与 toolbar 中心差 0px（scale 1/1.3），书架“EPUB 阅读器”中心差 0px；640×480 窄屏与 UI scale 1/1.3 均无控件-标题矩形交叠且按钮可见，computed `nowrap`/`ellipsis`/9px，合成超长标题分别为 `439 > 315`、`472 > 171`。全量测试、tsc、Vite build 见任务收尾记录。
- 剩余风险：极端窄于所有功能按钮总宽时 toolbar 可能需要水平空间，但不会用隐藏/裁切制造假可用性；Windows WebView2 仍需用户最终确认。
- 关联：`docs/tasks/active/toolbar-narrow-layout.md`、UI 工具栏契约。

## B-029：CSS 注释内容参与资源与尺寸改写

- 状态：代码、自动化回归与 Chromium 端到端已完成，待用户审核/同步
- 发现日期：2026-08-18
- 现象：CSS 注释中的可读 `@import`、`url()`、`width` 或 `float` 文本会被正则扫描；可读注释 import 甚至可能泄漏导入 CSS 为有效规则，注释关键词还会误导 sanitize 的祖先定宽/纯图片判断和 paginator 的 float guard。引号字符串中的 `/*...*/` 不应被视为注释。
- 根因：`cssRewrite.ts` 的 import/url/width pass 直接扫描原文，递归导入又会在子调用中恢复注释后重新暴露给父级；sanitize/paginator 的若干来源启发式也直接对 style 文本使用正则。
- 约束：只识别 normal state 的 CSS block comment；引号内 `/*`、反斜杠转义和未闭合注释必须保持字符串/注释语义；注释原文逐字保留；注释内 import 不读取、不生成活动 URL；不改变 CSSOM/Typed OM 与 userCss 注入。
- 选择的修复：新增 quote-aware comment protector，根调用与递归 `@import` 共享 token context，统一在根返回前恢复；资源与 width 扫描只作用于保护文本，inline style 使用同一边界的专用 width helper；sanitize 的 authored width/size 和 paginator float guard 统一使用去注释来源判断。
- 未采用方案：不引入完整 CSS parser；不修改浏览器 CSSOM、Typed OM 或自定义 CSS 注入，以免改变作者/用户 CSS 级联和性能边界。
- 修改文件：`src/render/cssRewrite.ts`、`src/render/cssRewrite.test.ts`、`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/tasks/active/css-comment-boundaries.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md`、`docs/PROJECT_CONTEXT.md`。
- 验证：定向 96/96；全量 Vitest 17 文件 197/197；`tsc --noEmit`、Vite build 通过。WSL Chromium sanitize 外链 CSS 端到端验证 `hiddenReads=0`，重写 CSS 逐字保留 `/* @import "hidden.css"; */`，活动 `.real` 背景 URL 为 `blob:test/OEBPS/Styles/active.png`，CSSOM 仅保留 `.real`，hidden 为 `rgb(0,0,0)`，real 为 `rgb(0,0,255)`。自动化覆盖注释 import 不读取/不泄漏、递归注释、未闭合注释、quoted URL、占位符碰撞、width/float/sanitize 边界；剩余为现有测试书普通回归与 Windows WebView2/安装包确认。
- 剩余风险：保护器是有限 CSS 文本扫描器，不替代完整 parser；极端非法 CSS 仍以浏览器解析为准。Windows WebView2 仍待用户确认。
- 关联：`rendering-layers.md` C-27、`docs/tasks/active/css-comment-boundaries.md`、CSS rewrite/sanitize/paginator 契约。

## B-030：末尾媒体浮动装饰跨列拆分

- 状态：代码、自动化回归与 WSL Chromium 实书验证已完成，待用户审核/同步
- 发现日期：2026-08-18
- 现象：`【测试专用】[七菜なな].男女之间存在纯友情吗？（不，不存在！）.03.epub` 的 `contents.xhtml` 在 900×650 下末尾 `.fr` 浮动纯图片装饰被拆到下一列，产生错误第二页；title.xhtml 的整页 wrapper 差异本轮仅诊断，未修改。
- 根因：跨列元素的 `getBoundingClientRect().bottom` 是碎片 union，约等于 content bottom，不能代表未分片内容底部；目标 `.fr` 首列 top 约 476px、scrollHeight 约 187px，实际未分片底部约 663px，溢出约 134px。候选子图的负 margin 还可能使后代视觉 rect 比浮动根节点更靠左，单看根节点会漏掉越界/碰撞。
- 约束：不得按书名、类名或文本特判；仅处理 viewer 最后一个直接子元素、static/relative 的 left/right float、递归媒体-only 子树；普通文字 float、非媒体子树、已有单列或安全布局必须不写回；重排和销毁必须恢复临时 inline 值及 priority。
- 选择的修复：分页器在 float 宽度收缩后、最终 extent 前，以首个内容列碎片 top + 正 `scrollHeight` 估算未分片底部；临时写入 `margin-top = computed margin-top - overflow - 1px`，强制回流后要求候选自身合为单列、候选及后代所有视觉 rect 在该列内容区内、底部不越 content bottom、且不与此前顶层兄弟及后代实质交叠。列坐标考虑 `viewer.scrollLeft`；门控失败事务式恢复，measure/dispose 都恢复成功写回。
- 为什么这样修：它针对 Chromium 多栏对末尾纯媒体 float 的具体 fragmentation 测量错误，保留媒体相对目录的自然位置，并把子图的真实视觉边界纳入安全检查；递归媒体判断和几何门控均为通用条件，不引入书籍特判。
- 未采用方案：用 union rect bottom 判断会漏掉目标溢出；只检查 `.fr` 自身会漏掉负 margin 子图；把所有末尾 float 上移会破坏普通文字/非媒体设计；修改 title wrapper 或强制整章减高超出本 Bug 范围。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md`、`docs/tasks/active/trailing-media-float-overflow.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/SOURCE_DELTA.md`、`docs/PROJECT_CONTEXT.md`。
- 验证：分页器定向 23/23；全量 Vitest 17 文件 199/199；`tsc --noEmit`、Vite build 通过。真实 Chromium 目标书 900×650 为 1/1，`.fr` margin-top `-134.647px`；1280×800 为 1/1 且 margin-top `0px`；640×480 为 1/2，剩余跨列来自目录主体本身。B-019、B-023、B-024、Sumeragi 900×650 实书回归均为 1/1，未见分页异常。
- 剩余风险：640px 极窄视口的目录主体仍可自然跨两列；Windows WebView2 发布包仍待用户确认。title.xhtml whole-page wrapper 仅记录为诊断结果，若需改变应另行评估。
- 关联：`rendering-layers.md` C-30、`docs/tasks/active/trailing-media-float-overflow.md`、C-08、C-23。

## B-031：100 本以上书库复制正文并全量刷新导致高资源占用

- 状态：实现与自动化验收完成，待 Windows 发布包性能验证
- 发现日期：2026-08-20
- 现象：Windows 发布版导入大量 EPUB 时显著慢于 WSL 预览，CPU 与内存占用偏高；书库超过 100 本后，启动、批量导入和书架刷新成本继续随正文总量及卡片数量放大。用户书库可能达到十几 GB，复制每本正文还会造成应用数据目录持续膨胀。
- 根因：旧桌面书库把 EPUB 正文和封面复制到应用目录；批量导入仍需把大块字节送入 WebView/解析链，书架卡片又会在导入状态和全局时钟变化时重复渲染，并可能为离屏卡片读取/解码封面。可同步进度、设备路径、正文副本和封面缓存没有清晰分层。
- 约束：桌面版不得复制或删除用户源 EPUB；精确重复仍按完整字节 SHA-256；改名/重新导入不得丢进度；存档可跨平台但绝对路径不得同步；源文件缺失必须保留记录并可安全重新定位；旧测试书库无需迁移。
- 选择的修复：新增 Rust 链接书库，将 `LibraryRecord`、`DeviceBinding` 与 Thumbnail 分层；批量路径导入在 Rust 侧流式哈希并只读取受限 container/OPF/加密/封面定位元数据，整批集中提交索引和 UI。启动先 stat，只有签名变化才重哈希；打开和重新定位再次验证内容身份。书架卡片 memo 化，离屏布局使用 `content-visibility`，封面只在接近视口时经四并发队列派生最大 240×360 缩略图，设备 LRU 上限 100 MiB，并在启动清理索引外孤立文件/临时文件。新增不含路径的 v1 存档与缺失源文件重新定位流程；每本书首次稳定进度立即写，后续 750 ms 合并并在生命周期边界 flush。
- 为什么这样修：书库总容量不再转化为应用数据正文副本，启动成本主要是记录读取与文件 stat，滚动封面成本由接近视口的卡片决定；同时保留内容哈希身份，跨平台同步只需传递小型状态存档。
- 未采用方案：继续复制正文即使分批也无法解决十几 GB 双份占用；每次直接从 EPUB 解码原封面会让滚动与重启持续支付 ZIP/大图解码成本；只保存源路径而没有内容哈希会把旧进度误套到被替换文件；本轮不引入云同步，也不为单个 10GB EPUB 改造随机访问解析器。
- 修改文件：`src-tauri/src/linked_library.rs`、`src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/capabilities/default.json`、`src/App.tsx`、`src/ui/shelf.ts`、`src/ui/ShelfView.tsx`、`src/ui/progressWriter.ts`、`src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts`、`src/ui/thumbnail.ts`、对应测试、`src/styles.css`、`package.json`、`pnpm-lock.yaml` 及交接文档。
- 验证：`pnpm test` 21 文件 218/218；`pnpm build`（TypeScript/Vite）通过；`cargo fmt --check`、`cargo check --quiet` 通过；Rust 9/9。自动化覆盖桌面命令契约、存档路径泄漏拒绝/合并、每本书首次进度立即提交及在途更新不丢失、缩略图尺寸/并发/取消与孤立缓存文件识别、哈希与记录校验。旧 WSL/Windows `dev.epubreader.app` 缓存目标均不存在，无内容需要删除。
- 剩余风险：仍需 Windows 发布构建用 100+ 本和数 GB 书库记录实际导入、重启、滚动、内存与 CPU；Tauri 系统文件选择/拖放、存档读写、重新定位和卸载行为也需人工确认。单本打开仍由现有前端解析器完整读取，不承诺单个超大 EPUB 的随机访问。两份 JSON 只能分别原子替换；极窄崩溃窗口下绑定会保守失效为 unavailable，记录可由存档恢复。
- 关联：`docs/tasks/active/linked-library-refactor.md`、存储契约、B-020、B-021。

## B-032：桌面应用可被重复启动

- 状态：代码与 Rust 回归完成，待 Windows 桌面实机确认
- 发现日期：2026-08-20
- 现象：用户在桌面版已经运行时再次启动应用，系统可能创建第二个独立进程和窗口；已最小化的原窗口也不会自动回到前台。
- 触发条件：Windows 安装包或 Tauri 桌面开发版运行期间，再次从可执行文件/快捷方式启动。
- 根因：Tauri builder 没有注册进程间单实例协调；前端浏览器状态无法可靠承担桌面进程互斥。
- 约束：保持 Tauri 2；浏览器 `pnpm dev` 多标签页开发不受影响；第二个进程不得触碰书库或进度；恢复已有窗口不能因窗口暂时缺失或单步平台调用失败而 panic。
- 选择的修复：使用官方 `tauri-plugin-single-instance`，仅为 desktop target 引入，并作为 builder 的第一个插件注册。插件关闭第二实例时回调已有实例，按 `show`、`unminimize`、`set_focus` 顺序尽力恢复 `main` 窗口，单步错误均忽略。
- 为什么这样修：官方插件在桌面平台提供进程间协调，早于其他插件初始化可避免启动期干扰；窗口恢复属于 Rust 外壳，既不污染浏览器开发路径，也不需要前端自制锁。
- 未采用方案：不使用 localStorage/IndexedDB 锁，因为它不能阻止独立桌面进程；不自行编写命名 mutex/IPC，因为会重复跨平台插件已经处理的生命周期与平台细节；不让第二实例转发参数或深链接，本任务未定义参数路由语义。
- 修改文件：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/src/lib.rs`、`docs/tasks/active/desktop-single-instance.md`、`docs/tasks/active/README.md`、`docs/MODULE_CONTRACTS.md`、`docs/SOURCE_DELTA.md`、本文。
- 验证：`cargo fmt --check`、`cargo test`、`cargo check` 通过；Rust 回归固定恢复顺序。Windows 双启动（普通、原窗口最小化）仍需用户在 Tauri dev 或发布包人工确认。
- 剩余风险：Linux Snap/Flatpak 需要额外 DBus manifest 配置才可用；项目当前发布目标是 Windows NSIS。Windows 的前台激活策略由系统控制，`set_focus` 只能尽力请求焦点。
- 关联：官方 Tauri Single Instance 插件、`docs/tasks/active/desktop-single-instance.md`、桌面外壳契约。

## B-033：阅读跳转历史首次漏记与恢复位置不稳定

- 状态：代码与自动化回归完成，待用户审核
- 发现日期：2026-08-20
- 现象：首次打开后立即执行目录/书内链接跳转时，ready state 仍可能停留在 React 闭包旧值，导致第一条历史漏记；原实现只有 10 条后退历史，后退后无法前进；初始锚点恢复后旧页码还可能覆盖锚点定位。长书连续翻页时，若取整后的进度百分比未变，书架进度也可能不触发更新。
- 根因：分页器 ready 与 display gate 解除之间，App 的异步 `chapterState` 尚未完成 render；历史仅有单向数组；页码与内容锚点由两个独立入口同时恢复；书架写入副作用只间接依赖整数 `progressPct`；Toolbar 保留了书架态的旧侧轨宽度，新增的嵌套胶囊又可被 flex 收缩，因而会被相邻按钮覆盖点击区。
- 选择的修复：新增纯 TS 三项上限 back/forward 状态机；App 增加同步 chapter state/ref、稳定位置基线与每个稳定位置单次捕获门，初始加载期目录跳转也可以已保存基线入栈；ReaderView 转发 paginator 最终 display-ready，同章 fragment 则在同步定位后另行通知 settled；所有换章/显式导航在门控期间禁止进度写入；写入触发包含实际 `chapterState`；有 anchor 时不再套用 page fallback；Toolbar 以子控件的 intrinsic scroll width 重测侧轨，胶囊禁止 flex 收缩。
- 修改文件：`src/ui/readerNavigationHistory.ts`、`src/ui/readerNavigationHistory.test.ts`、`src/App.tsx`、`src/ui/ReaderView.tsx`、`src/render/paginator.ts`、`src/render/paginator.test.ts`、`src/ui/Toolbar.tsx`、`src/styles.css`、本任务文件及契约/交接文档。
- 验证：历史/paginator/progress writer 定向 31/31；全量 Vitest 22 文件 221/221；`tsc --noEmit` 与 Vite 生产构建通过。WSL Chromium 确认初始 ready 前目录跳转入栈、连续两次 fragment 后一次后退仍可再后退、前进可用，且胶囊含 2 个可点击按钮。Windows WebView2 人工确认待用户执行。
- 关联：`docs/tasks/active/reader-navigation-history-forward.md`、UI 稳定 display-ready 契约。

## B-034：目录顶层 float 逃逸 40rem 版心

- 状态：代码与自动化回归完成，待用户审核
- 发现日期：2026-08-20
- 现象：目标书 `contents.xhtml` 末尾直接子 `.fr` 的 computed `float:right` 在宽视口贴窗口右缘；1280 viewer 为 x=1200..1280、900 viewer 为 x=820..900，未落在居中的 40rem 版心右缘。
- 触发条件或样本：`【测试专用】[七菜なな].男女之间存在纯友情吗？（不，不存在！）.03` 的目录页；该元素作者水平 margin 为 0、宽约 80px。640px 以下窄容器的自然布局与第二页不是本 Bug 目标。
- 根因：L3 `.reader-top` auto margin 在顶层 float 上不能提供预期版心内缩，Chromium 将无作者 margin 的 float 贴到全宽 viewer 物理边缘；原 `applyBookMargins` 没有该类安全分支。
- 约束：只处理 viewer 直接 `reader-top`、computed `left/right` float、非全页类、宽度不超过 40rem 且作者无 meaningful 水平 margin 的元素；作者明确全宽/突破版心意图、全页布局和过宽盒保守跳过；不得按书名或 `.fr` 特判；不改 B-030 垂直补偿。
- 选择的修复：新增 DOM-independent 的 `getReaderTopFloatContainmentMargins` 门控；宽容器给 float 物理侧写入 `max(0,(parentWidth-min(parentWidth,40rem))/2)`，另一侧为 0，窄容器写入 0/0。`applyBookMargins` 在百分比、fit-content/max-content 分支之后调用它，并通过现有 `marginFixes` 保存和恢复 inline 值及 priority；仅对 author stylesheet 中明确的 `width/min-width:100%` 或 viewport-relative 表达式保守跳过，排除 reader 注入 stylesheet，未知条件不推断。
- 为什么这样修：它直接复用现有 reader-top 两阶段级联测量与 margin 生命周期，只改变确认逃逸的页面级 float；不重写书籍 DOM，也不会把普通嵌套 float 或明确出血设计拉回版心。
- 未采用方案：不全局覆盖 float 或强制所有顶层元素 40rem；不按 `.fr`/书名特判；不改变 title.xhtml whole-page wrapper；不修改 C-30 的垂直 margin-top 补偿。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md`、`docs/tasks/active/toc-top-float-containment.md`、`docs/tasks/active/README.md`、`docs/tasks/active/version-0.1.6-development.md`、`docs/SOURCE_DELTA.md`、`docs/PROJECT_CONTEXT.md`。
- 验证：paginator 定向 28/28；全量 Vitest 22 文件 226/226；`tsc --noEmit` 与 Vite build 通过。目标书 Chromium：1280、900 均为 1/1，目录图片分别收回约 x=864..952、674..762；640 保持自然 2 页且第 2 页图片位于可见范围。玩具堂 1280/900 标题左缘仍为 344px/154px，赤月 70% margin 仍为 1/1，すめらぎ resize 前后内联盒均未越界。
- 剩余风险：作者全宽意图扫描是有限 CSSOM/文本启发式；Windows WebView2 仍待最终确认。
- 关联：`rendering-layers.md` C-31、`docs/tasks/active/toc-top-float-containment.md`、C-04、C-30。

## B-035：图片脚注弹层泄漏注释序号

- 状态：代码与自动化回归完成，待用户审核
- 发现日期：2026-08-20
- 现象：`[简][初鹿野創].有谁规定了在现实中不能有恋爱喜剧的？.03.epub` 的 `Postscript.xhtml` 中，点击图片脚注后，弹层除了注释图片和文字，还显示了 `019`/`020` 等注释序号。
- 触发条件或样本：`aside > a > ol.duokan-footnote-content > li.duokan-footnote-item[value="019"]` 的多看图片脚注结构；正文 iframe 内序号被书籍 CSS 隐藏，但弹层属于宿主 UI。
- 根因：`resolveFootnote()` 为图片注释复制整个 `aside.innerHTML` 到 `FootnotePop`。复制后的富 HTML 离开书籍 iframe，不再继承书籍 `aside ol { list-style:none !important; }`；宿主 `.footnote-html ol` 只设置了 `padding-left:20px`，浏览器遂按 `<li value="019">` 生成默认有序列表 marker。
- 约束：不改变脚注识别、正文 DOM 或 `footnotes.ts` 的 HTML 结构；只修复宿主弹层的展示语义；普通脚注中的作者有序/无序列表仍保留编号；图片应回到卡片内容边缘，不能继续为隐藏的 marker 留负缩进。
- 选择的修复：在宿主 CSS 中仅匹配 `.footnote-html ol.duokan-footnote-content` 及其直接 `li`，隐藏列表 marker 并将该列表 `padding-left` 置零；仅对该结构直接 `li > div > img` 的图片容器覆盖原有 `margin-left:-20px`，嵌套作者列表与普通列表保持原有编号和图片缩进。
- 为什么这样修：问题来源是书籍 CSS 语义跨 iframe 到 UI 弹层时丢失，结构类名是稳定的多看脚注契约；定向宿主 CSS 能覆盖当前和同类 EPUB，不会用书名/注释编号特判，也不会破坏普通列表。
- 未采用方案：不在 `resolveFootnote()` 中删除 `<ol>/<li>` 或 unwrap DOM，避免破坏注释内链接和排版；不全局隐藏 `.footnote-html ol`，避免误伤真正的有序列表；不修改书籍 iframe CSS，因为正文中原样式已经正确。
- 修改文件：`src/styles.css`、`src/ui/footnoteStyles.test.ts`、`docs/tasks/active/footnote-rich-content-marker.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md`、`docs/PROJECT_CONTEXT.md`、`docs/HANDOFF.md`。
- 验证：脚注 CSS 契约 2/2；定向脚注/样式/消毒/分页 91/91；全量 Vitest 23 个文件 228/228；`tsc --noEmit`、Vite production build 通过。WSL Chromium 实际点击目标书两个图片脚注：`019`/`020` 的 computed `list-style-type:none`、padding `0px`，图片、列表项和弹层内容左缘一致；Windows WebView2 待人工确认。
- 剩余风险：宿主 CSS 仅覆盖带 `.duokan-footnote-content` 类的多看列表；其他厂商使用不同 class 且同样依赖 iframe 内 `list-style:none` 的结构，需以后续样本按同一原则扩展。
- 关联：`rendering-layers.md` C-32、`docs/tasks/active/footnote-rich-content-marker.md`、脚注解析与 UI 弹层契约。

## B-036：阅读会话与章节 CSS Blob URL 生命周期

- 状态：代码与自动化回归完成，待用户审核
- 发现日期：2026-08-20
- 现象：章节消毒为外链 CSS 创建的 Blob URL 没有明确的本次加载所有权；换章、消毒失败或旧章节异步任务过期时可能遗留 URL。返回书架时 ReaderView 也没有在 paginator 销毁后统一结束 ResourceServer 会话。
- 触发条件或样本：连续换章、快速覆盖 `loadSeq`、sanitize 抛错、ReaderView dispose 或返回书架；不要求特定 EPUB。
- 根因：`sanitizeChapter` 的 `makeUrl` 只负责创建 URL，分页器没有登记局部集合；书籍共享图片/字体 URL 与章节 CSS URL 的生命周期未分层。`measure()` 在字体等待和双 rAF 后也缺少 document/viewer 身份校验。
- 约束：普通换章不得 revoke 整本书共享资源；必须先 dispose paginator 再撤销 ResourceServer；失败/过期/dispose 清理必须幂等；保持 VisibilityGate、B-002 代次与最多两次自愈。
- 选择的修复：新增 `OwnedBlobUrls` 管理每次 sanitize/load 的 CSS URL 集合，成功提交 iframe 后转为当前章节所有权，换章/失败/过期/dispose 统一 `revokeAll()`。ReaderView cleanup 先 `p.dispose()` 再 `server.revokeAll()`；App 返回书架先 flush 并切换视图，React 卸载后会话 effect 清空 book/server/bookKey/章节状态。`measure(expectedLoadSeq)` 在字体、双 rAF 后及兼容补偿前后检查 loadSeq、disposed、contentDoc 和 viewer 身份。
- 为什么这样修：局部集合能区分 sanitize 产生的 CSS URL 与 ResourceServer 共享图片/字体 URL，所有退出路径可重复调用而不会双撤销；React cleanup 是 iframe 资源所有权的自然终点，避免在 paginator 仍使用资源时提前 revoke。
- 未采用方案：不在普通换章调用 `ResourceServer.revokeAll()`；不依赖 Blob URL GC；不把页面中心位置引入布局；不做预加载、缓存、分页算法或进度 schema 改动。
- 修改文件：`src/render/blobOwnership.ts`、`src/render/blobOwnership.test.ts`、`src/render/resources.test.ts`、`src/render/paginator.ts`、`src/render/paginator.test.ts`、`src/ui/ReaderView.tsx`、`src/App.tsx`、`docs/tasks/active/reader-session-lifecycle-and-blob-ownership.md`、`docs/MODULE_CONTRACTS.md`、`docs/SOURCE_DELTA.md`。
- 验证：先写的 token 回归在旧实现以 `isChapterMeasurementCurrent is not a function` 失败；新增 paginator 生命周期回归覆盖成功换章、sanitize 抛错、loadSeq 过期、dispose、VisibilityGate 代次及 ResourceServer 不被章节切换撤销。定向 40/40；全量 Vitest 25 文件 236/236；`tsc --noEmit`、Vite production build 通过。未修改 Rust，不运行 Rust 测试。Windows WebView2/发布包内存行为未人工验证。
- 剩余风险：React 被动 effect 的实际清理时序仍应在主代理的集成测试/浏览器验证中确认；`OwnedBlobUrls` 已覆盖幂等纯逻辑，但 sanitize 失败与真实 iframe 快速换章仍建议用 Chromium 任务矩阵复核。
- 关联：`docs/tasks/active/reader-session-lifecycle-and-blob-ownership.md`、ResourceServer/ChapterPaginator/ReaderView 生命周期契约。

## B-037：内容锚点在重排后漂移且进度重复/回退

- 状态：代码、自动化与 WSL Chromium 回归完成，待 Windows WebView2 审核
- 现象：旧锚点以 DOM 元素序号和横向比例定位，字体/列宽变化后可能落到不同文字；父子递归 leaf 文本累计会重复计数。旧记录恢复后 `charsRead=0` 又可能按页码比例覆盖进度。
- 根因：页面中心被错误地等同于排版目标，且元素树不是稳定文本地址；旧恢复在 `load()` 完成后才注入锚点，错过首次 recompute。legacy-only 锚点还不能安全升级到文本锚点。
- 选择的修复：中心只通过 caret API 作有限邻近采样，当前章节自然 measure 后建立单次可见文本索引。保存 code-point `anchorTextOffset`/有界 snippet；恢复验证原 offset，漂移时线性搜索最近同 snippet，以 Range rect 决定已有列。失败才用严格 legacy index/ratio，再用 saved page。成功 legacy 定位后只读采样升级；所有文本-only sentinel 在 shelf/bookmark/archive/Rust 边界写为 legacy null。`<linear=no>` 只保留此前 linear 章节权重。
- 约束：不写 padding/margin/transform、不插占位、不改变内容结构或第一页原点；archive 保持 v1，旧 JSON 缺字段默认为 null；snippet 最多 32 code point 且无空白，Rust/前端同时校验。
- 验证：text index 覆盖深层 `p>a>span` 不重计、emoji UTF-16 映射、hidden 不改 DOM、snippet 原位/漂移/重复最近；fallback、legacy shelf、text-only 书签/历史/portable、旧 legacy 页比例均回归。定向 70/70、全量 Vitest 27 文件 250/250、TypeScript/Vite build、Rust 11/11、fmt/check 通过。真实 WSL Chromium 使用《有谁规定了在现实中不能有恋爱喜剧的？.03》验证：1280×800 缩至 900×650 后仍保留同一阅读片段，返回书架再打开的中心锚点完全一致；连续无延迟两次字号+后旧 snippet 仍在当前页可见。页面中心只改变定位采样，不改变首列自然原点。Windows WebView2 仍待发布包人工确认。
- 关联：`docs/tasks/active/text-content-anchor-and-progress.md`、C-33、B-021、B-033。

## B-038：同一章节内导航不重载

- 状态：代码、自动化与 WSL Chromium 回归完成，待用户审核
- 发现日期：2026-08-20
- 现象：目录、书签、历史或普通书内链接指向当前章节时，App 仍递增 `anchorNonce` 并重新加载章节，导致 sanitize、iframe Blob、字体等待和测量重复执行；书签/历史跳转后旧 iframe hash 还可能保留旧 `:target` 状态。
- 触发条件或样本：当前已完成布局的章节内 `chapter.xhtml#fragment`、`chapter.xhtml`、同章目录、同章书签、back/forward；不要求特定 EPUB。
- 根因：App 将所有 href 当作章节状态变化，ReaderView effect 只通过 `p.load()` 恢复位置；Paginator 没有供 UI 使用的同步同章恢复事务。
- 约束：同章 direct 不得调用 load/sanitize/iframe src/fonts/measure/recompute，不得短暂隐藏；文本锚点优先于 legacy/page，旧锚点越界不得 clamp；失败不能污染当前页/anchor/hash/history；跨章行为保持原样；页面中心只能只读采样。
- 选择的修复：新增 `ChapterPaginator.navigateWithinCurrentChapter()` 与 ReaderHandle 原子入口。Paginator 在 ready DOM 上先做 fragment/anchor preflight，候选 anchor 用临时副本和 `try/finally` 解析；成功后同步页、hash与 settled，失败返回 false。App 用纯 `sameChapterNavigation` helper 分流 direct/reload，TOC/书签先取只读快照，direct 成功后才提交历史；history back/forward 也只在 direct 成功后采用 transition。
- 为什么这样修：已完成的分页布局可以安全地复用当前 iframe；把直接定位责任留在 Paginator，App 只负责章节路由、历史和进度事务，避免 React 状态更新与历史捕获竞态。成功 text/legacy/page 恢复先清除旧 hash，失败路径不触碰 hash。
- 未采用方案：不把同章跳转伪装为 `load()` 或设置 `readerDisplayReady=false`；不在 App 复制 Range/DOM 分页逻辑；不做跨章预加载、全书扫描或缓存；不改 B-037 持久化字段/Rust schema。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`src/ui/ReaderView.tsx`、`src/App.tsx`、`src/ui/sameChapterNavigation.ts`、`src/ui/sameChapterNavigation.test.ts`、`docs/tasks/active/same-chapter-navigation.md`、`docs/tasks/active/README.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md`。
- 验证：定向 49/49；全量 Vitest 28 个测试文件、258/258 通过；`tsc --noEmit`、Vite production build 通过。测试覆盖同章 path/fragment、空 hash 清除、text/legacy/page 优先级、失败原位、Range 异常回滚、direct/reload 分流和历史事务。真实 WSL Chromium 的同章目录跳转、后退、前进均未发生 iframe load、src mutation 或隐藏 style mutation。
- 剩余风险：Windows WebView2 与生产发布包仍需用户人工确认；跨章仍使用原有 load/display gate。
- 关联：`docs/tasks/active/same-chapter-navigation.md`、C-33、B-037、B-033、B-026。

## B-039：打开书籍同步扫描整书字数并错误覆盖进度

- 状态：代码与自动化回归完成，待用户审核
- 发现日期：2026-08-20
- 现象：打开书架条目时 App 同步读取并扫描全部 spine 文本，首屏被整书 `chapterChars` 扫描阻塞；扫描尚未完成时，未知章节被当成 0，进度分母暂时失真，书架进度可能被写成临时 0/100 或覆盖旧 baseline。
- 触发条件或样本：任意包含多个 linear 章节的 EPUB；快速返回书架、换书或 idle 统计与章节 ready 交错时尤其容易暴露旧回调写入问题。不要求特定 EPUB。
- 根因：`handleShelfOpen` 同步调用 `ResourceServer.textFor()`/正则去标签；App 只有普通数组，没有 generation/source 优先级，也没有异步统计取消与 baseline 保护。paginator 的测量结果虽已有可见文本索引，但没有被作为当前章权威计数消费。
- 约束：首屏不做整书同步扫描；当前已完成章必须使用自然布局后的 measured `totalChars`；后台统计不能参与 CSS/分页/布局；`linear=no` 不进入分母；旧 session callback 不得污染新书；不做 CSS cache、相邻章预加载、流式 ZIP 或 Rust schema 变更。
- 选择的修复：新增 generation-bearing `chapterCounts` collection，区分 unknown/estimated/measured，measured 不可被 estimated 覆盖；新增可注入 idle scheduler 的 `chapterCountJob`，每 slice 最多一章，结构上复用 B-037 的 script/style、hidden、aria-hidden、footnote 排除并去除 Unicode whitespace，缺资源/parser 失败以 estimated 0 完成并记录诊断。当前 display-ready 且 path/anchor/ready/nonempty 校验通过时，把 `anchor.totalChars` 写 measured。counts ref 作为异步权威，state 仅作 UI 快照，generation + AbortController 保证取消和 A→B 隔离。
- 进度保护：纯 `resolveProgressPct(exact, baseline)` 统一派生与持久化；summary 未 complete 时 exact 为 null，沿用打开书架时保存且经校验/夹紧的 baseline，不写临时 0/100；complete 后才以 countsRef 与当前 text/page anchor 即时计算并更新 baseline。返回书架先从 ref 计算再 flush。
- 等待与资源：字体等待和 iframe `defaultView` double-rAF 使用可取消 timer/rAF helper；每个 measure 拥有独立 controller，load/cleanup/dispose abort 旧等待并保留 loadSeq/document/viewer 最终校验。ResourceServer 增加默认 4 MiB/32 项 text LRU，单条超限不缓存，`revokeAll()` 清 entries/bytes，hits/misses 保留为 server 生命周期诊断累计值。
- 为什么这样修：当前章节在自然分页后已有 B-037 可见文本索引，能提供与锚点一致的 measured code-point 总量；其他章节以 idle provisional 让首屏先可用。generation/source/取消语义将异步统计与书籍会话边界分开，baseline 则避免未知分母改变用户已看到的稳定进度。
- 未采用方案：不再同步扫描整书；不把 provisional count 注入 DOM/CSS 或分页；不把未访问章节的 CSS `display:none` 伪装成精确 measured；不做跨 chunk HTML lexer、流式 ZIP、相邻章节预加载或 CSS rewrite cache；不修改 Rust schema。
- 修改文件：`src/ui/chapterCounts.ts`、`src/ui/chapterCounts.test.ts`、`src/ui/chapterCountJob.ts`、`src/ui/chapterCountJob.test.ts`、`src/render/textAnchor.ts`、`src/App.tsx`、`src/render/asyncWait.ts`、`src/render/asyncWait.test.ts`、`src/render/paginator.ts`、`src/render/resources.ts`、`src/render/resources.test.ts`、`docs/tasks/active/incremental-chapter-counts-and-progress.md`、`docs/tasks/active/README.md`、`docs/MODULE_CONTRACTS.md`、`docs/BUGFIX_LOG.md`、`docs/SOURCE_DELTA.md`、`docs/rendering-layers.md`。
- 验证：B039 定向 10 个文件 69/69；B037/B038 相关 paginator/textAnchor/readingProgress/history/sameChapter 回归包含在内；全量 Vitest 31 个文件 269/269、`tsc --noEmit`、Vite production build 通过。未修改 Rust，不运行 cargo。
- 剩余风险：未访问章节的 CSS computed hidden 只能在其 iframe 真正 measured 后确认；当前 provisional 结构统计不承诺该部分。真实 EPUB/Chromium 字号与窗口矩阵、Windows WebView2 和发布包内存行为仍需用户确认。
- 关联：`docs/tasks/active/incremental-chapter-counts-and-progress.md`、B-036、B-037、B-038、C-33。

## B-040：快速连续阅读设置重载丢失内容锚点

- 状态：代码、自动化与 Chromium 回归完成，待用户审核
- 发现日期：2026-08-20
- 现象：长书目录章在 900×650 阅读区的第 2 页，单次字号增加能保留页码和旧 snippet；连续无间隔点击两次字号增加时，第二轮可能在第一轮 cleanup/隐藏期间开始，最终跳到第 1/3 页且旧 snippet 不可见；约 600ms 间隔则正常。
- 根因：ReaderView 对每个 settings/userFonts identity 立即并发调用 `reloadWithSettings()`；paginator 的 anchor 是可变状态，旧 reload 的 cleanup、iframe 文档和新 reload 之间发生时序竞争。
- 约束：连续设置只执行最后一次；章节/anchor 变化必须取消 pending timer 但不额外 reload；新设置不能被旧 reload 覆盖；保持 B-036 的 loadSeq、VisibilityGate、Blob ownership 与 measure abort；不可引入队列、预加载或布局偏移。
- 选择的修复：新增 150ms 可取消 settings debouncer。章节 effect 先记录当前 settings 并取消旧 timer，使切章只执行使用最新 settings 的正常 load；book/server cleanup 与 paginator dispose 同样取消 timer。`reloadWithSettings()` 在任何 await/load 前一次性 capture，复制 `ReadingAnchor` 与当前页，传递 `readingAnchor` snapshot 和 `fallbackPage`；无 content document 时保留既有 anchor，text-only `-1` 只存在内存。
- 为什么这样修：debounce 把连续用户输入收敛为一个明确的最新设置事务；值复制使下一次 load 不依赖 cleanup 后仍可能变化的共享 anchor；既有 loadSeq/display gate/Blob/measure 防线继续负责过期任务，不需要让旧 settings 进入队列等待。
- 未采用方案：不以页面中心或 DOM 位移补偿位置；不新增 reload queue、相邻章预加载、CSS rewrite cache、URL 租约、流式 ZIP 或 Rust schema。
- 修改文件：`src/ui/settingsReload.ts`、`src/ui/settingsReload.test.ts`、`src/ui/ReaderView.tsx`、`src/render/paginator.ts`、`src/render/paginator.settings.test.ts`、`docs/tasks/active/reader-settings-reload-debounce.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/MODULE_CONTRACTS.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md`。
- 验证：B-040 定向 4 个文件、44/44 通过；真实 Chromium 测试书《有谁规定了在现实中不能有恋爱喜剧的？.03》在 900×650 下快速无延迟连续两次字号+仍位于第 2/3 页，旧 snippet 保持当前页可见且无 pageerror；同章 direct 无 load/src/style mutation，返回书架重开 anchor 一致。最终全量 Vitest、`tsc --noEmit`、Vite production build 均通过；无 Rust 改动，不运行 cargo。
- 剩余风险：debounce 延迟固定为 150ms，若后续发现输入设备或无障碍操作需要不同窗口，应另立任务评估；Windows WebView2 仍待发布流程确认。
- 关联：`docs/tasks/active/reader-settings-reload-debounce.md`、B-036、B-037、B-038、B-039、分页器显示门与阅读锚点契约。

## B-041：多看普通图文容器被误判为全页图

- 状态：代码、自动化与 WSL Chromium 完成，待用户/Windows WebView2 审核
- 发现日期：2026-08-20
- 现象：`EPub指南——从入门到放弃` 的 3.1「样式来源」中，`.duokan-image-single` 内的普通图片与 `.duokan-image-maintitle` 图注被拉成整页 flex 图；图片宽度占满视口，图注被挤压到极窄区域。
- 触发条件或样本：一个 `.duokan-image-single` 同时包含 `img` 与可见 `p.duokan-image-maintitle`；书籍作者 CSS 本意为 `width:100%` 的普通图文容器。
- 根因：阅读器将 `.duokan-image-single` 类名无条件混入显式全页图集合：消毒器注入 `height:100% !important`/flex 和图片 `width/height:100% !important`，百分比宽度改写与分页器的全页候选、fit-content 跳过也沿用同一错误语义。该类并不等同于全页图。
- 约束：不按图注类、书名或章节名特判；仍须保留 `.duokan-image-fullscreen`、`.illus`、`.kuchie`、`.cover` 的显式全页语义，以及 B-013 的无文字单图/inline SVG 页面级识别。
- 选择的修复：从 sanitize 强制全页 CSS、fullpage 祖先判据、CSS 宽度改写跳过表和 paginator 三处仅由该类触发的排除中移除 `.duokan-image-single`。普通容器恢复既有 L3 默认版心与 L4 作者图注布局；真正无文字的单图页继续由 `isPlainImagePage` 进入 `fullpage-image`。
- 为什么这样修：全页意图应由明确 fullscreen 类或可验证的整页内容结构表达，不能由兼作普通图文容器的厂商类名猜测。页面级结构检测已经覆盖需要整页显示的纯图片包装，因而不必新增 marker 或维护图注白名单。
- 未采用方案：不只排除 `.duokan-image-maintitle`，因为类名和结构会随书变化；不移除所有全页图规则，避免回归明确 fullscreen 与 B-013；不按本书路径写 CSS 特判。
- 修改文件：`src/render/sanitize.ts`、`src/render/cssRewrite.ts`、`src/render/paginator.ts`、对应 `sanitize`/`cssRewrite` 单测、`docs/tasks/active/epub-guide-compatibility.md`、本记录、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md`。
- 验证：新增回归在旧实现下 2 项失败（普通容器仍跳过 width 改写、仍注入全页 CSS）；修复后 `sanitize`、`cssRewrite`、`paginator` 定向 Vitest 3 文件 114/114 与 `tsc --noEmit` 通过。主审查以目标 EPUB Chromium 1280×800 复核 3.1：章节为 1/4 页、viewer `fullpage=false`；两个普通容器均为 `display:block`、宽 650px、高 302/387px、无 `data-reader-margin-fixed`，图片为 441×253/624×338，图注均宽 640px、位于图片下方且未越界。整组收尾 Vitest 34 文件、304 测试、`tsc --noEmit` 与 `pnpm build`（95 modules）均通过；无 Rust 改动，未运行 cargo。
- 剩余风险：本轮依赖纯图片的无可见文字结构识别；若未来 `.duokan-image-single` 的真正整页图片带有非图注文本，需要由其内容结构/明确 fullscreen 类单独确认，不能重新把整个类设为全页。
- 关联：C-34、B-013、`docs/tasks/active/epub-guide-compatibility.md`。

## B-042：连续百分比 float 被逐项内缩到版心

- 状态：代码、自动化与 WSL Chromium 完成，待用户/Windows WebView2 审核
- 发现日期：2026-08-20
- 现象：`EPub指南——从入门到放弃` 3.4.4「opacity 属性」的五个 viewer 直接子 `.opacity-*` 均为同向 `float:left; width:20%`，却被 C-31 逐项写入版心左 inset，原本一行的五个色块变成 2/2/1 并出现版心外溢。
- 触发条件或样本：连续直接 sibling、同方向 float、每项最终作者宽度为百分比且总和约为 100%；单个 float、不满整行、混合 px/%、方向变化、clear 或普通块打断不应改变旧 C-31 行为。
- 根因：C-31 以单个 reader-top float 为决策单位，没有识别作者用连续百分比 float 表达横向栅格；在宽 viewer 中单项 computed width 小于 40rem，于是每项都获得相同物理侧 inset。
- 约束：不能全局关闭 C-31、不能按 opacity/类名/书名特判、不能依据 computed px 比例猜百分比；Typed OM/CSSOM 无法确认作者最终百分比时必须保守不豁免；B-034 的单个无 margin 顶层 float 仍需得到旧 inset。
- 选择的修复：新增纯函数 `getPercentageFloatGroupMembers`，只标记连续 direct sibling 的同方向 `left/right` float 组：`reader-top`、`clear:none`、每项明确 `0<width<=100%`、组至少 2 项且百分比总和在 `99..101` 时，`applyBookMargins` 才跳过 C-31。新增 `getAuthoredPercentageWidth`：现代 Typed OM 存在明确值时直接采用（包括 px 的非百分比结果）；旧 WebView 才按简单、可判定的 CSSOM 重要性/特异性/源顺序回退。reader overrides 中若存在匹配 width、复杂伪类/未知条件或不可读 sheet，则保守返回 unknown，避免把用户 CSS 或未建模 cascade 当成作者栅格。
- 为什么这样修：组级判断保留 C-31 对普通单 float 的保护，只跳过能够由作者声明直接证明为“一整行栅格”的最小集合；真实 sibling 序列包含所有 viewer 子元素，fullscreen/普通块/clear 不会因候选过滤而错误拼组。
- 未采用方案：不按元素尺寸或五个 `.opacity-*` 类名特判；不把所有百分比 float 视为栅格；不移除 C-31 或统一改写 float width；不在 CSS 改写阶段改变作者声明。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/tasks/active/epub-guide-compatibility.md`、本记录、`docs/rendering-layers.md`、`docs/tasks/active/README.md`、`docs/SOURCE_DELTA.md`。
- 验证：先写回归在旧实现下 36 项通过、5 项失败；级联边界补测后 paginator 定向 48/48、`tsc --noEmit` 通过。纯函数覆盖 20×5、50×2、33.333×3 容差、单个 70%、20×2、不满整行、混合 px/%、方向/普通块/clear 断组、Typed OM 最终 px/无值、inline important/stylesheet 覆盖、reader overrides、复杂伪类、未知 CSSOM 和最终获胜 CSSOM 声明。目标 EPUB Chromium 复核：1280×800 时 `.opacity-1..5` 均 `top=310.906`、宽 `252.797`，连续覆盖 viewer `x=8..1271.984`，margin `0/0` 且无 `data-reader-margin-fixed`；900×650 时同一行、宽 `176.797`，覆盖 `x=8..891.984`，同样无写回。章节整章页数分别为 1/4 与 1/5，仅作记录不作断言。最初脚本因同章另有 opacity-rgba/demo 元素误将目标扩大为 5 个以上而超时，后收窄为前五项核对；临时脚本已删除且不纳入同步。整组收尾 Vitest 34 文件、304 测试、`tsc --noEmit` 与 `pnpm build`（95 modules）均通过；无 Rust 改动，未运行 cargo。Windows WebView2 仍待人工确认。
- 剩余风险：旧 WebView 的 CSSOM 只能在样式表可读且能建立级联顺序时确认百分比；任何不可读 author sheet 都宁可保留 C-31。真实 WebView2 与窄视口下的多栏 float fragmentation 仍需矩阵复核。
- 关联：C-35、C-31、B-034、`docs/tasks/active/epub-guide-compatibility.md`。

## B-043：EPUB 3 NAV fragment 与多级目录异常

- 状态：代码、自动化与 WSL Chromium 完成，待用户/Windows WebView2 审核
- 发现日期：2026-08-20
- 现象：目标书的 EPUB 3 NAV 已正确优先使用，但 fragment-only 条目被置灰；父级 `li` 可能拿到嵌套项链接，混合 `ol/ul` 或 div 包装时顺序/层级不稳定；目录头只显示 27 个顶层项，同一 XHTML 的多个 fragment 可能同时高亮。
- 触发条件或样本：`/home/herenfor/test/测试用epub/ePub指南——从入门到放弃 20230418.epub`；NAV 统计为 27 个顶层节点、334 个递归节点。
- 根因：`epub:type` 读取只依赖 `epub:type` 前缀属性；旧解析器用全子树第一个 `a` 与分离收集 `ol`/`ul`，可能跨过嵌套 li；fragment href 没有基准文档上下文；UI 只按 path 比较且只统计顶层。
- 约束：无上下文的 `isUsableHref("#id")` 仍必须为 false；只有已知 nav/NCX 基准文档位于 spine 时绑定 fragment；不改变 NAV 优先级、分页或历史状态机。
- 选择的修复：命名空间/前缀/local-name/普通属性回退读取 `epub:type`；最近列表搜索在嵌套 li/列表处剪枝，父项只读取自己的链接/文字并按文档顺序合并混合列表；`resolveTocHrefs` 在 spine 上下文中解析 `#`/`#id`；目录 UI 递归统计并用唯一节点引用按 fragment 精确、章首、同路径顺序高亮，App 传入 path+anchor。
- 为什么这样修：解析器负责保留书籍真实导航树，href 解析负责在有上下文时补足 EPUB 合法的同文档目标，UI identity 比较能从根本上消除同路径多项同时激活，而不需要向分页器注入导航状态。
- 未采用方案：不全局放开纯 fragment；不把所有同路径项同时高亮；不将 NAV 降级为 NCX；不为 direct 同章导航另加 anchor 持久化或重载。
- 修改文件：`src/core/nav.ts`、`src/core/nav.test.ts`、`src/core/book.ts`、`src/test/book.test.ts`、`src/ui/TocPanel.tsx`、`src/ui/TocPanel.helpers.test.ts`、`src/App.tsx`、相关任务/台账文档。
- 验证：旧实现新增父 `li` 测试失败并误取“子节点”；修复后 NAV 12/12（含 XML 直接嵌套 li）、book 14/14、Toc helper 3/3，`tsc --noEmit` 通过。目标 EPUB 1280×800 Chromium 复核确认 `.toc-count` 为 `334 项`、DOM `.toc-item` 为 334 个，缩进为 8/22/36px；正确 `12.4.1 图片处理` 存在，错误 NCX 标签 `14.1 图片处理` 为 0，证明 EPUB 3 NAV 优先。根“目录”无 disabled，点击后 iframe 含 `nav#toc`；点击 `12.4.1` 后唯一 active 正是该项，进入 Chapter12-4 第 2/21 页，章节 h2 含 12.4.1～12.4.4。iframe `:target` 为 null 属于既有跨章 TOC jump 不写 `location.hash` 的范围外行为，不作为本项断言，也不扩修；临时脚本已删除。整组收尾 Vitest 34 文件、304 测试、`tsc --noEmit` 与 `pnpm build`（95 modules）均通过；无 Rust 改动，未运行 cargo。
- 剩余风险：同章 direct 导航没有为了高亮额外写回运行时 fragment；缺少 anchor 时按章首或同路径第一项回退。Windows WebView2 实机仍待用户确认。
- 关联：C-36、B-026、`docs/tasks/active/epub-guide-compatibility.md`。

## B-044：UA 默认 margin 被错误当作作者缩进

- 状态：代码、自动化与 WSL Chromium 完成，待用户/Windows WebView2 审核
- 发现日期：2026-08-20
- 现象：`EPub指南——从入门到放弃` 8.6.5「搬运注释」的两个顶层 `blockquote` 只有 `font-size:.875em` inline style。Chromium UA stylesheet 产生 `margin-left/right:40px`，C-04 把它写成正文版心 base + 40px，盒子整体右移并超出预期范围。
- 触发条件或样本：页面直接 `reader-top` 元素有非零 computed horizontal margin，但没有作者/用户的 `margin`、`margin-left/right`、`margin-inline` 或 logical start/end 声明；典型为浏览器 UA 的 blockquote 默认值。
- 根因：C-04 只根据解除 L3 auto margin 后的 computed px 值判断，缺少 CSS 来源证据，因此 UA 默认值与作者显式缩进不可区分。
- 约束：不能全局清零 blockquote/UA margin，不能按书、章节或标签特判；作者 inline/stylesheet/customCss margin、B-023 百分比 C-16、C-18 intrinsic 盒和 B-034/C-31 float 均须保留。
- 选择的修复：`hasAuthoredHorizontalMargin` 先检查 comment-aware inline style，再遍历当前生效 CSSOM 的匹配规则，识别 shorthand、物理和 logical 水平 margin。调用时已临时删除 L3 `.reader-top` auto declarations，因此 reader stylesheet 中 customCss 仍可作为用户意图，内建 auto 不会假阳性；仅 non-percentage、computed margin nonzero/unknown、可能到达 C-04 的直接子触发扫描，零/auto 子元素不重复遍历全部样式表，C-16 百分比 margin 则先返回。未知 media/supports、grouping、选择器或不可读样式表返回 `undefined`，仍走旧补偿；明确 false 才在 C-31 后、C-18/C-16/C-04 前保留自然 L3 版心。
- 为什么这样修：来源门控只排除能够证明为 UA-only 的边距，既避免本书右移，也不会把无法可靠辨别的作者布局重置为默认值；CSSOM 是当前运行时级联的合适边界，不需要书籍专用规则。
- 未采用方案：不为 `blockquote` 写全局 margin reset；不把所有相等/40px margin 视为 UA；不扫描被移除前的 reader sheet 而吞掉 customCss；不在未知 CSSOM 条件下猜测为 UA。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/BUGFIX_LOG.md`、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md`。
- 验证：新增回归在旧实现下 4 项失败、既有 paginator 48 项通过；修复后 paginator 54/54、`tsc --noEmit` 通过。覆盖注释 inert、inline shorthand/logical、匹配/不匹配规则、活动/非活动 `@media/@supports`、未知 grouping、不可读 sheet、reader customCss、明确 false/true/unknown 的决策门、zero/auto 与 C-16 百分比不扫描边界。目标 EPUB 8.6.5 Chromium：1280×800 下两个 blockquote 都为 `width=640px`、`margin=312/312px`、inline 仍仅 font-size、无 fixed；三段 fragments 严格落于各列 `320..960`、`1608..2248`、`2896..3536` 的 40rem 版心。900×650 下均为 `width=640px`、`margin=122/122px`、无 fixed，fragments 为 `1038..1678`、`1946..2586`，后代 rect 均未越块界。相邻 B-023 赤月、B-024 玩具堂和 Sumeragi 均保持既有实书结果；临时脚本已删除。整组收尾 Vitest 34 文件、304 测试、`tsc --noEmit` 与 `pnpm build`（95 modules）均通过；无 Rust 改动，未运行 cargo。Windows WebView2 尚待人工确认。
- 剩余风险：外链 CSS 不可读、复杂或未来 CSS grouping 条件无法证实时继续原 C-04 路径，可能仍保留个别误补偿，但不会因错误否定来源吞掉作者布局。
- 关联：C-37、C-04、C-16、C-18、C-31、`docs/tasks/active/epub-guide-compatibility.md`。

## B-045：UA 对称 margin 被来源门控吞掉

- 状态：代码、自动化与 WSL Chromium 回归完成，待用户/Windows WebView2 审核
- 发现日期：2026-08-20
- 现象：B-044 之后，`EPub指南——从入门到放弃` 8.6.5 的两个顶层 `blockquote` 不再整体右移，但恢复的 L3 auto margin 又使其保持完整 640px 正文版心，浏览器默认左右各 40px 的语义缩进消失。
- 触发条件或样本：元素是 viewer 直接 `reader-top`，只写 `font-size:.875em`，没有作者/用户水平 margin；临时解除 L3 auto 后 computed margin 为有限、非零且近似对称的 UA px 值。
- 根因：B-044 的 UA 来源门控直接跳过 C-04，保留了居中却丢失了 UA 对称 margin 的双侧内留白。重新进入 C-04 又会把左侧 40px 误当作单侧版心偏移，因此不能简单撤销 B-044。
- 约束：仅 `reader-top`、`authoredHorizontalMargin === false`、非浮动/非全页、非百分比、左右 margin 有限非负非零且在容差内对称；排除 fit-content/C-31 等更高优先级路径；窄视口不得负宽/溢出；临时值必须可恢复且重排幂等；不按标签、书名或章节特判。
- 选择的修复：新增 `getReaderTopUaSymmetricInsetMaxWidth()` 纯几何门控，在 C-31 后、C-04 前把当前 border-box 减去左右 UA inset，按 `box-sizing` 换算为临时 `max-width`，然后交还 L3 auto margin 保持居中。写回纳入既有 `marginFixes`，下轮 measure/dispose 前恢复。
- 为什么这样修：`640px - 40px - 40px = 560px` 表达的是保留两侧留白后的有效阅读宽度，不会重演旧 C-04 的单侧右移，也不会把作者显式 margin 误认为 UA。
- 未采用方案：不撤销 B-044；不将所有正对称 margin 放入 C-18；不全局重置 blockquote；不固定写死 40px；不干预 float、fullpage、fit-content、百分比或作者/用户 margin。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、本记录、`docs/rendering-layers.md`、`docs/SOURCE_DELTA.md`。
- 验证：新增回归在旧实现下 1 项失败；修复后 paginator 55/55，全量 Vitest 34 文件 305/305，`tsc --noEmit` 与 `pnpm build`（95 modules）通过。WSL Chromium 1280×800：两个 blockquote 均 `width/max-width=560px`、`margin=352/352px`，每个 fragment 宽 560px 且逐列居中，后代无越界；900×650：均 `width=560px`、`margin=162/162px`，无越界。B-023 赤月、B-024 玩具堂、Sumeragi 保持 1/1/无 viewer 横向溢出；B-041 3.1 图文容器、B-042 五个 opacity float、B-043 12.4.1 NAV 跳转均通过。临时脚本仅在 `/tmp`，未写入仓库。
- 剩余风险：Windows WebView2 与发布包仍待用户人工确认；旧引擎若无法提供有限 computed width/box-sizing，门控会保守跳过。
- 关联：C-38、C-37、C-04、C-16、C-18、C-31、`docs/tasks/active/epub-guide-compatibility.md`。

## B-046：顶层浮动布局单元与完整百分比组版心限宽（C-31/C-39）

- 发现日期：2026-08-20；状态：代码、自动化与 WSL Chromium 完成，待用户/Windows WebView2 审核。
- 现象：金木犀目录的顶层 `float:right;margin-right:2em` 因旧 C-31 跳过作者 margin 后落入 C-04，被错误搬到页面中部；EPub 指南 3.4.4 的五个 `width:20%` float 若逐项补偿会拆行，完全放任又会横跨全 viewer。
- 选择：第一阶段建立 float 防火墙，所有顶层 left/right float 均不再进入 C-04/C-18；安全单项投影到 40rem 版心并保留作者 margin，复杂单项只写回原始布局。第二阶段以连续直接 sibling 的完整安全百分比组为最小布局单元，成员宽度按 `min(父容器百分比宽度, 40rem 对应比例宽度)` 计算为本轮 px，首项加入版心 inset；不包 DOM，不按书名/类名特判。复杂组、方向/位置/边距不安全、fullpage/fullwidth/过宽和验收失败均保守保留作者 float。
- 生命周期：新增独立 `floatLayoutFixes` 完整保存 width/max-width/margins、priority 与 marker，重排/dispose/异常均恢复；C-08 跳过已处理组成员，避免二次宽度写回。
- 验证：新增 paginator 回归覆盖 5×20、2×50、3×33.333、窄容器、right 组、方向/clear/px/unknown/负或百分比 margin/fullwidth/几何失败/恢复/C-08 隔离，62/62；全量 Vitest 34 文件 312/312，`tsc --noEmit`、`pnpm build`（95 modules）通过。Chromium 实测 3.4.4：1280×800 各 128px、组 `320..960`、4 页；900×650 各 128px、组 `130..770`、5 页；字号 16→20→16 宽度 128→160→128。金木犀 1280/900 右 float 仍分别在版心右缘内 2em（右缘 928/738），均 2 页。
- 关联：C-39、C-35、C-31、B-034、`docs/tasks/active/epub-guide-compatibility.md`。

## B-047：显式对称居中标题被 C-04 右移（C-40）

- 发现日期：2026-08-20；状态：代码、自动化与 WSL Chromium 完成，待用户/Windows WebView2 审核。
- 触发条件或样本：`【测试专用】[みかみてれん].将放言说不会输的高颜值女孩，全力征服的百合故事.01.epub` 的 `OEBPS/Text/toc.xhtml`，`h3.ctt` 使用 `text-align:center` 与左右各 `0.75em` 的对称作者 margin。旧 C-04 将左 margin 优先解释为单侧缩进，标题中心比目录主体向右 24px。
- 根因：C-04 无法区分左对齐标题的真实左缩进和对称居中元素的作者 margin，导致对称居中盒再次被版心补偿。B-046/C-39 浮动修复未命中该元素；问题不是 float，也不能按 `.ctt` 或书名特判。
- 选择的修复：新增纯门控 `shouldKeepCenteredAuthorMargins`，在 C-31/C-16/C-18/C-38 后、C-04 前执行。只有 viewer 直接 `reader-top`、`float:none`、`horizontal-tb`、computed `text-align:center`、作者水平 margin 来源明确、左右有限正值且 0.5px 内对称、无 percentage/negative/zero/unknown margin、无作者 width/min-width/max-width sizing intent、非 fit/fullpage 时，保留 L3 自然 auto margin 并跳过 C-04。
- 来源与回退：`hasAuthoredSizingIntent` 读取 comment-aware inline/HTML sizing 属性和可读作者 CSSOM；reader 内建 `max-width:40rem` 不算作者 intent。固定/最小/最大宽度、不可读/unknown CSSOM、reader custom CSS、非对称布局均保守走旧路径；keyframes CSSRule 不作为静态 selector sizing source。B-024 的 `text-align:left; margin:1.3em 0.75em...` 继续保留 24px 左缩进。
- 为什么这样修：门控只释放能够证明是普通对称居中作者 margin 的 auto-like 盒，避免重演 C-04 单侧右移；固定 sizing 和不确定来源继续旧路径，优先保护作者明确布局。
- 修改文件：`src/render/paginator.ts`、`src/render/paginator.test.ts`、`docs/tasks/active/epub-guide-compatibility.md`、`docs/tasks/active/README.md`、`docs/rendering-layers.md`、`docs/MODULE_CONTRACTS.md`、`docs/SOURCE_DELTA.md`。
- 验证：新增回归在旧实现下失败；修复后 paginator 定向 64/64，全量 Vitest 34 文件 314/314，`tsc --noEmit` 与 `pnpm build`（95 modules）通过。目标目录 Chromium 1280×800 标题/目录主体中心均 640px，900×650 均 450px；字号 16→20→16 无累计偏移且 h3 无 C-04 marker。B-024 1280/900 仍为 `left=344/154px`、`text-align:left`、marker=1；B-045 blockquote 仍为 560px 对称盒；B-023 百分比 margin、B-046 opacity float、金木犀 right float、C-18 summary 均回归通过。
- 剩余风险：Windows WebView2 与发布包仍待实机确认；不可读 CSSOM 或无法证明作者 sizing intent 时保守保留旧补偿。
- 关联：C-40、C-24、C-18、C-16、C-04、C-31、C-38、C-39、`docs/tasks/active/epub-guide-compatibility.md`。

## B-048：桌面链接导入遗漏 `cover.webp` 文件名 fallback（C-41）

- 发现日期：2026-08-20；状态：代码与自动化完成，待 Windows 发布包确认。
- 现象：manifest 中存在 `<item id="image001" href="Images/cover.webp" media-type="image/webp">`，浏览器开发预览可显示封面，但 Windows 发布版导入后没有封面。
- 根因：这不是 WebView2/WebP 解码问题。浏览器预览由 TypeScript `loadBook()` 解析 EPUB，原先会按资源文件名 `cover.*` 回退；桌面发布版为了不把大 EPUB 复制到 WebView，批量导入改由 Rust `linked_library_import_paths` 直接解析 OPF。Rust 只以 manifest `id.contains("cover")` 兜底，既漏掉 `id=image001`，又可能错误选中 `cover.css` 或 `cover.xhtml`。
- 约束：保持链接书库的大文件/低内存架构；不解析 EPUB2 guide XHTML、不扫描 ZIP 全体文件、不解压或解码封面候选、不增加哈希/启动时旧书库扫描；不迁移旧绑定。重复导入继续只刷新设备 binding，保留同 `contentHash` 的进度、书签与首次添加时间。
- 选择的修复：Rust 与 TypeScript 统一候选契约：按 OPF manifest 源顺序，依次检查 EPUB3 `properties="cover-image"`、EPUB2 `meta name="cover"` 指向的 item、以及 URL 解码并去除 query/fragment 后 basename stem 大小写无关精确为 `cover` 的 item。候选必须实际存在且是 `image/*`，或从 jpg/jpeg/png/webp/avif/gif/svg 扩展名可靠推断为图片；上层候选无效时继续下一层。Rust 用已打开 `ZipArchive::by_name` 查询中央目录，绝不读取候选内容。
- 为什么这样修：保持标准声明优先，同时修复非标准但常见的 `cover.webp`；有序 manifest 让多个候选的选择稳定，精确文件名避免旧 ID 模糊匹配的 CSS/XHTML 误判。
- 未采用方案：不让发布版回退到 TypeScript 全书读取（会重新引入大文件 IPC/内存成本）；不解析 guide 引用的封面页（需要额外解压和 XHTML DOM 分析）；不按 ZIP 全文件名扫描；不支持自定义 CSS `@font-face` 相对路径。
- 修改文件：`src-tauri/src/linked_library.rs`、`src/core/book.ts`、`src/test/weirdBooks.test.ts`、`docs/tasks/active/cover-fallback-contract.md`、本记录及交接文档。
- 验证：修改前 TypeScript 回归错误返回缺失的 `OEBPS/missing.jpg`；修复后合成 EPUB 回归通过，覆盖 URL 编码 `Cover%2EWEBP?cache=1#preview`、无效 EPUB3 声明、EPUB2 指向 CSS、错误 MIME 的扩展名推断和 `id=image001`。完整前端/Rust验证见任务文件。
- 剩余风险：尚未用 Windows 发布包导入真实 `cover.webp` 样本；已存在旧 binding 不做启动迁移，测试版可重新导入以刷新 binding。若声明为浏览器无法解码的未知 `image/*`，缩略图派生仍会按既有失败路径显示无封面。
- 关联：C-41、B-031、`docs/tasks/active/cover-fallback-contract.md`。

## B-049：设置数值步进到达边界后环绕默认值

- 状态：代码、自动化与 WSL Chromium UI 验证完成，待用户/Windows WebView2 审核
- 发现日期：2026-08-21
- 现象：详细设置的行高、字重、字间距和字符间距连续点击 +/- 到达最小/最大值后，再点击会回到 `undefined` 自动档；边界点击还会创建新 settings 对象并触发无效阅读器重载。
- 根因：App 原 `stepValue` 把 `undefined` 自动档放进环形数组并使用模运算；同时 setter 不区分真实变化与 clamp 后的原值。MenuPanel 对 `undefined` 的可见值分别是行高 1.6、字重 400、间距 0，不能把存储 sentinel 直接当作数值序列的首档。
- 约束：纯数值档位必须按可见默认值相邻步进；边界同方向点击保持原 settings identity，不触发持久化/ReaderView reload；有效设置变化继续使用现有 150ms debounce；direct slider change 继续 clamp；不涉及 WebView2 字形生产修复、分页算法或 Rust。
- 选择的修复：新增 `stepSettingValue(values, current, direction, visibleDefault)`，只接收升序数值档位；从 `undefined` 以 `visibleDefault` 作为当前位置，方向减取最近较小、方向加取最近较大，超界 clamp；若自动档候选仍等于可见默认值则保留 `undefined`。App 将四组档位改为 `[1.4..2.2]`、`[300..700]`、`[0,2..8]`、`[0,4..16]`，边界 updater 返回原对象；字号与 direct slider setter 同步避免边界无效 identity 并 clamp。
- 修改文件：`src/ui/settingsStepper.ts`、`src/ui/settingsStepper.test.ts`、`src/App.tsx`、`docs/tasks/active/settings-stepper-bounds.md`、`docs/tasks/active/README.md`、`docs/MODULE_CONTRACTS.md`、`docs/PROJECT_CONTEXT.md`、`docs/SOURCE_DELTA.md`。
- 验证：新增回归在旧 helper 下 3 项失败；修复后步进定向 4/4，设置相关组合 7/7；全量 Vitest 35 文件、319/319 通过；`tsc --noEmit` 与 `pnpm build`（96 modules）通过。浏览器插件因 `sandboxCwd` 元数据错误不可用后，复用 WSL Playwright/Chromium 做真实点击：行高 1.6→1.8 触发 iframe load `0→1`，2.2 额外 `+` 保持值/load=3，1.4 额外 `-` 保持值/load=7；字间距 0 额外 `-` 保持值/load=7，0→2 触发 load `7→8`。Vite/Chromium 已停止，5173/5174 均未监听。
- 剩余风险：Windows WebView2 仍需用户确认设置重排及既有字形空心化问题；B-049 不改变其生产 CSS 规避策略。
- 关联：`docs/tasks/active/settings-stepper-bounds.md`、MODULE_CONTRACTS 设置 identity/reload 契约、B-040。

## B-050：打开期阅读进度证据、统计缓存与会话写入

- 状态：代码、自动化回归与 Root 独立 WSL Chromium 烟测完成，待用户/Windows WebView2 审核。
- 发现日期：2026-08-22
- 现象：多章书打开后快速翻页并立即返回书架时，页码/锚点已经保存，但全书章节统计尚未完成，百分比仍为旧 baseline（常见为 0）；书架只看 `progressPct>0`，显示未读且不显示“继续阅读”。连续输入还可能让打开期统计长期等待，纯图片章被计为零权重。
- 根因：B-039 的 incomplete summary 只能安全保留 baseline，但 UI 没有区分“百分比暂不可精确计算”和“没有阅读位置”；章节 job 没有显式 timeout/批量边界、失败以 estimated zero 完成，且没有本机派生缓存。新导入时间原先取当前时间，存档 merge 会让 import-only 空位置以较新时间赢过真实位置。
- 约束：不阻塞首屏、不改变 portable archive schema、不缓存 measured/CSS 相关计数、不把失败伪装成真实零；`linear=no` 不入分母；最后 linear 章最后一页才允许 100%；`markOpened` 仍只能清新标记。
- 选择的修复：新增通用 `hasReadPosition/hasReadEvidence`，书架显示与整数百分比解耦；成功进度 patch 和后端 `updateProgress` 清 `isNew`。状态栏 incomplete 显示“计算中”，estimated complete 显示“约”。新增版本化、有界 localStorage structural-count cache，按 `contentHash ?? shelfId` 键控，严格校验 linear mask/长度/safe integer，最多 256 entries/100000 counts，并对 measured/error/unknown 做 structural estimate merge-preserve；job 默认每 slice 最多 4 章、100ms timeout 并批量回调，失败写 error/unknown。新增媒体单元 1000 字权重，SVG 内 image 不重复，当前媒体章 measured 使用 `pageCount * 1000`。新导入 `lastReadAt=0`；portable merge 先按阅读证据再按时间。`ShelfProgressWriter.beginSession()` 按每次打开重置首次立即写门。
- 未采用方案：不改 `paginator.setPage()` 的 emit/capture 顺序；已有状态回归和实现审查未证明 effect 会在 capture 前读取旧锚点，因此保留高风险分页器不变。
- 修改文件：`src/ui/readEvidence.ts`、`src/ui/ShelfView.tsx`、`src/ui/shelf.ts`、`src/ui/shelf.test.ts`、`src/ui/progressWriter.ts`、`src/ui/progressWriter.test.ts`、`src/ui/chapterCounts.ts`、`src/ui/chapterCounts.test.ts`、`src/ui/chapterCountJob.ts`、`src/ui/chapterCountJob.test.ts`、`src/ui/chapterCountCache.ts`、`src/ui/chapterCountCache.test.ts`、`src/render/textAnchor.ts`、`src/render/textAnchor.test.ts`、`src/render/paginator.ts`、`src/ui/ReaderView.tsx`、`src/App.tsx`、`src/ui/libraryArchive.ts`、`src/ui/libraryArchive.test.ts`、`src-tauri/src/linked_library.rs`、本任务及契约/源差异文档。
- 验证：相关定向 Vitest 7 文件、48/48；全量 Vitest 36 文件、332/332；`tsc --noEmit`；Vite production build（98 modules）；Rust `cargo fmt --check`、`cargo check --quiet`、`cargo test --quiet`，Rust 14/14 均通过。
- 剩余风险：Windows WebView2 的 localStorage/quota、Tauri 真实关闭/隐藏 flush、目标 EPUB 媒体章和安装包仍需用户实机确认；未启动长期 Vite/Chromium。
- 关联：`docs/tasks/active/reading-progress-open-session.md`、B-037、B-039、C-33。

## B-051：首次白屏加载期间翻页意图被错误回放

- 状态：代码与定向自动化回归完成，待用户/Windows WebView2 审核。
- 发现日期：2026-08-22
- 现象：首次进入书籍的白屏加载期间，首个 display-ready 前的滚轮/方向键/PageUp/PageDown/空格/工具栏翻页意图被缓存，首个 ready 后可能补执行，导致打开位置被抢跑。
- 根因：`TurnIntentBuffer` 原先只有 ready/loading 状态，无法区分本书首次 loading 与已经显示过后的跨章 loading；首次 ready 会消费初始期间的单槽方向。
- 约束：首次 ready 前输入必须完全丢弃；首次 ready 只解锁且清理外层滚轮累计；已显示书籍的跨章 loading 仍保留最后方向单槽并在下一次 ready 消费一次；不改 paginator、CSS 或显示门顺序。
- 选择的修复：为 `TurnIntentBuffer` 增加本书生命周期 `displayedOnce` 门；首次 `markReady()` 丢弃 pending，后续 `markLoading()`/`request()` 保留既有单槽语义。`ReaderView` 在首次 display-ready reset 外层 `WheelTurnAccumulator`，书籍 `key={bookKey}` 重建自然重新上锁。
- 修改文件：`src/ui/turnIntent.ts`、`src/ui/turnIntent.test.ts`、`src/ui/ReaderView.tsx`、`docs/tasks/active/initial-turn-intent-gate.md`、本记录及契约/源差异文档。
- 验证：`src/ui/turnIntent.test.ts` 9/9；全量 Vitest 36 文件、334/334；`tsc --noEmit` 通过。未启动长期 Vite/Chromium；Windows WebView2 真实输入仍待用户确认。
- 关联：`docs/tasks/active/initial-turn-intent-gate.md`、B-033、B-039。

## B-052：Ctrl/Cmd+A 误触发宿主全页选择

- 状态：代码与自动化回归完成，待用户/Windows WebView2 审核。
- 发现日期：2026-08-22
- 现象：书架或阅读器宿主 UI 中按 Ctrl/Cmd+A 会触发整页蓝色选择；iframe 正文内的选择行为也未与宿主统一。
- 根因：App 宿主 keydown 与 ChapterPaginator iframe keydown 没有排除非编辑区域的 select-all 默认行为。
- 约束：只拦截 A/a + Ctrl 或 Meta；input、textarea、contenteditable 及其后代必须放行；方向键/PageUp/PageDown 翻页不受影响；进入 reader 只清一次宿主旧 selection，不在章节切换/设置重排时清正文选择。
- 选择的修复：新增可复用 `selectionGuard`，App 与 paginator 共用；命中后 preventDefault 并对对应 document 执行 `removeAllRanges()`。App 在 `view/bookKey` 进入 reader 时清理宿主既有 selection。
- 修改文件：`src/render/selectionGuard.ts`、`src/render/selectionGuard.test.ts`、`src/render/paginator.ts`、`src/App.tsx`、`docs/tasks/active/selection-shortcut-guard.md`、本记录及契约/源差异文档。
- 验证：selectionGuard、paginator、turnIntent 定向 76/76；全量 Vitest 37 文件、337/337；`tsc --noEmit`；Vite production build（99 modules）通过。Windows WebView2 编辑控件与真实 selection 仍待用户确认。
- 关联：`docs/tasks/active/selection-shortcut-guard.md`、B-033、B-051。

## B-053/C-42：深色主题半透明章节盒对比度不足

- 状态：代码与自动化回归完成，待用户/Windows WebView2 审核。
- 发现日期：2026-08-22
- 现象：目标书资料⑤ `p-007.xhtml` 在 dark theme 下 body/box/p 都接近 `rgb(212,212,212)`，半透明白 box 合成背景变亮后正文对比度不足；light theme 正常。
- 根因：现有主题 CSS 只提供全局 body/通用前景色，未在章节自然样式与有效 alpha 背景合成后识别“主题前景撞上浅色 author box”的局部对比度问题。
- 约束：只处理 dark theme、当前章节 iframe load 后且首次测量前一次；对 background-image、未知颜色/合成、opacity<1、作者明确不同颜色保守跳过；不改显示门/分页顺序，不按书名/class 特判。
- 选择的修复：新增 `darkThemeContrast` 纯逻辑+DOM adapter，解析 RGB/RGBA/hex，递归合成祖先背景并按 WCAG contrast 计算；仅当 computed 前景近似主题 `rgb(212,212,212)`、当前 `<4.5` 且候选 `#1a1a1a` 显著改善时写普通优先级 inline color 与 `data-reader-dark-contrast` marker。背景容器可因子孙文本被修正，透明后代按有效背景判断；marker 随文档替换自然销毁。
- 修改文件：`src/render/darkThemeContrast.ts`、`src/render/darkThemeContrast.test.ts`、`src/render/paginator.ts`、`docs/tasks/active/dark-theme-contrast-guard.md`、`docs/rendering-layers.md`、本记录及契约/源差异文档。
- 验证：darkThemeContrast+paginator 定向 68/68；全量 Vitest 38 文件、341/341；`tsc --noEmit`；Vite production build（100 modules）均通过。Windows WebView2 实机仍待用户确认。
- WSL Chromium 1280×800 实机：目标书 `[简][雨穴].诡屋.02` 资料⑤ 的 light 模式 body/box/p 均为 `rgb(26,26,26)`、box 背景为 `rgba(255,255,255,0.8)`；dark 模式 body 为 `rgb(212,212,212)`、box/p 为 `rgb(26,26,26)`，box 背景保持 `rgba(255,255,255,0.8)`。Vite 验证后已 Ctrl-C 释放 5173；临时 `/tmp/repro-dark-dialog.mjs` 不同步。
- 关联：`docs/tasks/active/dark-theme-contrast-guard.md`、C-42、B-049、B-052。

## B-054/C-43：iframe 脚注 marker 与宿主弹层 hover 交接闪烁

- 状态：代码、自动化与 WSL Chromium 回归完成，待用户/Windows WebView2 审核。
- 发现日期：2026-08-22
- 现象：窄窗口中 iframe 脚注 marker 移向宿主 `FootnotePop` 时，iframe `mouseout` 先到达并立即关闭弹层，随后宿主 hover 又重新显示，产生闪烁；同一仍可见 marker 的重复 mouseover 还会重复解析和发送 payload。
- 根因：iframe 与宿主卡片属于不同 DOM hover 域，原实现没有交接 grace，也没有 gate 层的 visible/pinned/重复显示状态。
- 选择的修复：新增可注入调度器的 `FootnoteHoverGate`，使用 140ms close grace；marker/overlay 任一 enter 取消 timer，两者均离开且未 pinned 才一次性 close。Paginator 先以 `getFootnoteHoverAnchor` 确认当前文档内脚注 anchor，普通正文 mouseover 完全不触碰 gate；随后在 marker、show/click pinned、overlay、dismiss、章节 cleanup/dispose 路径同步 gate。ReaderHandle/App 转发宿主 hover；FootnotePop 仅在真实尺寸变化时更新 size state。
- 约束：固定注释点击、再次点击、关闭按钮、正文空白关闭语义不变；不改 popup CSS、定位算法、分页或 Rust。
- 修改文件：`src/render/footnoteHoverGate.ts`、`src/render/footnoteHoverGate.test.ts`、`src/render/footnotes.ts`、`src/render/footnotes.test.ts`、`src/render/paginator.ts`、`src/ui/ReaderView.tsx`、`src/App.tsx`、`src/ui/FootnotePop.tsx`、`docs/tasks/active/footnote-hover-grace.md`、`docs/rendering-layers.md`、本记录及契约/源差异文档。
- 验证：定向 84/84；全量 Vitest 39 文件、345/345；`tsc --noEmit`；Vite production build（101 modules）均通过。Windows WebView2 窄窗 hover 仍待用户实机确认。
- WSL Chromium 640×480 实机：目标书后记第二页 `note_ref020` 的 marker iframe 为 `x=37.0..51.4`，宿主卡片为 `x=59.4..359.4`，中间 8px gap；marker→card 12 步移动后 250ms 弹层仍 present，`MutationObserver added=1 removed=0`。离开两域 300ms 后 `added=1 removed=1`，恰好关闭一次，页码保持 `2/3`。验证后已 Ctrl-C 释放 5174；临时 `/tmp/repro-footnote-flicker.mjs` 不同步。
- 关联：`docs/tasks/active/footnote-hover-grace.md`、C-43、B-035、B-052。

## B-055/C-44：极窄窗口脚注弹层越界与坐标系错误

- 状态：代码与自动化回归完成，待用户/Windows WebView2 审核。
- 发现日期：2026-08-22
- 现象：脚注 payload 的 rect 是 `.main` 局部坐标，原 `FootnotePop` 却渲染在 `.main` 外并按 app/viewport 坐标绝对定位，漏掉 toolbar offset；640×480、四角 marker 和 UI scale 下弹层可能越界，固定 300px 宽度也可能超过容器。
- 根因：弹层 DOM 坐标系与 marker payload 坐标系不一致，且原定位只偏好右侧/上方，没有容器尺寸、左右/上下完整可见与低高容器约束。
- 选择的修复：新增纯 `placeFootnote` helper，宽度限制为 `min(300, containerWidth-2*gap)`，右/左与上/下按完整可见优先，均不足时选择空间较大方向并 clamp；容器不足输出 `maxHeight=height-2*gap`。FootnotePop 移入 `.main`，读取真实 clientWidth/clientHeight 与 offsetWidth/Height，ResizeObserver/resize listener 仅在变化时更新并 cleanup。
- 约束：保持 z-index 60，不改 B-054 hover gate、分页、Rust；内容仍通过现有 overflow-y 滚动。
- 修改文件：`src/ui/footnotePlacement.ts`、`src/ui/footnotePlacement.test.ts`、`src/ui/FootnotePop.tsx`、`src/App.tsx`、`docs/tasks/active/footnote-placement-narrow-window.md`、`docs/rendering-layers.md`、本记录及契约/源差异文档。
- 验证：定向 92/92；全量 Vitest 40 文件、353/353；`tsc --noEmit`；Vite production build（102 modules）均通过。WSL Chromium 640×480 已由 Root 独立验收；Windows WebView2 UI scale 仍待用户实机确认。
- Root 独立验收：`pnpm exec vitest run` 全量 40 files/353 tests、`tsc --noEmit`、`pnpm build`（Vite 102 modules）均通过。WSL Chromium Tauri minWidth 640×480 下，目标书 `[简][初鹿野創].有谁规定了在现实中不能有恋爱喜剧的？.03` 后记第 2/3 页 `note_ref020` 的 `.main` rect=`0,42,640x417`，card rect=`59.40625,50,300x295.421875`，`fullyInside=true`；card `clientHeight=293/scrollHeight=293`，无截断/内部滚动。marker→card 250ms 为 `added=1 removed=0`，离开两域 300ms 后 `added=1 removed=1`，C-43 未回归。5174 已停止，5173/5174 无监听。
- 关联：`docs/tasks/active/footnote-placement-narrow-window.md`、C-44、B-054/C-43、B-035。

## B-056/C-45：深色主题文字阴影可读性兜底（2026-08-22）

- 状态：代码与自动化回归完成，待用户/Windows WebView2 审核
- 现象：深色模式下，作者浅色盒子、背景图或复杂半透明背景中的默认浅色文字，在对比度扫描保守跳过时仍可能难以阅读。
- 根因：`applyDarkThemeContrast` 对背景图、未知合成、opacity 等情况必须保守跳过；仅调整主题前景色不足以覆盖所有复杂背景。
- 约束：只在 dark theme 注入；使用与深色主题背景一致的 `#1e1e1e`；不使用 `#epub-viewer *` 或 `!important`，不改既有局部对比度逻辑、分页、Rust；light/sepia 不受影响。
- 选择的修复：在章节覆盖样式的 `#epub-viewer` 根容器注入普通优先级 `text-shadow: 1px 1px 1px #1e1e1e`，依靠 CSS 继承作为低侵入兜底。作者后代明确设置的 `text-shadow`（包括 `none`/特效）保持正常级联优先级并可覆盖。
- 修改文件：`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`docs/tasks/active/dark-theme-text-shadow-fallback.md`、本记录及主题/渲染层/源差异文档。
- 验证：`src/render/sanitize.test.ts` 定向 54/54，覆盖作者后代 `text-shadow:none` 与特效声明保留；Root 独立复验全量 Vitest 40 文件/354 tests、`tsc --noEmit`、Vite production build（102 modules）均通过。
- 风险：默认文字会增加一次阴影绘制；不会覆盖作者显式 `text-shadow`，但 Windows WebView2 窄窗、长章节和复杂背景下的观感/性能仍待用户实机确认。
- 关联：`docs/tasks/active/dark-theme-text-shadow-fallback.md`、C-45、B-053/C-42。

## B-057/C-46：竖排 EPUB 无法在横向分页器中阅读（2026-08-22）

- 状态：代码、自动化回归与 Root 独立 WSL Chromium 烟测完成，待用户/Windows WebView2 审核。
- 现象：竖排 EPUB 保留 `vertical-*` 书写模式，现有横向多栏 paginator 无法形成可读的横排内容。
- 根因：阅读器没有一个可持久化的用户覆盖设置；仅修改根容器也不足以覆盖书内嵌套竖排声明。
- 约束：只处理可重排章节；固定版式不改；不改 `direction`、paginator 算法或 Rust；SVG 及其后代不匹配普通后代覆盖选择器，准确保留显式书写模式边界。
- 选择的修复：新增 `ReaderSettings.forceHorizontal`（旧值缺省 false），详细设置加入“强制横排”开关。sanitize 开启时统一注入 `writing-mode: horizontal-tb !important`、`-webkit-writing-mode: horizontal-tb !important`、`text-orientation: mixed !important` 到 html/body/viewer 及非 SVG 树普通后代；ReaderView 对 fixedLayout 屏蔽。
- 修改文件：`src/render/settings.ts`、`src/ui/storage.ts`、`src/App.tsx`、`src/ui/ReaderView.tsx`、`src/ui/MenuPanel.tsx`、`src/styles.css`、`src/render/sanitize.ts`、`src/render/sanitize.test.ts`、`src/ui/menuPanel.test.ts`、`src/ui/storage.test.ts`、`src/ui/readerViewSettings.test.ts`、`src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts` 及相关存档测试、任务与契约/渲染台账文档。
- 验证：定向 sanitizer/菜单/存储/存档 5 文件 73/73；fixedLayout/helper 定向 3 文件 58/58；Root 独立全量 Vitest 42 files/359 tests、`tsc --noEmit`、`pnpm build`（Vite 102 modules）通过。Root 使用临时 `/tmp/vertical-smoke.epub` 在 WSL Chromium 900×650 验证：开启前 html/body/viewer=`vertical-rl`、嵌套 probe=`vertical-lr`、SVG text=`vertical-rl`、页码 1/1；菜单开启并等待 ready 后 html/body/viewer/probe=`horizontal-tb`、`text-orientation=mixed`，SVG 显式 `vertical-rl` 保持，页码仍 1/1，localStorage `forceHorizontal=true`。5174 已停止，5173/5174 无监听；临时 EPUB/脚本不同步。
- 风险：排除 SVG 后，纯粹通过 html/body 祖先继承而未在 SVG 内声明的书写模式无法凭 CSS 恢复；强制横排可能改变含 SVG 图形文字的整体语义。Windows 真实竖排书/WebView2 仍待用户确认。
- 关联：`docs/tasks/active/force-horizontal-reading.md`、C-46、B-056/C-45。

## B-058/C-47：系统字体选择与导入字体启动性能（2026-08-22）

- 状态：前端代码、自动化和 WSL Chromium 验收完成，待 Windows 主机构建与实机枚举审核。
- 现象：自定义字体列表直接嵌入菜单，字体较多时列表渲染和启动阶段逐个读取字体文件；用户无法选择已安装的 Windows 系统字体。
- 根因：字体选择没有区分 system/imported 来源，启动链路把导入字体元数据和二进制资源一起加载，缺少独立搜索/虚拟列表界面。
- 选择的修复：新增 `fontSource`/`customFontId` 模型和独立 FontSettingsPanel；Windows/Tauri 通过 `system_fonts_list` 获取 DirectWrite 的 family/localizedNames（无路径、无系统字体文件读取），首次打开面板才枚举并会话缓存。导入字体启动只列元数据，当前选中项才读取一个 Blob URL；懒加载控制器防止竞态，成功创建新 URL 后释放旧 URL，失败保留旧 URL。
- 约束：系统字体不存在/枚举失败时保留持久化偏好并在面板标记不可用；非 Windows 系统字体列表为空；Android 仅预留接口。CSS family 转义反斜杠、双引号和 CR/LF/form-feed。面板使用 tabs、搜索和带 spacer 的固定行高虚拟窗口；z-index 面板 42、backdrop 41。
- 修改文件：`src/ui/fontStore.ts`、`src/ui/fontRuntime.ts`、`src/ui/FontSettingsPanel.tsx`、`src/ui/MenuPanel.tsx`、`src/App.tsx`、`src/render/settings.ts`、`src/render/sanitize.ts`、`src/ui/storage.ts`、`src/ui/libraryArchive.ts`、`src/ui/libraryArchiveBridge.ts`、`src/styles.css` 及对应字体/存档/sanitize 测试；详见 `docs/tasks/active/font-center-system-fonts.md`。
- 验证：Root 独立前端全量 Vitest 44 files/365 tests、`tsc --noEmit`、Vite 104 modules。WSL Chromium 900×650 模拟 300 imported：启动 binary get=0（StrictMode metadata getAll=2）、末尾 DOM rows=9 且末项 Font299、选择后 binary get=1、panel z42/backdrop z41/hitInside=true、设置 source/imported 与 id 012b。最终动态视口补测（900×900）得到实际 viewportHeight=292、末尾仅挂载 13 行，搜索 Font001 后 DOM scrollTop=0；补丁后定向 4 文件 63/63、tsc 与 Vite 再次通过。5173/5174 无监听，临时脚本数据未入项目。
- 依赖/许可：Windows `windows` 0.61.3 目标依赖记录为 MIT OR Apache-2.0，无 GPL；DirectWrite 是 Windows 系统 API。Android 仅接口预留。
- 风险：Linux 无 Windows target；已核对 windows-rs 生成签名并修复 `GetSystemFontCollection` 输出参数，但仍必须在 Windows 主机执行 `cargo check`/`tauri build` 和实机系统字体枚举；大量系统字体、本地化 CSS family 与 WebView2 观感待确认。
- 关联：`docs/tasks/active/font-center-system-fonts.md`、C-47、B-057/C-46。

## B-059/C-48：当前书正文基础搜索（2026-08-22）

- 状态：代码、自动化和 WSL Chromium 实机回归完成，待用户确认交互与 Windows WebView2 实机表现。
- 目标：为当前打开的可重排 EPUB 提供第一版正文搜索，建立后续跨书检索/RAG 可复用的文本范围与锚点边界；本项不扩大到跨书、持久化索引或模型功能。
- 选择的实现：新增按需、按 spine 顺序处理的当前书 `SearchSession`，在本次书籍会话缓存章节语料；每章处理后让出主线程并上报进度。标准化使用 NFKC、小写、软连字符移除和布局空白处理，块级元素形成上下文边界，排除隐藏结构、脚本样式和脚注。查询支持标准化短语及同段落/上下文内多关键词 AND，短语优先去重。
- 交互边界：查询使用 180ms debounce，支持 AbortController 取消与 generation 防旧任务回写；结果最多保留 101 条，UI 最多展示 100 条。结果展示章节名、上下文和原文高亮；点击才使用现有 code-point 文本锚点跳转并记录最多 3 步历史，预览不写阅读进度。跨章服从 display gate，同章优先 direct 定位；fixed-layout 不显示入口。
- 约束：不生成磁盘全文索引、不进入存档、不跨书搜索；暂不实现 OR/前缀/邻近、编辑距离、简繁/假名归一化、语义搜索、标签或 RAG。
- 性能实现：标准化正文使用紧凑字符串；标准化 UTF-16 单元到 code-point、原文范围和锚点偏移使用 `Uint32Array`，避免逐字符 JavaScript 对象。每条结果只从命中原文位置扫描最多 32 个 code point 生成锚点片段，不重复拆分整章。
- 修改文件：`src/core/search.ts`、`src/core/search.test.ts`、`src/ui/SearchPanel.tsx`、`src/ui/SearchPanel.test.ts`、`src/App.tsx`、`src/ui/Toolbar.tsx`、`src/styles.css`，以及 `docs/tasks/active/reader-text-search.md`、契约/交接文档。
- 验证：全量 Vitest 46 files/377 tests（搜索核心 8/8）、`tsc --noEmit`、Vite build（106 modules）通过。WSL Chromium 900×650 使用《ePub指南——从入门到放弃 20230418.epub》搜索“opacity 属性”得到 4 条结果并正确高亮 `opacity属性`；点击后 back 可用，back 后 forward 可用，forward 返回正文仍含 `opacity`。临时脚本/书籍未同步，5173 已释放。
- 关联：`docs/tasks/active/reader-text-search.md`、`docs/SEARCH_TO_RAG_ROADMAP.md`、C-48。

## B-060/C-49：正文选区笔记首版（2026-08-23）

- 状态：代码、自动化和 WSL Chromium 实机回归完成，待用户/Windows WebView2 审核。
- 实现：正文有效选区的原生右键菜单替换为“复制/添加笔记”；创建与编辑弹窗保存想法，本书笔记页按时间倒序显示并支持编辑、删除、文本锚点跳转。跳转接入既有三步撤销/前进。
- 排版边界：当前章节通过 CSS Custom Highlight 绘制主题适配下划线，不插入 span、不修改 EPUB DOM、不重排；无 API 时保留数据但不画线。
- 存储：ShelfEntry、IndexedDB、Tauri Rust 链接书库及 portable archive 均保存/校验/合并 notes；不保存设备路径。
- 验证：Vitest 50 files/393 tests、tsc、Vite 110 modules、Rust fmt/tests 18/18。WSL Chromium 900×650 真实链路中 Highlight size=1、原生选区清除，保存前后 scrollWidth=900，列表和跳转/后退可用；5173 已释放。
- 关联：`docs/tasks/active/reader-notes.md`、C-49。

## B-063：书架二级菜单滚动区未占满高度（2026-08-23）

- 现象：书架二级菜单内容较短、窗口纵向空间充足时，打开主题下拉偶尔出现滚动条；滚动条轨道只到“数据管理”下方，没有贯穿菜单剩余高度。
- 根因：抽屉本身是纵向 flex，但 `.shelf-drawer-scroll` 只有 `min-height:0; overflow:auto`，没有参与剩余空间分配，因此按约 413px 的内容高度收缩，而不是占满固定标题栏以下空间。滚动条属于这个短内容区，轨道自然提前结束；下拉绝对定位溢出又可能触发它。
- 修复：为滚动区增加 `flex:1 1 auto`，保留 `min-height:0` 和 `overflow:auto`。内容短时滚动区扩展到抽屉底部且不滚动；内容长时仍由同一完整高度区域滚动。不改下拉定位、筛选逻辑或抽屉动画。
- 验证：新增 CSS 契约测试；前端全量 52 files/406 tests。Chromium 800px 高窗口中，主题下拉前后 `clientHeight=scrollHeight=730`；480px 窗口中可用滚动区为 410px，真实轻微溢出时轨道仍覆盖完整区域。5173 已释放。
- 关联：`docs/tasks/active/shelf-filter-drawer.md`、B-062/C-51。

## B-064：书架抽屉搜索图标与提示文字重叠（2026-08-23）

- 现象：“搜索书名或作者”的左侧图标压住提示文字，图标尺寸偏小且没有在输入框中正确垂直居中。
- 根因：输入同时使用 `.shelf-drawer-search` 与 `.shelf-search`；后定义的单类通用规则以同等 specificity 覆盖抽屉专用的左右 padding，使文字从 12px 开始而进入图标区域。
- 修复：用 `.shelf-drawer-search-wrap .shelf-drawer-search` 明确抽屉作用域；输入框高度 42px、左 padding 42px、字体 14px；图标改为 20×20 inline-flex、21px 字号并以 `top:50%/translateY(-50%)` 居中。
- 验证：CSS 契约 2/2、TypeScript、全量 Vitest 52 files/407 tests。Chromium 760×620 实测输入高 42px、图标 20×20、垂直中心偏差 0，图标右缘 49px、文字起点 58px，间隔 9px。5173 已由用户关闭并确认释放。
- 关联：`docs/tasks/active/shelf-filter-drawer.md`、B-063。

## B-065：搜索字符盒居中但字形视觉偏移（2026-08-23）

- 现象：B-064 后图标元素边界与输入框几何中心一致，但 Windows 截图中的放大镜图案仍明显没有视觉居中。
- 根因：原图标是文本字符 `⌕`。不同系统字体对该字符使用不同基线、advance box 和内部留白；flex 居中只能居中字形盒，无法保证盒内实际墨迹居中。
- 修复：用内联 SVG circle/path 替代文本字符，固定 24×24 viewBox、18×18 显示尺寸和 1.8px 圆角描边；SVG 为 block，不参与文字基线布局。
- 验证：抽屉 CSS 契约 2/2、TypeScript 通过。Chromium deviceScaleFactor=2 截图视觉居中，输入框与 SVG 的中心 y 均为 105、偏差 0。临时脚本/截图删除，5173 已释放。
- 关联：`docs/tasks/active/shelf-filter-drawer.md`、B-064。

## B-066：筛选展开时滚动条导致选项横向缩窄（2026-08-23）

- 现象：点击“全部书籍”后内容超过抽屉高度，纵向滚动条出现并临时占用内容宽度，使选项框相较展开前变窄、产生横向跳动。
- 根因：滚动区只在实际 overflow 时分配滚动条槽；展开前后的可用 inline size 不一致。
- 修复：为 `.shelf-drawer-scroll` 增加标准 `scrollbar-gutter:stable`，从抽屉打开时就预留单侧滚动槽。初始内容略窄，但展开/收起宽度稳定。
- 验证：CSS 契约 2/2、TypeScript。Chromium 760×620 中展开前 `clientHeight/scrollHeight=550/550`，展开后为 `550/608`；两个状态下 scroll clientWidth 均 379px、全部书籍卡片均 347px。临时脚本删除，5173 已释放。
- 关联：`docs/tasks/active/shelf-filter-drawer.md`、B-063。

## B-067：阅读器菜单展开后滚动条导致选项横向缩窄（2026-08-23）

- 状态：已修复，归入 `0.1.9-beta.1`，不回写正式 0.1.9 发布范围。
- 现象：阅读器菜单初始内容未溢出时没有纵向滚动条；展开“详细设置”后出现滚动条并占用内容宽度，所有设置卡片突然变窄。
- 根因：`.menu-panel` 直接承担纵向滚动，只在实际 overflow 时由 Chromium 分配滚动条槽，展开前后的可用 inline size 不一致。
- 修复：为 `.menu-panel` 增加 `scrollbar-gutter:stable`，菜单打开时便预留单侧滚动槽；不改变菜单固定宽度、缩放、详细设置结构或滚动行为。
- 验证：菜单 CSS 契约 8/8、`tsc --noEmit` 通过。应用内浏览器连接被 WSL 工作目录元数据拒绝，未把该环境失败记为产品失败；Windows WebView2 展开前后视觉留待 beta.1 实机验收。
- 关联：B-066（书架抽屉同类问题）。

## B-068：Windows 发布版正文搜索始终无结果（2026-08-23）

- 状态：代码与自动化修复完成，归入 `0.1.9-beta.1`；待 Windows WebView2 发布包复验。
- 现象：Windows 发布版的搜索按钮、面板和输入均正常，但任意关键词均返回空结果；同一书在 WSL `pnpm dev` 的 Chromium 中可以搜索。
- 根因判断：搜索提取器此前把 EPUB XHTML 无条件作为 `text/html` 解析。HTML 规则不承认一般 XML 自闭合标签，不同版本 WebView2 可能把 `<head>` 内自闭合结构错误延伸并吞入后续 body，使提取正文为空；渲染主链路本来已经使用 XML 优先策略，搜索链路没有同步该契约。
- 修复：新增 `extractSearchText()`，有效 XHTML 优先使用严格 `application/xml`；只有检测到 parser error 才退回宽松 `text/html`，继续兼容不规范旧书。搜索缓存、查询算法、结果上限和跳转锚点均不改变。
- 验证：新增有效 XHTML 自闭合 head 标签及畸形旧 HTML fallback 两项回归；全量 Vitest 52 文件/410 用例、TypeScript 与 Vite production build（110 modules）通过。Windows 发布包仍需用户用原故障书确认。
- 关联：`docs/tasks/active/reader-text-search.md`、B-059/C-48。

## B-069：正文选区右键菜单位置错误且无法随正文点击关闭（2026-08-23）

- 状态：代码与自动化修复完成，归入 `0.1.9-beta.1`；待 Windows WebView2 实机复验。
- 现象：多行选中文本后菜单长期靠在阅读区右侧，没有贴近所选文本末端；在 iframe 正文中左键取消选区后菜单仍残留，表现为无法关闭。
- 根因：选区坐标使用所有 `Range.getClientRects()` 的联合包围盒，跨行/跨列时 `right/bottom` 不是文本终点；菜单的外部 pointer 监听位于宿主 document，无法接收 iframe 内事件；菜单打开后也没有监听 iframe `selectionchange`。
- 修复：选区 payload 改用 Range 最后一个可见片段矩形；菜单边缘翻转以锚点为基准放到左侧/上方，而不是钳制到视口固定边缘；分页器仅在菜单已打开时监听 selectionchange，选区变化则重发最新末端坐标，选区折叠/无效则发送 null 关闭。Escape/宿主外部关闭同时清除 iframe 选区并结束该生命周期。
- 性能边界：普通选择期间不建立额外索引、不持续回调；只有有效右键菜单已经打开时才处理 selectionchange，并复用当前章节文本索引。
- 验证：新增多行选区末端矩形回归并更新边缘翻转回归；定向 3 文件/16 用例，全量 Vitest 52 文件/411 用例、TypeScript 与 Vite production build（110 modules）通过。
- 关联：`docs/tasks/active/reader-notes.md`、B-060/C-49。

## B-070：Windows 搜索输入框出现两个清除按钮（2026-08-23）

- 状态：代码与自动化修复完成，归入 `0.1.9-beta.1`；待 Windows WebView2 视觉复验。
- 现象：搜索框输入文字后右侧同时出现 WebView2 原生 `type=search` 清除按钮和应用自定义清除按钮；二者都能清空，但只有最右侧自定义按钮使用应用交互样式。
- 根因：`SearchPanel` 有意提供自定义清除按钮，但 CSS 未屏蔽 Chromium/WebView2 为 search input 自动生成的 cancel/decoration/results 控件。
- 修复：定向隐藏 `.search-input` 的四类 WebKit search 伪元素，只保留带主题 hover 的自定义按钮；输入容器与输入框补齐 `width/max-width/min-width` 收缩边界，右 padding 增至 40px，自定义按钮提升层级。
- 长文本行为：维持原生单行输入和内部水平滚动；查询不会撑宽搜索面板，文本不会进入清除按钮的 40px 安全区，按钮始终可点击。不截断或修改实际查询值。
- 验证：Luna High 完成实现与 SearchPanel 定向 7/7；主代理复核后全量 Vitest 52 文件/414 用例、TypeScript 与 Vite production build（110 modules）通过。
- 关联：`docs/tasks/active/reader-text-search.md`、B-068。

## B-071/C-52：阅读器多个前台界面可同时叠加（2026-08-23）

- 状态：重构、自动化与生产构建完成，归入 `0.1.9-beta.1`；待 Windows WebView2 实机验收。
- 现象：菜单、目录、书签、搜索、笔记、日志、脚注、选区菜单和笔记编辑分别使用独立 state；各入口手工关闭的对象不一致，多个界面可同时存在，再由不统一的 z-index 相互覆盖。
- 根因：前台归属没有单一真源。新增功能必须记住所有既有 setter，遗漏即产生叠层；Escape、backdrop、导航和 iframe 回调也各维护一份不完整关闭列表。
- 修复：新增可扩展 `ReaderForeground` 判别联合及纯转换函数，统一表达 none、普通 panel、正文 transient 和 modal；App 移除九组独立前台状态，从 foreground 派生所有可见性。字体中心成为 menu 子视图，笔记编辑器 modal 拒绝后台入口并用 fixed 遮罩覆盖完整应用。
- 副作用边界：统一入口在替换脚注时同步 dismiss/hover reset，替换选区时清除 iframe selection；切书、回书架、Escape 和 backdrop 统一关闭。目录连续选择、搜索结果保留、书签/笔记跳转仍保持既有产品语义。
- 扩展契约：以后新增普通前台功能扩展 `ReaderPanelId` 和对应 renderer/入口即可，禁止恢复 `xxxOpen` boolean 或依靠 z-index 实现业务互斥。
- 验证：Luna High 完成状态模型与 App 迁移，定向 4 文件/16；主代理审核补充全窗口 modal 遮罩。最终全量 Vitest 53 文件/420 用例、TypeScript 与 Vite production build（111 modules）通过。
- 关联：`docs/tasks/active/reader-foreground-arbitration.md`、B-054/B-060/B-069。

## B-072：Windows 跨书建库看似完成但任意查询均无结果（2026-08-24）

- 状态：根因确认并修复，自动化通过；待 Windows 用原书库重新建库复验。
- 现象：选择“全部书籍”后能看到逐本建库进度，完成后输入任意正文均无结果。
- 证据：Windows 实际 `<AppData>/Roaming/dev.epubreader.app/ai/ai.sqlite3` 已创建且 schema 为 v3，但 `books`、`chunks`、`chunk_fts` 均为 0；本机 linked-library 的旧记录普遍保存 `language: ""`。
- 根因：C-54 将 ShelfEntry 的可选语言原样发送给 staging；旧记录用空字符串表达未知语言，Rust 却把 `Some("")` 作为非法非空字段拒绝。多书执行器按设计隔离失败并继续下一本，App 又在全部失败后无条件切到 `ready`，共同造成“有进度、无索引、无错误”的伪成功。
- 修复：前端 staging/replace 边界将空白语言省略，Rust 再将空白可选语言规范化为 `NULL`；如果本轮没有任何成功或可跳过的索引且存在失败，App 保持 error 并展示首个失败原因。
- 数据边界：无需迁移或删除书架；现有 AI 数据库是可重建缓存且当前为空。安装新构建后重新选择“全部书籍”即可写入索引。
- 验证：indexing 定向 16/16；全量 Vitest 63 files/465 tests、TypeScript、Vite production build 126 modules、Rust fmt 与 37/37 tests 全部通过。
- 关联：C-54、`docs/tasks/active/cross-book-fts-search.md`。

## B-073：修复空语言后全书仍因“无效的正文”建库失败（2026-08-24）

- 状态：根因确认并修复，自动化及真实测试书语料回放通过；待 Windows 重新建库复验。
- 现象：B-072 后建库越过语言校验，但全部 33 本又以“无效的正文”失败。
- 根因：图片封面页的 XHTML 只有 SVG/image 和缩进换行。`extractVisibleCorpus()` 的注释与设计要求空块不入库，但其 flush 仅判断字符串非空；换行/空格字符串因此被切成 `originalText` 全空白、`normalizedText` 为空的 chunk，随后被 Rust 正确拒绝。几乎每本 EPUB 都有封面，所以表现为全库失败。
- 修复：语料提取和 `createCorpusChapter()` 双层丢弃规范化后为空的块；图片-only 章节产生零 chunk 的 batch，建库继续后续章节。没有放宽 Rust 非空校验。语料解析版本由 `visible-xhtml-v1` 升至 `visible-xhtml-v2`，已有索引会按派生数据版本自动重建。
- 验证：目标《EPub指南——从入门到放弃》由封面首块失败恢复为 568 个有效 chunk；Windows 测试目录 37 本全部回放，共 3094 chunks，无空正文/非法正文。定向 5 files/24 tests、全量 Vitest 63 files/467 tests、TypeScript、Vite 126 modules、Rust fmt 与 37/37 tests 全部通过。
- 关联：B-072、C-54、`docs/tasks/active/cross-book-fts-search.md`。

## B-074/C-55：全库搜索误触发建库、取消按钮漂移及异常退出恢复（2026-08-24）

- 状态：代码、自动化与生产构建完成；待 Windows WebView2 人工验收。
- 现象：切换到“全部书籍”会立刻扫描整库；进度书名变化时取消按钮随之移动；关闭应用后未完成任务缺少明确恢复语义。
- 修复：首次进入只读取索引状态，显示硬件/耗时提示，用户确认后才读取 EPUB；进度与当前书名、固定取消区分栏，取消进入明确的“正在停止”状态并等待当前 read/parse/staging 收口，不再启动下一本。
- 恢复边界：每本书以 staging 原子提交；正常完成的书立即保留，正在处理的半本书在取消或下次启动时回收。持久任务按完成书本更新；异常退出会标记为已回收，重新进入时显示部分索引并只补缺失或版本过期的书。
- 缓存边界：新增统一派生缓存契约与 `full-text-index` 类别，状态可报告条目数、体积、更新时间与构建状态；清理只删除全文索引、暂存数据及对应任务，不影响 EPUB、书架、进度、书签、笔记和 Provider 配置。本轮没有在书架增加缓存清理入口。
- 搜索一致性：部分索引可立即使用，但查询强制匹配当前 parser/normalizer/chunker 版本，避免旧缓存混入；持久任务进度只在完成一本书时写入，避免章节级高频数据库更新。
- 验证：前端 66 files/485 tests、TypeScript、Vite production build 通过；Rust fmt 与 38/38 tests 通过。
- 关联：C-54、`docs/tasks/active/cross-book-fts-search.md`。

## C-57：字体设置支持拖动批量导入（2026-08-24）

- 状态：代码与自动化完成，待 Windows WebView2 实机验收。
- 实现：浏览器字体面板接入 HTML5 drop；Windows 使用现有 Tauri 原生拖放事件，按物理坐标与设备缩放判断面板命中，并通过 fs 插件读取路径。两端均复用原有哈希、`FontStore` 与字体选择链路。
- 性能与冲突边界：多字体严格串行，格式判断先于文件读取，同步 busy gate 防止批次并发；字体面板内阻止全局 EPUB drop，面板外维持 EPUB 导入。
- 交互：拖入使用深度计数防止子元素切换闪烁，提供主题色虚线高亮、导入中状态和可访问提示；混合文件报告成功与忽略数量。
- 验证：字体拖放 helper 5/5；全量 Vitest 73 文件/509 用例、TypeScript、Vite production build（137 modules）通过。
- 关联：`docs/tasks/active/font-drag-import.md`、B-058/C-47。

## B-075：Tauri 开发版模型资产面板永久停在“读取中”（2026-08-24）

- 状态：根因确认并修复，自动化通过；待 Windows Tauri dev 复验。
- 现象：打开“AI 与模型（开发）”后一直显示“读取中”，模型库仍显示未设置，刷新、选择模型库、linked 导入和登记测试包全部被禁用。
- 根因：React 开发 Strict Mode 会对 effect 执行一次 setup → cleanup → setup 探测。第一次 setup 已将 controller 置为 loading/busy，cleanup 又永久 dispose 这个由 `useMemo` 保留的实例；第二次 setup 因 disposed/inFlight 直接返回，旧请求也因 generation 失效不能收口 UI。Rust IPC 和模型数据库不是此次卡死的根因。
- 修复：controller 允许 dispose 后由下一次 `start()` 建立全新 generation；dispose/重启重置旧 in-flight gate，所有旧请求的 publish/finally 都受 generation 保护，不能覆盖或解锁新一轮状态；真实卸载仍停止轮询。
- 验证：新增 `start → dispose → 立即 start` 回归，覆盖第二轮正常结束和第一轮迟到响应不覆盖；模型 controller 定向 6/6，全量 Vitest 77 files/521 tests，TypeScript 通过。Rust 未修改。
- 关联：RAG C-57、`docs/tasks/active/rag-model-asset-management.md`。

## B-076：Windows 开发探针下载请求失败（2026-08-24）

- 状态：根因确认并修复，Rust 自动化通过；待 Windows Tauri dev 复验。
- 现象：`c57-dev-probe` 登记成功，但下载立即 failed，0/15 bytes，Rust 报 `error sending request for url (http://127.0.0.1:5173/...)`。
- 根因：Tauri `devUrl` 是 `http://localhost:5173`，开发 catalog 却硬编码 `127.0.0.1`。Windows 上 Vite 可能只绑定 localhost 解析出的 IPv6/特定接口，应用页面可用不代表独立的 IPv4 loopback 地址也在监听。
- 修复：固定探针来源与 `devUrl` 统一为 `http://localhost:5173/c57-dev-probe`；重新登记开发 catalog 会事务性替换旧 `model_sources`，已有 failed 任务保持可重试，不要求清理 AI 数据库。
- 边界：只改变 debug fixture 的本地来源，不改变正式模型下载源、网络策略、模型资产所有权或 Provider/能力插件接口。
- 验证：Rust fmt/check 与 71/71 tests 通过；新增旧来源失败→重新登记→来源替换→任务重新排队回归。
- 关联：RAG C-57、B-075、`docs/tasks/active/rag-model-asset-management.md`。

## B-077：Windows 点击模型校验导致原生进程栈溢出（2026-08-24）

- 状态：根因确认并修复，Rust 自动化通过；待 Windows Tauri dev 复验。
- 现象：15 字节开发探针下载成功，点击“校验”后应用立即退出，状态码为 `0xc00000fd / STATUS_STACK_OVERFLOW`。
- 根因：模型资产 `sha256_file` 在 Tauri command 调用栈上声明了 1 MiB 局部数组；Windows 应用线程默认栈通常也约为 1 MiB，加上校验调用链后在读取文件前即耗尽栈空间。路径、reparse 检查和 SQLite/serde 链路均无递归。
- 修复：保持流式 SHA-256 语义，将缓冲改为256 KiB `Vec` 堆分配；没有把完整模型读入内存，也不改变 digest、Provider 或下载行为。
- 验证：新增256 KiB小栈线程读取已知文件并核对 SHA-256 的专项回归；Rust fmt/check 与72/72 tests 通过。
- 关联：RAG C-57、B-076、`docs/tasks/active/rag-model-asset-management.md`。

## B-078：删除模型后遗留历史下载 staging（2026-08-24）

- 状态：代码与自动化修复完成，待 Windows Tauri dev 复验。
- 现象：删除已安装模型后正式包目录消失，但 `.staging` 下仍保留此前失败任务的空目录；这些不是模型文件，却会随着历史失败任务逐渐积累。
- 根因：旧删除链路先删除 `model_packages`，数据库通过外键级联同时丢失历史任务 ID，却没有在此之前清理 `<root>/.staging/<package>-<task>`。
- 修复：删除命令在 `BEGIN IMMEDIATE` 临界区重新检查活动任务，从数据库取得该 package 的精确历史 task IDs，逐项经过 symlink/reparse/越界防护清理 staging；全部成功后才删除正式 managed 目录和数据库记录。保留 `.staging` 根目录，不使用 glob/前缀扫描，linked 外部文件永不删除。
- 失败与竞态：queued/downloading/verifying 存在时拒绝删除且不清 staging；任一 staging 安全检查或删除失败时事务回滚并保留 package/任务记录。paused/failed/cancelled/completed 的历史 staging 可清理。
- 验证：覆盖多状态历史任务、无目录幂等、相似前缀及其他包不受影响、活动任务拒绝、linked 外部目录保留；Rust fmt/check 与74/74 tests 通过。
- 关联：RAG C-57、B-077、`docs/tasks/active/rag-model-asset-management.md`。

## B-079：Windows 短路径别名导致模型临时目录被误判为越界（2026-08-27）

- 状态：根因确认、代码与自动化修复完成；待 Windows Tauri 在真实 D 盘/中文路径下复验。
- 现象：AI feature 的 Windows 测试在创建模型下载 staging 时报告“模型临时目录越出 staging 根目录”；目录实际上位于正确根目录内。
- 根因：安全检查先 canonicalize 根目录，使 Windows 的 8.3 短路径别名展开为长路径，却继续用尚不存在目标的词法短路径执行 `strip_prefix`。两条路径指向同一位置但字符串前缀不同，因此被错误判定为越界。
- 修复：先 canonicalize 根目录，并从目标向上寻找最近存在的祖先；canonicalize 该祖先后验证其仍在根目录内，再逐级检查已有组件的 symlink/reparse point 和剩余词法路径。staging 创建函数返回经验证的 canonical 路径，仍拒绝 `..`、盘符/根前缀及真实越界路径。
- 边界：没有放宽模型库写入范围，也没有关闭 junction/reparse 防护；只消除同一路径的 Windows 别名误报。Core edition 不编译模型下载模块，不受运行时影响。
- 验证：新增不存在目标、真实越界和跨平台绝对路径回归；Windows Cargo Core 38/38、AI 72/72 tests 通过，Rust fmt/check 通过。
- 关联：RAG C-57、C-57.5、B-078、`docs/tasks/active/core-ai-edition-split.md`。

## B-080：Windows Core/AI 前端包装命令无法启动 pnpm.cmd（2026-08-28）

- 状态：根因确认并修复；WSL Core/AI真实包装命令通过，待Windows原命令复验。
- 现象：`pnpm build:core`和`pnpm build:ai`进入`build-frontend.mjs`后，以`spawnSync pnpm.cmd EINVAL`立即失败；随后独立运行产物门禁只会报告`dist/core`或`dist/ai`不存在。
- 根因：跨平台Node wrapper在Windows中再次把`pnpm.cmd`作为`spawnSync`可执行文件直接启动；该调用组合会被Windows Node拒绝，TypeScript和Vite实际都没有开始运行。后续missing dist只是连锁结果。
- 修复：wrapper不再嵌套调用pnpm。它统一使用当前`process.execPath`直接运行项目内的TypeScript、Vite、Tauri CLI和产物验证脚本；edition环境、参数及子进程退出码继续沿用原契约。
- 边界：不修改依赖版本、Vite产物内容、Tauri feature、edition身份或Windows构建脚本；`pnpm test`原本正常的链路不受影响。
- 验证：WSL依次执行`pnpm build:core`与`pnpm build:ai`，各150 modules并通过对应产物门禁；直接Node调用本地Tauri CLI返回`tauri-cli 2.11.4`。Windows仍需用户同步单个修复后复跑原四条命令。
- 关联：C-57.6、`docs/tasks/active/core-ai-release-hardening.md`。

## B-081：Tauri 2.11 dev/build拒绝Cargo专用参数（2026-08-28）

- 状态：根因确认并修复；Tauri 2.11四组参数解析通过，待Windows Tauri dev/正式打包复验。
- 现象：B-080修复后`pnpm tauri:dev:core`可以启动本地Tauri CLI，但立即报告`unexpected argument '--no-default-features'`，应用和开发服务器均未启动。
- 根因：`--no-default-features`是Cargo参数，Tauri 2.11的`dev`与`build`子命令只暴露`--features`，并不接受该标志；原wrapper和PowerShell发行脚本把Cargo参数直接放进Tauri CLI参数层。
- 修复：Tauri dev与build只传`--features core|ai`和对应config。Cargo清单已经固定`default=[]`，因此实际激活集合仍只有显式edition feature；`EPUB_READER_EXPECTED_EDITION`继续由`build.rs`校验，未来若默认错误加入另一edition会因feature冲突或mismatch失败。
- 边界：直接调用Cargo的测试/检查仍可保留`--no-default-features`；此次只修正Tauri CLI层，不改变Cargo feature定义、前端edition、identifier或产物目录。
- 验证：本地Tauri 2.11.4的`dev/build --features core|ai --config ... --help`四组均退出0；非法旧参数已从wrapper和Windows发行脚本移除。真实Windows窗口与NSIS仍待用户复验。
- 关联：B-080、C-57.6、`docs/tasks/active/core-ai-release-hardening.md`。

## B-082：高性能模式修改设置后下一 HTML 使用旧主题/字号（2026-09-11）

- 状态：已修复并通过本地回归；待 Windows 原书复验。
- 现象/触发：在目录章切换深浅主题、字号、字体后顺序翻章；设置防抖期间快速换章，或设置与章节在同一批更新中变化。
- 根因：ReaderView 的 paginator/display-ready 回调跨 render 存活，后台构造闭包捕获首次 renderSettings。章节 effect 取消设置防抖后没有把新设置交给 load，且 ready 缓存没有设置身份校验。
- 约束：保留三槽、完整显示门、稳定内容锚点、显式跳转边界和共享资源释放顺序；开关模式本身不增加章节重载。
- 修复：槽位记录实际 renderSettings；构造、调度和提升读取/核对最新设置；loading/measuring/error 撤销 ready。LoadOptions 接收可选 settings，让替代防抖的章节加载同时应用新设置。
- 选择原因：在产生/消费缓存的位置维护一致性，覆盖普通和快速操作时序；不加入额外 reload、延时猜测或 CSS 覆盖补丁。
- 修改：`src/ui/ReaderView.tsx`、`src/render/paginator.ts`、`src/ui/ReaderView.preload.test.ts`、共享 React 测试 harness。
- 验证：三个原始时序测试修复前均失败；修复后四项生命周期测试通过，包含连续设置及新字体资源。Chromium 合成三章 EPUB：目录→深色/24px→下一章，浅色/18px→下一章/回翻均核对正文 computed style 和 iframe 可见性；无 pageerror。
- 剩余：Windows WebView2、用户原 EPUB 及大图片章性能待复验。
- 关联：C-50、`docs/tasks/active/core-reader-fixes-september.md`。

## B-083：选区菜单“添加笔记”刚打开就被关闭（2026-09-11）

- 状态：已修复并通过本地回归；待 Windows 复验。
- 现象/触发：选中文字后右键，点击添加笔记，没有可用的编辑框。
- 根因：菜单先 onAddNote（打开 modal）、再 onClose（前台状态设 none）；React 同批更新后关闭动作覆盖新 modal。
- 约束：继续使用 ReaderForeground 的唯一前台仲裁，不增加独立弹窗状态，不改笔记锚点或存储格式。
- 修复：先关闭选区菜单，再把已保存的选区 payload 交给添加笔记回调。
- 选择原因：修复交接顺序；不以延时打开或提高 z-index 掩盖状态覆盖。
- 修改：`src/ui/ReaderContextMenu.tsx`、`src/ui/ReaderContextMenu.interaction.test.ts`、`src/test/reactDomHarness.ts`。
- 验证：真实 React 点击测试修复前最终为 none、修复后为 composer；Chromium 实际选区→右键→添加→输入→保存→书架重开→笔记列表→编辑保存通过。
- 剩余：Windows 原生右键/WebView2 的实际操作待复验。
- 关联：C-49/C-52、`docs/tasks/active/reader-notes.md`、基础修复任务。

## B-084：删除已索引书籍耗时长并阻塞窗口（2026-09-11）

- 状态：已修复清理路径并通过本地回归；Windows 实际书库耗时待复验。
- 现象/触发：用户确认主要是从书架删除已经建立全文索引的书籍。批量删除更慢。
- 根因：同步 Tauri 命令在 UI 线程执行 SQLite/文件清理；逐本调用导致重复扫描 FTS 的 UNINDEXED content_hash、逐次提交和重写书架 JSON。即使已无其他书的索引，FTS 仍逐段分词删除。
- 约束：原 EPUB 不删除；未建过索引的库不创建 DB；其他书、staging、任务和模型数据不误删；Core v3/AI v6 数据格式不变。
- 修复：单本/批量入口共享 blocking worker；新增批量 IPC，一次验证完整选择集、一次 SQLite 清理事务、每份书架 JSON 保存一次。临时指纹集合避免绑定参数上限与逐本扫描；最后一本/全部索引被选择时，核对包括遗留 FTS 行在内没有其他数据后，在同事务中重建相同空 FTS 表。前端只隐藏成功项，失败不自动重试逐本删除。
- 选择原因：后台执行解决 UI 阻塞，批量减少重复工作，最后索引快速路径避免重分词。未采用异步“假成功”、遗留索引延后清理、全库 VACUUM、依赖 chunks/FTS rowid 相等或新 schema 迁移。
- 修改：`src/App.tsx`、`src/ui/shelf.ts` 及删除/IPC 测试，`src-tauri/src/linked_library.rs`、`lib.rs`、`ai/mod.rs`、`ai/store.rs`。
- 验证：Rust 覆盖重复/空/非法 hash、其他书/staging/jobs 保留、rowid 不一致、清理失败回滚、遗留 FTS 行保护、清空后重建和 schema 版本不变；原无 DB 副作用测试继续通过。前端覆盖单次批量 IPC、浏览器部分失败保留、原生失败不循环重试。
- 性能：WSL 同盘复制的约 193 MiB 合成 SQLite，20,000 chunks × 600 中文字符。100 本删 50 本：6.084s→4.360s；全部删除：13.986s→1.291s。单本占全部 20,000 chunks：10.196s→1.082s。100 本中仅删 1 本（还保留其他索引）：0.220s→0.217s，主要改善是后台执行而非 SQL 倍数加速。此为 SQL 清理对照，不代表 Windows 端到端延迟。
- 剩余：SQLite 与多份 JSON 仍不是跨文件统一事务；保留逐文件原子保存。Windows 磁盘占用/故障、真实大书和建库未结束时同时删除的压力场景尚未实测。
- 关联：C-53/C-54/C-56、`docs/tasks/active/core-reader-fixes-september.md`。

## B-085：相容同居制作信息页的中间蓝色盒子向右突出（2026-09-12）

- 状态：本地修复与真实书回归完成，待 Windows WebView2 复验。
- 触发：用户最初称“目录页”，补充为中间蓝色盒子右缘突出；实际位于《和相容为负的同学同居 01》的 `OEBPS/Text/message.xhtml`。
- 根因：上下卡片嵌套在限宽链接中，`margin:0 1em` 自然从父容器扣除；中间卡片是 viewer 直接子，L3 给它完整 40rem 宽度，C-04 又叠加作者 margin，造成 608px/640px/608px 三种宽度。
- 修复：对无作者 sizing、包含块级内容的普通横排容器、明确非百分比且左右正对称的作者 margin，按版心内部留白计算 max-width 和两侧位置，使用原 marginFixes 保存/恢复。40rem、16px 字号下三个盒子统一为 `x=336..944,width=608`。
- 约束/选择：保留 C-40 已明确居中的标题、fit/max-content、作者宽度、未知 CSSOM、单侧/负边距和 float 原路径；不按书名、颜色或 `.epub` 类名修补，不改 EPUB。所有 h1～h6 以及仅含行内内容的 div 展示标题继续走原标题对齐路径，避免改变 B-024/C-40 已验收的标题盒宽与位置。
- 修改：`src/render/paginator.ts`、`paginator.test.ts`、`percentageInsets.test.ts`。
- 验证：原书真实 before/after、1280/16px/light、900/24px/dark、640/16px/light 和同文档往返 reflow；卡片等宽同左缘断言通过。原 TOC.xhtml 本身未发现同类异常。
- 关联：C-04/C-24/C-40、`docs/tasks/active/toc-width-three-books.md`。

## B-086：前辈 04 目录百分比卡片绕过限宽（2026-09-12）

- 状态：本地修复与真实书回归完成，待 Windows WebView2 复验。
- 触发：《最喜欢的前辈小巧又可爱，所以想每天让她害羞三次 04》`OEBPS/Text/TOC.xhtml` 的目录卡片使用 `margin:0.5em 5%`，宽窗口铺到 1143px。
- 根因：C-16 把所有非零百分比边距都当作页面定位，写入 `max-width:none`，忽略对称双侧留白与单侧百分比定位的区别。
- 修复：只有明确无作者 sizing、普通横排块且左右正对称的百分比留白，按有效 40rem 版心比例计算；5% 两侧各 32px，卡片 border-box 为 576px。其他百分比定位仍沿用 C-16，不追加版心偏移。
- 约束：窄窗仍使用实际包含块的百分比；content-box 扣除 padding/border；作者 width/min/max-width、未知级联、fullpage、非对称/负 margin 保持。所有临时 max-width/margin 在下一轮恢复。
- 未采用：全局强制 max-width!important、删除百分比布局兼容规则或包裹目录 DOM。
- 验证：目标原书宽窄/主题/字号/同文档 reflow；赤月单侧百分比定位对照通过，标题背景页前后布局一致。
- 关联：C-16、B-085 共用 `getReaderSymmetricInsets`，基础目录宽度任务。

## B-087：国王求婚 06 的竖排引文被撑宽且离开版心（2026-09-12）

- 状态：本地修复与真实书回归完成，待 Windows WebView2 复验。
- 触发：《国王的求婚 06》`OEBPS/Text/TOC.xhtml`，右浮动的 `vertical-rl` 引文。
- 根因：C-08 把正常竖排的一行厚度误判为横排浮动塌缩，Canvas 水平测量后写入约 384px width；C-31 又完全排除竖排，导致引文仍贴窗口右侧。
- 修复：横排 Canvas 补偿仅处理 horizontal-tb。对明确横排包含块内的 vertical-rl/vertical-lr 物理 left/right float，沿用已有版心侧 inset 与作者 margin；其他复杂书写组合不放宽。
- 约束：不改变 writing-mode、字体或阅读器分页方向；百分比/负/未知边距、作者全宽、复杂定位、过宽与 RTL 保留原门控。
- 验证：1280/16px 下引文恢复自然 `28.7969px` 宽，无补偿 inline width，右缘 `921.609px`，位于版心右缘 960px 以内并保留作者 2em margin；900/24px、640/16px 和往返 reflow 均通过。金木犀普通 right float 保持原结果。
- 关联：C-08/C-31、基础目录宽度任务。

本轮统一验证：Vitest 87 files / 552 tests、tsc、Core/AI production build 各 150 modules 与 artifact gate 通过。未修改 Rust，沿用前轮已通过的后端基线，不重复声称本轮运行 Cargo。标题页背景图显示不全按用户要求不处理，三本标题页的几何/页数对照一致。


## B-088：火焰目录的行内色块被旧溢出补偿拉成等宽（2026-09-12）

- 触发：《世界啊臣服于吾之火焰 01》TOC.xhtml；用户确认色块应长短不一。
- 根因：C-25 的 inline-block 补偿使作者尾随全角空格参与宽度，原来的右对齐文字和不同可见背景长度变成约 249px 等宽盒。
- 修复：对简单横排/ltr/右对齐行，先用 Range 检查所有非空白文字均在行边界内，再仅裁掉横向外溢背景；保留 inline 排列。复杂/不安全行保持原补偿。每轮恢复 overflow-x 值与 priority。
- 分页：DOM rect 仍含被裁掉的空白，contentExtent 对本轮登记的裁剪行后代取可见水平边界，避免窄窗多出空白末页；保留真实后续内容列。
- 验证：原书四种窗口/字号配置与同文档 reflow；640/16 仍 1 页，900/24 为 2 页；可见色块恢复多种长度。新增真实/被裁剪后续列统计回归，扩展样式恢复测试。
- 关联：C-25；本地完成，待 Windows 复验。

## B-089：赤月目录条目整体超过版心右缘（2026-09-12）

- 触发：《试着向准备跳下去的同班同学提议「和我XX吧！」02》contents.xhtml。用户只确定“疑似”，同意先修测得的条目越界，之后与汇报人交流。
- 根因：自动宽度目录容器的左侧 1.75em margin 被加到完整 40rem 宽盒之外，导致 1280/16 下 right=988，超过正文右缘 960；hover 背景也过长。
- 修复：将 B-085 的普通分组块留白规则扩展到非负非对称固定边距，max-width 扣除作者边距，保持起点缩进和右边界。目录宽 640→612px，右缘 988→960。
- 边界：仅含块级内容且没有作者 sizing 的普通横排块；标题/行内展示标题、作者宽度、未知级联、负 margin、float 和非对称百分比定位保留。右下角人物位置未修改。
- 验证：原书四配置、同文档 reflow、单侧留白/盒模型/排除条件单测；等待汇报人确认视觉预期。
- 关联：C-04，`getReaderAutoBlockInsets`。

## B-090：标题页及页面级百分比间距采用完整页面宽度（2026-09-12）

- 触发：相容同居 01 的 title.xhtml，margin-top:40%；用户要求同时检查 padding-top/bottom 等百分比。
- 根因：40rem 只限制顶层盒宽，实际 CSS 包含块仍为整页 viewer；纵向 margin/padding 的百分比按包含块宽度解析，因此 1280px 下误得 512px 上边距。
- 修复：页面级上下 margin 和四向 padding 的百分比项按有效版心宽度解析；root padding 先于分页尺寸计算。嵌套盒按真实父宽、无额外缩放；保留 CSS 宽度基准，不改按窗口高度计算。
- 级联：Typed OM 读取最终值，calc/min/max/clamp 中长度项保持，引擎解析新值；临时 inline!important 穿过作者重要声明，measure/cleanup 恢复原值与 priority。未知 Typed OM、竖排/float/绝对定位、已突破版心的全宽和全页图保守跳过。
- 验证：1280/16 下上边距 512→256px，标题 2→1 页；四配置/往返 reflow、root/top/nested padding、逻辑属性、calc、px!important、窄窗与排除边界通过。不改变另外两本标题背景图的几何/页数。
- 关联：C-16b，新增 `percentageSpacing.ts`；待 Windows WebView2。

B-088～B-090 统一验证：Vitest 89 文件 / 558 用例，Core/AI 构建含 TypeScript 检查和 artifact gate 通过，各 151 modules。原书和合成浏览器证据在 `.cache/width-spacing/`，不应同步；Rust 本轮未改未重测。源仓保持只读。
