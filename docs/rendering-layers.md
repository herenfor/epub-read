# 阅读器样式分层规范（Rendering Layers）

> 目的：避免再出现“每本书一个特判、规则之间互相打架”的情况。
> 新增任何 CSS/样式逻辑前，先对照本文确定它属于哪一层、允许用多少优先级。

## 分层总览（从强制到可覆盖）

```
L1 安全/消毒层（绝对优先，书不可覆盖）
L2 用户设置层（用户主动选择 > 书）
L3 阅读器默认版心层（阅读器默认 > 书的通用规则）
L4 书内容布局层（书的具体规则 > 阅读器默认）
L5 引擎兼容补偿层（只在浏览器多栏 bug 时兜底，尽量少、尽量通用）
```

| 层 | 职责 | 典型规则 | 允许的 CSS 强度 |
|---|---|---|---|
| L1 安全/消毒 | CSP、删脚本、危险属性、脚注 aside 隐藏 | `#viewer aside[epub:type=footnote]{display:none}` | `!important` 可 |
| L2 用户设置 | 字号、主题前景/背景、行高、字重、字距、词距、rt 注音随主题换色 | `html{font-size:16px!important}`、`body{color:...}` | `!important` 可 |
| L3 阅读器默认版心 | 40rem 版心、页面级居中、图片防溢出、全页图整屏 | `:where(#viewer .reader-top){max-width:40rem}` | 默认值；`margin` 用 important 压书通用 reset |
| L4 书内容布局 | 书的 margin/width/max-width/float/font-family 等具体设计 | 不注入，尊重书 | 阅读器不得用高特异性覆盖 |
| L5 引擎兼容补偿 | CSS 多栏的 fit-content/float 收缩异常等 Chromium 行为补丁 | `#viewer .summary{max-width:40rem}` | 只打已知 bug；新补偿写清触发条件 |

## 每层规则说明

### L1 安全/消毒
- 脚本、CSP、危险标签/属性在 `sanitize.ts` DOM 阶段处理，**不参与级联谈判**；
- 脚注内容 aside 的隐藏属于安全/版式底线，允许 `!important`。

### L2 用户设置
- 主题、字号、行高、字重、间距是用户显式选择，书不能覆盖；
- 字体注意：阅读器 fallback 只放在 `html` 层；书在 `body` 上声明的内嵌字体优先（继承关系自然成立）。

### L3 阅读器默认版心
- 目的：普通书不写布局时，也有统一版心；
- 手段：
  - 直接子元素打 `reader-top` 标记；
  - `max-width` 用 `:where(#viewer .reader-top)`（零特异性），书类规则可覆盖；
  - `margin-left/right:auto` 需要压过书的通用 reset（`div{margin:0}`），所以带 `!important`。
- **不要**再回到“给所有嵌套元素加 max-width/margin”的写法。

### L4 书内容布局
- 书类规则（`.toc`、`.paper`、`.chat` 等）的布局声明必须生效；
- 阅读器注入规则不要用 id+class 组合去覆盖书类规则，除非它是 L2/L5 的明确例外；
- 出现“书规则没生效”先查是不是 L3/L5 误伤了它。

### L5 引擎兼容补偿
- 只解决浏览器 CSS 多栏的实际 bug：
  - `float` 元素 shrink-to-fit 塌成逐字宽度；
  - `max-width:fit-content` 异常；
  - 非 void 标签自闭合吞内容（DOM 预处理，不是 CSS）；
- 每条补偿必须注释：**触发条件 + 影响哪些书 + 何时可以移除**；
- 优先通用（如 cssRewrite 跳过纯标签/组合器/float 的 width% 换算），特判类（`.summary`）只是兜底。

## 新增规则的检查清单
1. 它解决的是书 bug 还是阅读器 bug？
2. 属于 L1–L5 哪一层？
3. 需要 `!important` 吗？为什么？
4. 选择器特异性是多少？会压过哪些书规则？
5. 对已经回归的书（铁人目录/诡屋信件/星空信息页/榛名 CONTENTS/三上目录）有没有影响？
6. 是否只影响当前这本书？能否抽象成通用规则？

## 规则冲突台账（已发现，持续维护）

> 状态：✅ 已修 / 🔶 部分修 / ❌ 未修 / ↩ 已撤销。
> 每一条新增规则必须在这里登记，禁止无台账的散装特判。

| 编号 | 层 | 冲突属性 | 问题 | 处理 | 状态 |
|---|---|---|---|---|---|
| C-01 | L2 | `background` | 主题用 `background` 简写，重置了书的 body 背景图 | 主题只写 `background-color` | ✅ |
| C-02 | L3 | `max-width` | 阅读器 `40em !important` 压掉书 `.paper{max-width:30em}` | 改为 `:where()` 零特异性 + `rem`；书类优先 | ✅ |
| C-03 | L3 | `margin-left/right` | `reader-top{margin auto !important}` 压掉目录条目交错 margin | 嵌套元素不强制；直接子走两阶段判断 | ✅ |
| C-04 | L3 | `margin-left/right` | 同一规则压掉 `.namebox{margin-left:2em}` 等直接子具体布局 | 两阶段：默认居中渲染后，屏蔽阅读器规则读取纯书 margin，非零且非“auto 居中形态”则按“margin-box 居中 + 书不对称偏移”写回 inline !important B-085：含块级内容的普通非标题横排自动宽度容器的明确正对称作者 margin 计入版心内部留白，max-width 扣除两侧 margin 并保存/恢复；作者 sizing、未知级联、h1～h6/仅行内内容的展示标题、intrinsic、float 与 C-40 原路径保留。 B-089：分组块扩展至非负非对称固定 margin，宽度扣除左右留白；百分比仍要求正对称。 | ✅ |
| C-05 | L3 | `padding` | `html,body{padding:0!important}` 压掉 LK 书 `body{padding:0 5px}` | 移除 padding 清零；UA 默认已是 0，书声明自然生效 | ✅ |
| C-06 | L4 | `font-family` | body 覆盖书的内嵌字体 | fallback 移到 html，body 不写 | ✅ |
| C-07 | L4 | `width:%` | 文本层把 `width:X%` 直接改成固定 em，误伤“% 相对窄包含块”的规则（note/.ctt/.authorbox table，以及命定之人目录 `.toc-link{width:100%}` 相对 53px td） | 改写为 `min(X%, X/100×40rem)`：页面级取版心比例，窄容器由浏览器取书自己的 %；仅 0<X≤100 改写，>100 出血保留；纯标签、组合器、float、img/fullpage 跳过清单继续保留 | ✅ |
| C-08 | L5 | `float` 收缩 | CSS 多栏里 float shrink-to-fit 塌成逐字宽 | 分页器 Canvas 测 max-content 后按可用宽收缩写回 px；只处理宽度 ≤48px 的塌缩浮动元素；`<br>` 按最长行计；媒体专用小 float 由 C-23 排除；WSL 用 `scripts/setup-pw-fonts.mjs` + XDG_DATA_HOME 解决字体 B-087：Canvas 宽度补偿只接受 computed writing-mode:horizontal-tb；竖排的一行厚度不是横排塌缩，不写 width。 | ✅ |
| C-09 | L5 | `fit-content` | CSS 多栏里 fit-content 异常 | 分页器运行时统一把 fit-content 元素 max-width 设为版心 40rem（已移除 .summary 特判） | ✅ |
| C-10 | L4 | `text-align/float` | 曾全局强制 `.ctt` 居中，覆盖书设计 | 已撤销，尊重书 | ↩ |
| C-11 | L2 | `color` | `rt` 注音在深色主题不变色 | `#viewer rt` 随主题前景色 | ✅ |
| C-12 | L1/L3 | 图片尺寸 | 普通图片规则用 `!important` 可能覆盖书设定 | 普通图片规则改为 `:where(#viewer)` 零特异性默认值；全页图块保持 important | ✅ |
| C-13 | L4/序列化 | CSS `>` 文本 | XMLSerializer 在 `<style>` raw-text 中输出 `&gt;`，HTML 不解码导致子组合器失效 | 仅在序列化后的 `<style>` 内容恢复 `&gt;`；保持 `<` 与其他文档区域转义 | ✅ |
| C-14 | L3/结构语义 | 祖先元素类型 | 注入 `<div id="epub-viewer">` 使 body 顶层 p 成为 `div p` 后代，误命中书规则 | 改用 `<epub-viewer id="epub-viewer">`，显式 `display:block`；分页器仍只依赖 ID | ✅ |
| C-15 | L3 | 顶层链接版心 | viewer 直接子 `<a><p>…</p></a>` 中，inline 的 a 不接受版心 max-width/auto margin，内容贴窗口左缘 | 仅给 `a.reader-top` 提供零特异性 `display:block` 默认值；书籍具体 display 可覆盖 | ✅ |
| C-16 | L3/L4 | `% margin`、auto margin | 二阶段补偿把页面相对 35%/外链 70% margin 再叠加版心 base；传统 CSSOM 不能可靠代表最终级联；fit-content 用 content width 判断含 padding/border 的 auto 居中，均导致整体右移 | 先仅解除 L3 `reader-top` auto margin，用 Typed OM 读取最终获胜的 `%`/`calc(...%)` 并按包含块原位写回、按需解除默认 max-width；旧 WebView 才安全回退 CSSOM，未知来源仅在原位留余量而 base 必越列时兜底；auto-like 统一用 border-box，所有临时值/优先级随 reflow 恢复 B-086：无作者 sizing 的普通非标题块若为正对称百分比 margin，按 min(包含块,40rem) 的比例收进版心，不能解除默认限宽；单侧/非对称百分比与明确作者 sizing 继续本条原路径。 | ✅ |
| C-16b | L3/L4 | 页面级百分比 margin/padding | 顶层盒限宽未改变实际 CSS 包含块，纵向百分比也相对整页宽度，标题 40% 产生过大留白 | B-090：Typed OM 最终级联的百分比项按 min(包含块宽,40rem) 投影；root padding 先于分页，普通直接子上下 margin/四向 padding 同步处理，嵌套和窄容器保留。calc 长度项不缩放；全页图、突破版心全宽、绝对定位、float、竖排和未知 Typed OM 跳过。每轮/cleanup 恢复原 inline/priority，不改背景图和百分比高度。 | ✅ |
| C-17 | L3/L4 | inline SVG 图片尺寸 | 多看纯图片页用 `div > svg > image`，未命中只统计 HTML `img` 的全页检测；40rem 顶层版心使 SVG 按 viewBox 比例产生超页高度后被裁切 | 仅把“无文字、单个带 viewBox 的 SVG、且直接包含单个 image”纳入 fullpage；HTML 祖先传递页面高度，SVG 视口 100% contain，内部 image 与 preserveAspectRatio 保持书设计 | ✅ |
| C-18 | L3/L4/L5 | fit-content 与对称 margin | margin 定位先于 fit-content 宽度补偿，导致不同内容盒按异常旧宽度散开；intrinsic-size 灰框的 `margin:1em` 又被当成单向缩进 | 先稳定 fit-content 最终宽度再计算 margin；仅对具有 fit/max-content 原始意图的盒保留正对称 margin 的 reader auto 居中；真正不对称、普通 width:auto/固定宽度和负 margin 继续走书布局 | ✅ |
| C-19 | L5/渲染时序 | 首次绘制与二阶段布局 | blob iframe 在字体等待、fit-content/margin/float 补偿和分页自愈前已经可见；同尺寸 ResizeObserver 空转又会在 ready 后暂时撤销补偿，形成盒子横向闪动 | `VisibilityGate` 用 load 代次把 iframe 保持为可布局但不可见，等待统一准备流程及最终入口定位后揭示；20 秒/错误/dispose 恢复；完整测量尺寸未变时跳过 ResizeObserver 空转 | ✅ |
| C-20 | L5/交互时序 | hidden iframe、滚轮目标锁定与持续 wheel | `visibility:hidden` 不参与鼠标命中；浏览器又可能把同一连续滚轮锁定在外层目标，若外层只在 loading 接收，则揭示后固定停在第 2/倒数第 2 页 | `ReaderView` 始终接收外层 wheel：loading 时 `TurnIntentBuffer` 只留最后方向，display-ready 消费一次；ready 后同一锁定流由 `WheelTurnAccumulator` 按 80px 阈值持续翻页；错误/销毁清空 | ✅ |
| C-21 | L1/L3 | 根高度、盒模型与 overflow | `html/body{height:100%}` 仍是 content-box 时，书的上下 padding 会叠加到视口高度，短目录也产生根滚动条 | 根页面统一 `box-sizing:border-box`，保留书 padding 并让 viewer 使用 body 内容区；`overflow:hidden!important` 固化“只由 viewer 分页”的底线 | ✅ |
| C-22 | L3/L4 | 块内容链接的多栏 fragmentation | 默认 inline 的 a 包住 `div + p` 时，Chromium 可在两块之间断列，使装饰线孤立在前页、文字落到后页 | 零特异性匹配直接包含常见块元素的 a，默认 `display:block;break-inside:avoid`；普通行内链接不命中，书籍具体规则可覆盖 | ✅ |
| C-23 | L5 | 小型媒体 float 宽度 | C-08 用“宽度 ≤48px”识别文字塌缩时，把正常的 24px 头像 float 也当成异常；Canvas 又把源码缩进空白计入宽度，产生 82.2px inline width | C-08 测量前排除有效内容只有直接 `img/svg` 的 float；空白与注释不算内容，任何可见文字或其他元素仍进入原判断 | ✅ |
| C-24 | L3/L4 | 普通顶层元素的正对称 margin | C-18 把所有正对称 margin 都当成无方向双侧留白，使普通 `width:auto` 目录标题的作者缩进被 L3 auto margin 再次吞掉，回归 0.1.3 前的错位 | 正对称居中豁免以通用的 fit/max-content 原始意图为边界；普通元素恢复 C-04，解析后恰好等于剩余空间的真实 auto margin 则用几何判定继续居中 | ✅ |
| C-25 | L3/L5 | computed-right 行内盒的尾随宽空格与分页 | 原 inline-block 补偿使尾随空白计入盒宽，将火焰目录拉成等宽；直接裁剪后 DOM rect 又会虚增末页 | B-088：优先在简单横排/ltr/right 行证明全部非空白 Range 都在行内，以 overflow-x:clip 仅裁外溢空白背景，保留 inline 和文字位置；本轮裁剪后代的 contentExtent 取可见边界，避免空白末页。复杂布局维持原门控和原子化兜底；每轮/cleanup 恢复 priority，无 DOM/text 改写。 | ✅ |
| C-26 | L2/L4 | 书籍 `body bgcolor` 与自定义背景级联 | 旧实现把 bgcolor 追加为位于用户 CSS 之后的 `!important`，必然压住用户背景；主题 `background` 简写还会重置书籍背景图 | 仅在浅色主题安全解析 `bgcolor`，作为同一 override style 的 body `background-color` 默认值；消费后移除 legacy 属性，用户 CSS 保持该 style 最后；深色/纸色忽略，背景图只由原有/用户 `background-image` 保留 | ✅ |
| C-27 | L1/L4 边界 | CSS 注释被文本正则当作有效 import/声明 | 原始 CSS 扫描会读取注释内 import、改写注释 URL/width，递归恢复后还可能令导入 CSS 泄漏；sanitize/paginator 的 style 来源启发式也会被注释关键词误导 | `cssRewrite` 用 quote-aware、可处理转义/未闭合注释的共享 token protector；递归 import 共享 context，根返回前逐字恢复；资源/width 与 authored property/float 判断只看注释外文本。不是完整 CSS parser，不改 CSSOM/Typed OM/userCss 注入 | ✅ |
| C-30 | L5 | 末尾媒体 float 的多栏 fragmentation | viewer 最后一个纯媒体 float 的未分片高度大于当前列剩余空间时，Chromium 的碎片 union bottom 可能看似未溢出，子图负 margin 还可能越过根节点并与前序内容碰撞，造成错误残余列 | 仅对最后直接子、static/relative left/right float 的递归媒体-only 子树，按首列碎片 top + 正 `scrollHeight` 估算未分片底部；临时收紧 `margin-top`，要求自身合为单列、根及后代视觉 rect 均在列内且不碰撞，失败立即恢复；列坐标考虑 `scrollLeft`，每轮 measure/dispose 恢复 | ✅ |
| C-31 | L3/L4 | 顶层 float 版心逃逸与普通块误判 | viewer 直接 `reader-top` float 会绕过普通 auto margin；带作者 margin 的 float 又曾因旧门控跳过而落入 C-04，被当成普通块搬到版心中部 | 将所有顶层 computed left/right float 隔离为独立布局单元，绝不进入 C-04/C-18。安全单项在物理 float 侧写入版心 inset 加作者同侧 margin，另一侧保留作者值；百分比/未知/负 margin、复杂定位/书写模式、过宽或明确 breakout 只按本轮测量保留作者布局。写回使用独立 `floatLayoutFixes` 完整恢复；完整百分比组再交 C-39 B-087：横排包含块中 vertical-rl/vertical-lr 引文的物理 left/right float 也可沿用安全侧 inset；仍不改变书写模式，其他书写组合保持保守门控。 | ✅ |
| C-32 | L4 | 富脚注跨 iframe 列表语义 | 图片脚注的 `aside.innerHTML` 复制到宿主弹层后不再继承书籍 iframe 的 `list-style:none`，`li[value]` 因宿主默认列表样式泄漏注释序号；普通作者列表不应被全局隐藏 | 宿主 `.footnote-html` 仅对 `.duokan-footnote-content` 及其直接 `li` 隐藏 marker、清零 padding，并取消该结构图片容器的旧负左 margin；普通 `ol/ul` 保持原编号与缩进 | ✅ |
| C-33 | L5/阅读位置 | 页面中心与多栏分页 | 将中心位置作为布局偏移会让章节第一页不再从自然顶部开始；父子元素递归文本计数还会令进度重复 | 中心仅经 caret 采样；成功 measure 后建立只读可见文本索引，以 text offset/snippet 在已分页内容中选择列。不得写 DOM/style/分页规则，旧 element/page 仅兜底 | ✅ |
| C-34 | L3/L4 | 多看图片类的全页语义 | `.duokan-image-single` 同时用于普通图片+图注和纯图片包装；仅凭类名注入整页 flex/100% 图片规则会压掉作者图文布局 | 仅明确 fullscreen 类保留类级全页语义；普通 single 回归作者布局，真正无文字单图由页面级结构识别进入 `fullpage-image` | ✅ |
| C-35 | L3/L4 | 连续百分比 float 与版心内缩 | viewer 直接子以同向 `float` 和百分比宽度组成一整行栅格时，逐项套用 C-31 的物理侧 inset 会把 20%×5 等布局拆成多行并推出版心 | 仅对连续直接 sibling、同方向、clear:none、最终作者 width 均为明确百分比且总和 99..101、至少两项的组跳过 C-31；单 float、不满整行、px/未知宽度、方向变化或普通块断组仍走旧门控。现代 Typed OM 明确 px 直接否决；旧 CSSOM 不建模 `:where/:is/:not/:has`、layer/container 条件，reader overrides 匹配 width 或不可读源均保守不豁免 | ✅ |
| C-36 | Core/UI | EPUB 3 NAV 同文档 fragment 与多级目录 | 合法 NAV 的 `#id` 需要以 nav 文档为基准；旧解析器会跨嵌套 li 取链接、混合列表顺序不稳，UI 只按 path 高亮并只统计顶层 | 命名空间/属性回退读取 `epub:type`；最近列表与嵌套边界剪枝保持真实顺序；仅当 nav/NCX 基准文档位于 spine 时将 `#`/`#id` 绑定为该文档 href；目录递归统计，按 fragment 精确、章首、同路径顺序返回唯一节点引用。无上下文的 `isUsableHref` 仍拒绝纯 fragment | ✅ |
| C-37 | L3/L4 | UA 默认水平 margin 与 C-04 | L3 auto margin 临时移除后，`getComputedStyle` 的 blockquote 等 UA 默认 px margin 会被误作作者缩进，再叠加正文版心导致横向右移 | 只对 non-percentage、nonzero/unknown computed margin 的 C-04 候选检查当前生效 inline/author/user CSSOM 是否明确声明 `margin`、物理或 logical 水平 margin；零/auto 子元素与 C-16 百分比路径不扫描。L3 auto 规则移除后仍读取同 sheet 尾部的 customCss。未知条件、grouping、选择器或不可读 sheet 保守保留旧补偿；百分比/C-16、fit-content/C-18 和 C-31 不变 | ✅ |
| C-38 | L3/L4/L5 | UA 对称水平 margin 的语义保留 | C-37 来源门控能消除 blockquote 的错误右移，但直接跳过 C-04 会吞掉 UA 默认的双侧缩进，使元素恢复完整 40rem 正文宽度；重新走 C-04 又会把左侧 UA margin 当成单侧偏移 | 仅对 `reader-top` 且 `authoredHorizontalMargin === false`、非 float/fullpage/百分比、高优先路径之外、computed 左右 margin 有限非零且对称的元素，将当前 border-box 减去两侧 inset 后按 box-sizing 写入临时 `max-width`，保留 L3 auto 居中；目标宽度受包含块限制，写回随 `marginFixes` 恢复并可重复重排。作者/用户/未知来源与其他补偿路径不变 | ✅ |
| C-39 | L3/L4/L5 | 完整百分比 float 组的版心收敛 | C-35 识别出的 `20%×5` 等直接 sibling float 组不能逐项套 C-31，否则会拆行；完全保留则占满 viewer | 仅对完整安全百分比组按 `min(p%, p/100×40rem)` 写入 width；首项承担同侧版心 inset，使用独立 `floatLayoutFixes` 完整快照、marker 与几何验收事务。失败完整恢复后保守保留作者 float；复杂组不进入 C-04/C-18，C-08 跳过已标记成员；不包 DOM、不按书特判 | ✅ |
| C-40 | L3/L4 | 显式对称居中作者 margin 与 C-04 | C-04 的 `ml>0` 分支把 `text-align:center` 元素的对称作者 margin 当成单侧左缩进，导致みかみてれん目录标题相对目录主体右移；但 B-024 的 `text-align:left` 标题必须继续保留左缩进 | 仅对 viewer 直接 `reader-top`、`float:none`、`horizontal-tb`、computed `text-align:center` 且作者水平 margin 来源明确、有限正值并在 0.5px 内对称、无作者 width/min-width/max-width sizing intent、非百分比/fit/fullpage 的元素保留 L3 自然 auto margin并跳过 C-04。inline/HTML 属性与可读作者 CSSOM 用于 sizing 来源判断；阅读器内建 `max-width:40rem` 不计入作者 intent；固定/unknown 来源及非对称布局保守走原路径，不按书名/类名特判 | ✅ |
| C-42 | L2/L5 | 深色主题局部文字对比度 | 深色主题前景 `rgb(212,212,212)` 遇到作者半透明浅色盒后，有效背景变亮而正文对比度低于 WCAG 门槛；全局换色会覆盖作者明确语义或背景图 | 仅在 iframe load 后、显示门仍 hidden 且首次 measure 前运行一次；按 html 基底到 body 后代单次 DFS、每元素只读取一次 computed style，递归传递可识别的祖先 rgba 背景；仅对接近主题前景、当前对比度 `<4.5` 且候选 `#1a1a1a` 显著改善的元素写普通优先级 inline color 与 marker。无直接文本的背景容器可因子孙文本修正；background-image、未知颜色/合成、opacity<1 与作者明确不同色保守跳过；不参与翻页/reflow，marker 随文档自然销毁 | ✅ |
| C-43 | L5/交互时序 | iframe 脚注 marker 与宿主弹层 hover 交接 | iframe 与宿主是两个 hover 域；marker `mouseout` 先于宿主卡片 `mouseenter` 到达时，立即 close 会在窄窗口产生闪烁并重复解析/显示同一脚注 | 通过独立 `FootnoteHoverGate` 以 140ms grace 合并 marker/overlay 状态；任一进入取消 timer，重复 leave 不堆 timer，两者均离开且未 pinned 才触发一次 close。pinned、正文空白/关闭按钮、章节 cleanup/dispose 清理 gate；不改 popup CSS、定位或分页 | ✅ |
| C-44 | L5/交互布局 | 极窄窗口脚注弹层坐标与完整可见 | `FootnotePayload.rect` 是 `.main` 局部坐标，但弹层原本在 `.main` 外按 app/viewport 坐标定位，toolbar offset 在极窄窗口造成越界；固定 300px 宽度也可能超过容器 | `FootnotePop` 必须位于 `.main` 内并使用真实 `.main` 尺寸；纯 placement helper 按 `min(300, width-2gap)` 选择右/左与上/下完整位置，两侧均不足时按空间较大方向 clamp，容器不足输出 `maxHeight=height-2gap`；ResizeObserver/resize 只在真实尺寸变化时更新。保持 z-index 60，不改 hover gate/分页 | ✅ |
| C-45 | L2/主题可读性 | 深色模式浅色盒/复杂背景中的默认文字缺少阴影兜底 | 局部对比度修正对背景图、未知合成和复杂作者样式保守跳过，深色主题前景在浅色区域仍可能难读；用通配符或 `!important` 会破坏作者显式文字特效 | 仅 dark theme 在 `#epub-viewer` 注入普通优先级 `text-shadow: 1px 1px 1px #1e1e1e`，依靠继承作用于默认文字；后代明确 `text-shadow`（含 `none`）可覆盖。light/sepia 不注入，不改 `applyDarkThemeContrast`、分页或 Rust | ✅ |
| C-46 | L2/用户设置 | 可重排竖排 EPUB 无法进入现有横向多栏分页模型 | 书籍 html/body/viewer 或嵌套元素声明 `vertical-*` 时，现有 paginator 仍按横向列模型测量；固定版式不应被用户横排开关改写 | 仅 `forceHorizontal=true` 时对 html/body、`#epub-viewer` 及 `#epub-viewer :not(svg):not(svg *)` 注入 `writing-mode: horizontal-tb !important`、`-webkit-writing-mode: horizontal-tb !important`、`text-orientation: mixed !important`；不改 direction。SVG 及其后代排除后代覆盖选择器，SVG 内显式声明可保留；仅祖先继承且 SVG 内未声明的原始状态无法凭 CSS 恢复。固定版式在 ReaderView 有效设置中屏蔽 | 待用户审核 |
| C-47 | L2/用户设置/UI 性能 | 系统字体不可选与导入字体列表/启动读取成本 | 原菜单嵌入所有导入字体且启动逐个读取二进制；Windows 系统字体必须通过 host API 提供 family 选择，但不能泄露路径或把系统字体复制为应用资源 | 独立 FontSettingsPanel 使用 system/imported tabs、搜索和带总高度 spacer 的固定行高虚拟列表；Windows Tauri 首次打开时调用 `system_fonts_list` 并会话缓存 family/localizedNames，非 Windows 空列表。导入字体启动只 list 元数据，当前 id 才 read 一个 Blob；读取竞态、切换、失败和卸载按 URL ownership 释放/保留契约处理。system 只注入 body font-family，不生成 `@font-face`；imported 只注入当前一个 `@font-face`。面板 z42、backdrop z41 | 待 Windows 主机/实机审核 |
| C-50 | L5/渲染时序与资源 | 顺序跨章需要重复完整隐藏渲染 | 单 iframe 切章必须重新 sanitize、等待字体并完成二阶段补偿；直接复制 DOM 会绕过 Blob/监听器/锚点所有权，后台 paginator 回调又可能污染当前进度和交互 | 默认关闭的前后相邻三槽复用完整 `loadAndWaitForDisplay`；后台严格先下一篇、后上一篇，同尺寸可布局但不可见，全部回调以 active identity 门控。仅在 React 已提交顺序目标 spine 后提升 ready 槽并保留旧章为反向缓存；显式跳转/未命中走 P0。B-082：槽位保存实际 renderSettings，构造读取最新 ref；后台调度与提升校验设置身份，loading/measuring/error 撤销 ready；换章取消设置防抖时同次 load 应用最新设置。设置/字体/尺寸/关闭/切书使预载失效，所有 slot dispose 后才释放 ResourceServer | WSL Chromium 三 Blob/7ms 回翻通过；待 Windows WebView2 性能审核 |

C-33 同时约束同章 direct 导航：复用已经完成的自然分页布局，只更新现有列滚动位置和阅读锚点；不得通过重载、重新测量或页面中心偏移来实现同章定位。direct 失败必须保留原位置，跨章仍使用正常章节显示门流程。

B-039 的章节字数统计属于 UI 进度数据，不新增渲染层规则：当前章节只在自然布局完成后从已建立的可见文本索引取得 measured `totalChars`；未访问章节的 idle provisional 统计不读取 computed CSS hidden，也不写 DOM/style、不参与 CSS、分页或布局。对应章节真正进入测量流程后，仍以本文件既有 L1–L5 与 C-33 规则为准。

B-040 的设置 debounce 与 anchor snapshot 也不新增布局规则：ReaderView 只把连续 `settings`/`userFonts` identity 合并为最后一次 paginator load；分页器在 load 前复制阅读锚点和页码作为恢复输入。设置合并不改变首列原点、CSS、分页算法或页面中心采样；旧 load 仍由 loadSeq、显示门和测量身份校验排除。

## 新增规则登记模板
```md
| C-xx | Lx | 属性 | 触发场景 | 处理策略 | 状态 |
```
规则落地到代码时，CSS 注释必须带编号，例如 `/* [L5-C09] .summary fit-content 补偿 */`。

## 维护原则（防止“一个 bug 一条特判”）
1. 先归层，再决定强度：L1/L2 允许 `!important`；L3 用零特异性默认值；L4 不注入；L5 必须登记且写明移除条件。
2. 同一冲突不允许第二次用新特判；优先升级为通用规则（如 cssRewrite 的跳过规则）。
3. 每次新增规则，同时更新本台账 + 跑既有回归书清单。
4. L5 兼容规则集中管理，目标是数量只减不增。

## 未知冲突处理流程（新 bug 出现时）
新 bug 一定会有，处理顺序固定如下，避免拍脑袋：

1. **定位现象**：文字/盒子/背景/字体/对齐/溢出/换行；
2. **定位属性**：最终是哪个 CSS 属性被谁覆盖（诊断面板 `fitContentEls/wideEls`，或临时打印 computed style）；
3. **判定来源**：
   - 书 CSS 本身如此 → 尊重书，通常不改；
   - 阅读器注入覆盖 → 查本台账是否有同类；
   - 浏览器多栏/引擎 bug → 归 L5；
4. **归层**：按 L1–L5 选择策略；
5. **选择修复强度**：通用规则 > 层内默认值 > 登记过的特判；
6. **先写回归**：为该书/该属性补一个最小回归用例（单测或渲染矩阵），再改代码；
7. **更新台账**：状态、编号、移除条件。

## 自动化防线（防止回归）
- 单测：CSS 文本改写、消毒输出、脚注识别、分页交互等逻辑层（现有 199 项）；
- 渲染矩阵（建议固化）：对固定样本书 + 关键页断言 computed style，至少覆盖：
  - 铁人目录条目 margin 交错；
  - 诡屋 `.paper` 480px；
  - 星空 `.mesbox` 居中；
  - 鹤城 `.summary` 640px；
  - 三上 `.ctt` 保持书设计；
  - 侦探少年目录 `Contents` 保持 0.1.3 的版心内缩进；
  - 深色主题 `rt` 换色。
- 新 bug 修复必须进上述两类回归之一，禁止只靠手工验证一次。

## 已知未来收敛方向
- `width:%` 已改为 `min(书百分比, 版心比例)`（C-07），窄容器由 CSS 引擎按真实包含块取值，不再依赖选择器启发式猜测；`>100%` 的出血意图保持原样。若将来出现“父容器故意宽于 40rem 且内部 `width:100%` 需要取大”的样本，再评估运行时版心判断。
- L5 的 float/fit-content 补偿目前散在 sanitize/cssRewrite；后续统一收口到分页器测量阶段。
