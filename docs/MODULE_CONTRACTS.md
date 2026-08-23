# 模块边界与稳定契约

本文记录跨对话修改时不能轻易破坏的行为边界。它不是完整 API 文档，而是回归判断依据。

## 1. 解析层 `src/core`

- 保持无 React、无 Tauri、无布局 API 的纯 TypeScript 设计。
- 输入是 EPUB 字节，输出是 `Book` 数据模型或可理解的致命错误。
- EPUB 3 目录优先 NAV，EPUB 2 优先 NCX；不可用时使用 spine 兜底。
- `linear="no"` 不参与顺序翻章，但对应资源仍可存在于 manifest。
- 书籍问题进入 `BookIssue`；无法继续的 ZIP、OPF 和 DRM 问题才抛出错误。
- 内部资源路径统一规范化，外部 URL 不伪装成本地资源。
- IDPF 字体混淆可以还原；未知或 DRM 加密不得尝试渲染乱码内容。

## 2. 渲染准备层

### `ResourceServer`

- 一个 `ResourceServer` 只服务一本 `Book`。
- 相同路径复用同一个 Blob URL。
- `textFor()` 可复用解码文本，但 text LRU 默认最多 4 MiB/32 项，按 `text.length * 2` 估算；单条超限不缓存，命中更新 LRU。`revokeAll()` 清除 text entries/bytes；diagnostic hits/misses 为当前 server 生命周期累计值。
- 持有者负责在书籍会话彻底结束时调用 `revokeAll()`；新增生命周期代码时不得形成悬空 URL。
- `ReaderView` 的 server cleanup 必须先 dispose `ChapterPaginator`，再调用 `revokeAll()`；普通换章不得撤销整本书共享资源。

### `sanitizeChapter`

- 书内脚本、事件处理器、表单、嵌套 iframe、危险协议必须保持禁用。
- 内部图片、字体、样式和 CSS `url()` 必须基于章节或 CSS 自身路径解析。
- EPUB 2 优先严格 XML，失败可降级宽松 HTML并记录 issue；EPUB 3 使用宽松 HTML。
- 正文必须被包装为唯一的 `#epub-viewer` 分页容器。
- iframe 根页面不能承担正文滚动：`html/body` 的 100% 高度必须使用 border-box 包含书籍 padding，并禁止原生 overflow；所有超页内容继续由 viewer 分栏。
- 直接包住块级结构的链接默认是不可拆分页块；普通行内链接不受影响，书籍明确的 display/break 规则仍可覆盖默认值。
- 阅读器覆盖规则不能无依据压过书籍具体布局。
- CSS 文本改写必须先经过 quote-aware 注释边界保护：只有 normal state 的 `/*...*/` 之外才可参与 `@import`、`url()`、百分比 width 或来源启发式扫描；引号内的 `/*`、转义字符和未闭合注释按字符串/注释原义处理，注释原文逐字恢复。递归 `@import` 必须共享保护上下文，禁止子 CSS 恢复后的注释被父级 pass 再次扫描；这不是完整 CSS parser，也不改变 CSSOM/Typed OM 或 userCss 注入。
- 书籍 `body bgcolor` 只在浅色主题下作为安全的默认 `background-color` 合入同一个 override style；读取后移除 legacy 属性，避免同一背景值存在重复来源。旧实现曾把 bgcolor 追加为位于用户 CSS 之后的 `!important`，不得恢复。深色/纸色忽略它，不能用 `background` 简写清除书籍或用户背景图；用户自定义 CSS 必须位于该 style 的最后。

## 3. 分页器 `ChapterPaginator`

- 每个 iframe 同时只拥有一个活动章节文档。
- `loadSeq`/`reflowSeq` 等过期检测属于正确性逻辑，不是可随意删除的优化。
- 页宽取实际可用内容区；翻页位置必须与列步长一致。
- 换章应清除旧章页码与锚点；同章重排应尽可能恢复内容锚点。文本锚点只在自然完成章节布局后选择 viewer 的列边界，页面中心仅是采样坐标，禁止以空白、DOM 变换或样式偏移改变第一页原点。
- 阅读锚点优先保存 `anchorTextOffset`（Unicode code point、非负 safe integer）和最多 32 个无空白 code point 的 `anchorTextSnippet`；当前文档单次可见文本索引须排除 script/style、阅读器明确隐藏脚注及 computed hidden/collapse。恢复依次为有效 text+snippet、有效 legacy index/ratio、saved page、0；legacy index 越界无效且不得 clamp。旧持久化对象缺字段归一 null。
- 已完成布局的当前章节提供同步 `navigateWithinCurrentChapter()`：同章 fragment、章首、文本/legacy/page 恢复只改变现有 `scrollLeft/currentPage/anchor`，不得调用 `load`、sanitize、iframe src、fonts、measure 或 recompute；失败返回 false 并保持当前页、anchor、hash。成功 text/legacy/page 恢复清除旧 hash，fragment 写入新 hash；跨章仍由 App 走原有 load/display gate。
- 每章 blob 文档首次进入时，都应在字体、二阶段布局补偿、分页自愈和最终入口定位完成后再显示；`startAtEnd` 只是最终入口定位的一种，不能退回成仅对回翻隐藏。
- 首次隐藏必须使用仍可布局的 `visibility:hidden`（当前由 `VisibilityGate` 管理），禁止用 `display:none`；旧代次、错误、超时和 dispose 都必须安全解除或转交显示门。
- `ready` 的稳定边界应包含目录锚点/章末等最终定位；以后实现相邻章预渲染时复用该准备顺序，不另建一套分页完成判定。
- `ChapterState.ready` 可能在内部重算时先产生；需要交互的上层必须等待分页器的 display-ready 回调，不能在最终锚点/章末定位前宣告稳定。App 必须用同步 ref 记录 ready 和最后稳定位置；初始加载期点击目录时以已保存基线位置入栈，避免首次交互因 React render 竞态漏记。
- 图片、字体、设置和窗口变化后的重新测量不能把用户拉到无关内容。
- 书内链接不能让 iframe 自行导航；内部跳转、脚注和外部链接分别交给上层处理。
- 图片脚注的富 HTML 在宿主 UI 弹层显示时必须保留书籍的脚注列表语义：多看 `.duokan-footnote-content` 的生成 marker 不显示，列表不为隐藏 marker 预留左 padding；普通作者有序/无序列表仍保留其编号和缩进。脚注解析层不得为此破坏原始 DOM 结构。
- 有效普通书内链接在改变章节或页内位置前必须调用一次带已解析 href 的 `onBeforeInternalNavigate(href)`，由 `App` 先确认跨章目标命中 spine，再捕获最多 3 步的章节/页码/内容锚点快照；外链、脚注和无效跨章 href 不得进入该历史。纯 `#fragment` 只有当前文档存在目标且可执行 jump 时才通知，缺失目标仍可同步 hash 但不得产生历史。目录、书签和有效内部链接共用 back/forward 双栈；新普通跳转清空 forward。
- 分页器对 viewer 最后一个直接子元素的末尾媒体 float，可在确认其为递归 media-only、确实跨列且以首列碎片 top + `scrollHeight` 推算的未分片底部越过 content bottom 时，执行事务式 `margin-top` 收紧；候选及所有后代视觉 rect 必须在同一列内且不与此前顶层兄弟视觉 rect 碰撞。必须考虑 `scrollLeft`，失败、下一轮 measure 和 dispose 都恢复原 inline 值及 priority；普通文字/非媒体 float 不得命中。
- viewer 直接 `reader-top` 的 computed `left/right` float 是独立布局单元，解除阅读器 auto margin 后绝不得落入面向普通块的 C-04/C-18。对 static/relative、horizontal-tb/ltr、宽度不超过 40rem、水平 margin 可安全解析为有限非负值且不存在全页/全宽突破意图的单项 float，应在物理 float 侧写入 `max(0,(parentWidth-min(parentWidth,40rem))/2) + 作者同侧 margin`，另一侧保留作者 margin；百分比/未知/负 margin、复杂定位/书写模式、过宽或 breakout 等保守分支只写回本轮测得的作者布局。所有写回使用独立 `floatLayoutFixes` 完整快照，下一轮 measure/dispose 恢复原 inline 值及 priority。
- C-39 百分比 float 组必须以连续 viewer 直接子、同向/安全 writing-mode、`clear:none`、完整总和 99..101 的组为边界；禁止 DOM wrapper。安全组的 width 与首项版心 margin 写入必须使用独立 `floatLayoutFixes` 快照（含 width/max-width/margin priority 与 marker），先布局再以当前列几何事务验收；失败整组恢复并转入 C-31 防火墙，不得掉入 C-04/C-18。重排和 dispose 必须恢复，C-08 不得二次改写带 marker 的组成员。
- C-40 显式对称居中作者 margin 只在通用来源门控成立时跳过 C-04：元素必须是 viewer 直接 `reader-top`、`float:none`、`horizontal-tb`、`text-align:center`，作者水平 margin 必须可读、有限、正值且左右对称（0.5px 容差），并且不得有作者 width/min-width/max-width sizing intent、percentage/fit/fullpage 语义。`hasAuthoredSizingIntent` 对 inline/HTML 属性和可读作者 CSSOM 返回 true/false；reader 内建 `max-width:40rem` 不算作者 sizing，无法读取/无法证明则返回 unknown 并保守走原 C-04。B-024 的 `text-align:left`、固定/非对称盒、C-18/C-38/C-39 更高优先级路径不改变；不得按书名或类名特判。
- 所有 DOM 监听、章节 Blob URL 和计时器必须在替换或销毁时清理。
- `sanitizeChapter` 通过 `makeUrl` 产生的外链 CSS Blob URL 属于单次 paginator load 的局部集合：创建即登记；loadSeq 过期、sanitize 抛错、换章和 dispose 必须幂等撤销；只有 iframe 成功提交后才转为当前章节所有权。该集合不包含 ResourceServer 的共享图片/字体 URL。
- `measure(expectedLoadSeq)` 在字体等待、超时、双 rAF 等异步边界之后，以及进入 fit/margin/float/inline 兼容修正前，必须同时验证 `disposed`、`loadSeq`、`contentDoc` 与 `viewer` 身份；失配不得继续写布局。
- `measure` 的字体与双 rAF 等待各自拥有可取消 controller；新 load、cleanup、dispose 必须 abort/cancel 旧等待，并清理 timer/rAF。double-rAF 优先使用当前 iframe `document.defaultView` 的调度器。

## 4. UI 与状态

- `App` 是书架和阅读会话的顶层编排者；解析和分页细节不应复制到 UI 组件。
- `ReaderView` 负责 React 生命周期与 `ChapterPaginator` 的适配，不重新实现分页算法。
- hidden iframe 不参与指针命中，且浏览器可能把一段连续 wheel 锁定在外层目标；`ReaderView` 必须始终接收外层阅读区 wheel。加载期只保留最后方向，display-ready 后先让 App 登记当前稳定位置，再消费一次缓冲；随后同一外层滚轮流按 80px 阈值继续正常翻页。禁止把加载期原始事件建立成跨页/跨章队列。
- 工具栏布局必须按左右控件的实际 layout 宽度取对称侧轨，中间标题列使用 `minmax(0,1fr)` 承担收缩；宽屏在标题可完整显示时必须以 toolbar 中心为视觉中心。空间不足的窄屏可切回不对称 max-content 侧轨，但不得让标题与功能按钮重叠或通过隐藏/裁切按钮解决问题。宽屏标题可两行，窄屏使用单行省略号；完整标题继续由 `title` 属性提供，UI scale 只缩放工具栏而不改变正文。
- `ReaderView` 传给长生命周期 `ChapterPaginator` 的内部跳转、跳转前/完成通知和 display-ready 通知必须通过 latest ref 转发，不能捕获首次 render 的 loading 闭包。同章 fragment 不经过章节重载，必须在同步定位完成后单独通知 App 重新开放下一次历史捕获。目录、书签等 UI 入口自行捕获一次历史后调用“只执行 href”的跳转函数，避免同一操作重复入栈；历史回退/前进必须恢复章节、页码和内容锚点。
- 同章 TOC/书签入口必须先只读保存当前位置，只有 `navigateWithinCurrentChapter()` 成功后才提交 back 历史；history back/forward 只有 direct 成功后才采用 transition。direct 失败不得清 forward/back 或隐藏阅读器；目标无效时可保持原位，跨章和未 ready 兼容路径仍可按旧流程 reload。
- 设置中的正文字号与 UI 缩放是两套独立状态。
- ReaderView 的 `settings`/`userFonts` identity 变化通过 150ms 可取消 debounce 合并为最后一次 paginator `reloadWithSettings()`；章节、`anchorNonce`、book/server 生命周期和 dispose 必须取消 pending timer，切章只执行使用最新 render settings 的正常 `load`，不得额外触发设置 reload。`reloadWithSettings()` 必须在 await/load 前同步复制不可变 `ReadingAnchor` 与当前页，并传入 `readingAnchor` snapshot、`fallbackPage`；没有 content document 时不得清空已有 anchor。旧 reload 仍由 `loadSeq`、VisibilityGate、Blob ownership 和 measure abort 拒绝写入新文档/显示门。设置步进只有真实值变化才建立新的 settings identity；数值边界继续同方向点击必须返回原 identity，不产生无效 reload。
- 自定义 CSS 编辑使用本地 draft；输入不提交、不重载章节，只有明确点击“保存并应用”才调用父级提交。按钮在 draft 与已保存值相同或无改动时禁用，清空后仍可保存移除 CSS；恢复默认等外部值变化须同步 draft，关闭菜单不自动保存。
- 阅读位置至少包含章节、页码和可选内容锚点；初始/历史恢复有 anchor 时只使用 anchor，只有 anchor=null 才使用页码兜底；转场 pending/display gate 未完成时不得把旧 ready 状态写成新章节进度。文本-only anchor 可没有 legacy element index，内部 sentinel 不得写入存档或 Rust `usize` 字段。
- 书架打开应恢复进度；重复导入同一本书应保留原有进度和首次添加时间。
- 阅读进度写入必须保证同一本书最后稳定位置胜出：UI 先更新内存态，后台写入单通道串行并合并待写值；触发条件必须包含实际页/锚点状态，不能只依赖取整后的进度百分比。返回书架和 Tauri 关闭窗口前必须 flush。`markOpened` 只能修改 `isNew`，不能用陈旧整条记录覆盖进度。
- 章节字数统计由 App 的 generation-bearing counts ref/state 分离维护：当前完成章节从 ready anchor 的 `totalChars` 写入 measured，其余 linear 章节由可取消 idle job 每 slice 最多估算一章；结构 provisional 统计排除 script/style、hidden、`aria-hidden=true` 和明确脚注，但不承诺未访问章节的 computed CSS hidden。扫描未 complete 时 `resolveProgressPct` 必须沿用打开时书架 baseline，不能写临时 0/100；complete 后才用最新 counts 与当前 anchor 更新 baseline。旧 session/book/server 的回调不得写入新书；统计不得参与 CSS、分页或布局。
- B-050：书架的“读过/继续阅读”必须使用 `hasReadPosition` 阅读证据（`isNew=false`、非零位置/百分比或有效锚点），不得把暂时的 `progressPct=0` 当作未读；进度条仍只显示可用百分比。状态栏在 counts incomplete 时显示“计算中”，complete+estimated 显示“约 N%”，全 measured 才显示普通 N%。每次成功稳定位置写入同时清除 `isNew`，`markOpened` 仍只能执行 isNew-only 更新。
- B-050：章节 provisional 统计失败时写入 `error`/unknown 而非真实 0；纯媒体/无可见文字章节使用 `MEDIA_UNIT_CHAR_WEIGHT=1000` 每媒体单元的保守权重（SVG 内嵌 image 不重复计数），当前 measured 媒体章按 `pageCount * MEDIA_UNIT_CHAR_WEIGHT` 计算。只在最后一个 linear 章节最后一页允许明确 100%。
- B-050：结构 provisional counts 按 `contentHash ?? shelfId` 写入版本化、有界本机缓存；缓存严格校验版本、linear mask/长度和 safe integer，最多保留 256 个按 touchedAt 的 LRU 条目、总计数上限 100000，缓存不进入 portable archive，Quota/损坏必须按 cache miss 处理。打开时恢复 cached estimates 并跳过对应 job；job 使用带 100ms timeout 的有界 scheduler slice（默认最多 4 章），批量提交但不阻塞首屏，非 estimated 结果不得擦除已有 structural estimate。
- B-051：`TurnIntentBuffer` 按每本书生命周期区分首次 loading 与已显示后的跨章 loading。首次 display-ready 前 `request()` 必须完全丢弃且首次 `markReady()` 不消费 pending；首次 ready 只解锁并 reset 外层 wheel 累计。之后跨章 loading 继续保留最后方向单槽并在下一次 ready 消费一次；`reset` 只清 ready/pending、不抹除本书已显示历史，换书依靠 `ReaderView key`/新实例恢复初始锁。
- B-052：宿主 App 与 iframe `ChapterPaginator` 共用 `selectionGuard`；仅非编辑区域的 A/a + Ctrl 或 Meta 被 preventDefault，并清除对应 document 的 selection。`input`、`textarea`、`contenteditable` 及其后代放行；方向键翻页不受影响。进入 reader 的 `view/bookKey` 生命周期只清理一次宿主旧 selection，章节切换/设置重排不得清除正文手动选择。
- B-053/C-42：dark theme 的章节对比度修正只在 iframe load 后、首次 `prepareChapterForDisplay`/measure 前运行一次。扫描按 html 基底到 body 后代单次 DFS，每个元素只读取一次 computed style，并在父元素写入 inline 修正后再访问子元素，以保持真实继承。仅对 computed 前景近似主题 `rgb(212,212,212)`、有效合成背景下 contrast<4.5 且 `#1a1a1a` 显著改善的元素写普通优先级 inline color 与 `data-reader-dark-contrast`；背景容器可因子孙文本修正。background-image、未知颜色/合成、opacity<1 和作者明确不同颜色必须保守跳过；marker 随文档替换自然销毁，不参与翻页或 reflow。
- B-054/C-43：脚注 marker 与宿主 `FootnotePop` 共享 `FootnoteHoverGate`；marker/overlay 任一 enter 取消 140ms close grace，leave 只调度且重复 leave 不堆 timer，两者均离开且未 pinned 才触发一次 close。未固定且 gate 仍 visible 的同一 marker 重复 mouseover 不得重复 resolve/show/payload；普通正文或非脚注 anchor mouseover 完全不得触碰 gate，只有当前文档内经 `getFootnoteHoverAnchor` 确认的脚注 anchor 才能 marker-enter。show、点击 pinned、再次点击、正文空白、关闭按钮、章节 load cleanup 和 dispose 必须同步 visible/pinned/timer。`ReaderHandle.setFootnoteOverlayHover()` 是宿主 hover 转发边界；不改 popup CSS/定位/分页。
- B-055/C-44：`FootnotePayload.rect` 与 `FootnotePop` 必须共享 `.main` 局部坐标系；弹层 JSX 位于 `.main` 内、status bar 之前，z-index 保持 60。`placeFootnote` 对有限非负输入按 gap=8 输出非负 `left/top/cardWidth/maxHeight`：宽度不超过 `min(300, containerWidth-2gap)`，右/左与上/下按完整可见优先，均不足时按可用空间较大方向 clamp；容器不足时 maxHeight 为 height-2gap。真实 card/main 尺寸变化才更新 state，ResizeObserver/resize listener 必须 cleanup，不改变 B-054 hover gate 或分页。
- B-056/C-45：dark theme 的章节覆盖样式仅在 `buildOverrideCss` 中为 `#epub-viewer` 注入普通优先级 `text-shadow: 1px 1px 1px #1e1e1e`，通过 CSS 继承为浅色盒/复杂背景提供可读性兜底；不得写成 `#epub-viewer *` 或 `!important`，不得在 light/sepia 注入。作者后代明确的 `text-shadow`（包括 `none`）依靠正常级联覆盖；不改 `applyDarkThemeContrast`、分页或 Rust。

- B-058/C-47：字体设置必须区分 `fontSource="system"|"imported"` 与 `customFontId`；跟随书籍时清空 source/id/name。旧版只有 `customFontName` 时，字体元数据到达后尽量绑定 imported id，缺失时安全回退。localStorage 和 portable archive 保存 source/id/name，不保存系统字体路径或 Blob URL。
- B-058/C-47：`system_fonts_list` 仅由 Tauri Windows 首次打开字体中心时调用，返回 DirectWrite 的 `family`/`localizedNames`，不得返回路径或读取系统字体文件；结果会话缓存。非 Windows 返回空列表，Android 仅接口预留。枚举 loading/error/empty 必须可见；系统字体缺失或命令失败不得后台清空 persisted system family。
- B-058/C-47：导入字体启动只调用 `FontStore.list()` 元数据；仅当前 imported id 调用一次 `readFont` 并创建 Blob URL。懒加载竞态不得让旧读取覆盖新选择；新 URL 创建成功后才 revoke 旧 URL，读取失败保留旧 URL；切换到书籍/system 和卸载必须释放活动 URL。
- B-058/C-47：FontSettingsPanel 独立于主菜单，提供 tabs、搜索、导入/删除与当前选择；系统/导入列表使用固定行高虚拟窗口，必须有总高度及 top/bottom spacer、overscan 和 clamp，能够滚动到最后一项；列表行不默认用自身字体渲染。面板 z-index=42，backdrop z-index=41，关闭任一层不得留下不可达状态。
- B-058/C-47：注入 CSS 的 family 字符串必须转义反斜杠、双引号、CR、LF、form-feed 等 CSS 字符串控制字符；system family 只写 `font-family`，不得生成 `@font-face`，imported 仅使用当前选中 Blob 的一个 `@font-face`。
- B-059/C-48：正文搜索仅对当前打开的可重排 EPUB 提供按需 `SearchSession`；首次非空查询按 spine 顺序提取并在本次书籍会话缓存章节文本，逐章让出主线程并报告进度，关闭/切书/dispose 必须取消并释放 session。标准化正文和字符映射必须使用紧凑字符串/TypedArray 一类有界结构，不得为每个字符长期保留 JavaScript 对象，也不得为每条命中重复拆分整章。不得在打开书籍时预扫描，不生成持久化索引，不进入存档。
- B-059/C-48：搜索文本按可见结构提取；`script/style/noscript/template/head`、`hidden`、`aria-hidden` 和脚注排除，块级元素形成边界、行内元素可拼接。标准化使用 NFKC、小写、软连字符移除及布局空白处理，并保留原文范围映射。支持标准化短语和同一上下文内多关键词 AND，短语优先去重；不把编辑距离、OR、前缀、邻近或语义搜索伪装成首版能力。
- B-059/C-48：查询使用 180ms debounce、AbortController 和 generation 门，旧查询不得回写新结果；结果最多保留 101 条，UI 最多展示 100 条。结果须提供章节路径/标题、原文片段和 UTF-16 高亮范围，并携带现有 code-point 文本锚点与 32 字符锚点片段。
- B-059/C-48：结果预览不得写阅读进度；仅用户点击结果时才执行跳转并记录现有最多 3 步 back/forward 历史。同章优先 direct 定位，跨章经过 display gate；fixed-layout 书籍不得显示搜索入口。搜索结果不得依赖全书百分比定位。
- B-060/C-49：正文笔记锚点使用章节 path/spine、Unicode code-point 起止 offset、首尾有界 snippet 与选中文字；不得以页码或全书百分比作为笔记身份。跳转必须进入既有 3 步 back/forward 历史；解析失败不得猜测其他正文。
- B-060/C-49：笔记下划线只用 iframe 内 CSS Custom Highlight，不得用 span 包裹、改写 EPUB DOM 或触发章节重排。只为当前章节建立文本索引与 ranges；API 不可用时保留数据和列表、降级为无下划线。
- B-060/C-49：笔记属于 portable library record，同 ID 以较新 updatedAt 合并且不得携带设备路径。前端/Rust 均限制有效非空字段、4096 code-point 选区和 10000 code-point 内容；列表必须可分批访问全部记录。
- B-061/C-50：`preloadNextChapter` 是兼容保留的内部字段，界面名称为默认关闭的“高性能模式”；它不属于活动章节布局身份，单独切换不得重载当前 paginator。fixed-layout 必须禁用；关闭时只能保留当前 iframe/paginator，开启时最多保留上一篇/当前篇/下一篇三个同尺寸槽位，后台槽可布局但不可见、不可交互。调度必须先完成下一篇，再开始上一篇，不能并发执行两个隐藏完整分页任务。
- B-061/C-50：预渲染必须复用 `ChapterPaginator.loadAndWaitForDisplay()` 的完整字体、补偿、重算与最终定位边界；不得只等待 sanitize 或 iframe load。后台 slot 的 state/issues/链接/脚注/选区/翻页/display-ready 全部以 active identity 门控，绝不能写 App 当前状态。
- B-061/C-50：缓存提升只能在 React 已提交目标 spineIndex 的章节 effect 中进行，并再次核验 linear 相邻关系、path、最终 ready 与 slot 身份；显式目录/搜索/书签/笔记/历史跳转不得提升缓存，未命中/失败走原 P0。顺序提升后旧活动槽保留为反向缓存。设置/字体/尺寸变化、关闭模式、切书和 dispose 必须取消并释放全部备用 paginator；书籍结束时去重 dispose 所有 slot 后才 `ResourceServer.revokeAll()`。
- 结束书籍会话时先 flush 最新进度，再由 React 提交卸载 ReaderView/paginator；其 cleanup 完成资源撤销后，App 才清空 `book/server/bookKey/initialAnchor/currentShelfId/chapterCounts` 等会话状态。页面中心只用于观察锚点，不参与阅读器布局或渲染规则。
- 批量导入期间不得逐本替换书架列表；导入结果在全部完成后一次性合并，既有封面组件不应因每本完成而重复刷新。
- 外链只允许交给系统安全打开 `http`、`https`、`mailto`、`tel`。

## 5. 存储

- `ShelfStore` 是 UI 可依赖的唯一书架存储接口。
- Tauri 桌面书库默认引用用户源 EPUB，不复制正文。删除条目、清空状态和卸载应用均不得删除源文件；只有用户明确执行独立的源文件删除操作时才可改变此边界。
- 可同步 `LibraryRecord` 与设备本地 `DeviceBinding` 必须分离。同步数据以完整 EPUB 字节 SHA-256 为身份，不得包含绝对路径；绑定保存当前设备路径、大小、mtime 与封面条目定位。
- Tauri 的书本 ID、源路径和 ZIP 条目必须由 Rust 校验。前端可以选择/重新定位源文件，但不能提供任意目标写入路径。
- 首次导入在 Rust 侧流式哈希；启动只做 path/stat 快速检查，文件未变化不得重复读取全书。精确重复仍以 SHA-256 判断，文件名变化不得产生新记录或覆盖旧进度。
- 状态与绑定索引更新必须经同一写入互斥并使用同目录临时文件替换。批量导入应集中提交，不得为每本书反复读写完整索引。
- `library-records.json` 必须能脱离绑定独立恢复；`device-bindings.json` 缺失、孤立或校验失败时只把对应书标记为不可用。两个独立 JSON 只能分别原子替换，不得假称为跨文件原子事务；若未来要求进程崩溃级跨文件一致性，应引入 journal/世代清单后再改变契约。
- 打开正文前必须验证当前绑定；stat 签名变化时重新流式哈希，内容哈希不匹配不得把旧记录的进度套到新文件。源文件读取与封面 ZIP 条目读取必须有尺寸/路径边界，重新关联只有完整哈希精确匹配才成功。
- C-41 封面元数据由 TypeScript 浏览器预览与 Rust 链接导入共享同一候选顺序：EPUB3 `cover-image`、EPUB2 `meta[name=cover]`、manifest href basename stem 精确为 `cover`。href 必须先移除 query/fragment、URL 解码并按 OPF 目录规范化；候选必须存在并为 `image/*`，或由 jpg/jpeg/png/webp/avif/gif/svg 扩展名推断为图片。Rust 必须保留 manifest 源顺序并仅用已打开 ZIP 的 `by_name` 查询候选，不得扫描/解压全部 ZIP、额外哈希或在启动时迁移旧 binding；失效的高优先级候选必须继续 fallback。桌面导入差异来自 Rust 原生链接书库解析，不是 WebView2 图片解码差异。
- 阅读进度保持“最后稳定值胜出”：前端合并连续更新，返回书架、隐藏和正常关闭时 flush；`markOpened` 只能改变 `isNew`。当前章分子优先文本 offset；仅没有可用文本锚点时可按当前页比例估算，不能把已恢复的 legacy anchor 写成 0 字。`linear=no` 可恢复但不贡献其自身全书权重。
- B-050：新导入记录的 `lastReadAtMs`/`last_read_at_ms` 必须为 0，最近阅读 UI 在 0 时回退 `addedAtMs`；成功 `updateProgress` 必须设置 `isNew=false`。portable merge 先按 `hasReadEvidence` 区分真实位置与 import-only 记录，再按 `lastReadAtMs` 决胜，保持最早 addedAt、`isNew` AND 和书签合并。
- `ShelfProgressWriter.beginSession(id)` 只重置该书的首次稳定写入门；调用方必须先完成上一个会话 flush，再开始新打开，不能破坏 in-flight/pending 最新值合并。
- 缩略图是设备缓存：只对接近视口的卡片生成/读取，全局并发最多 4，派生尺寸最多 240×360，单项最多 5 MiB，总量最多 100 MiB 并按 LRU 淘汰；只接受 JPEG/WebP 派生结果。它不得进入同步存档，删除条目时应删除对应缓存，缓存缺失不能影响打开正文。
- 版本 1 存档只包含可同步记录和经过白名单/范围校验的阅读器设置；不得包含源路径、设备绑定、正文、封面原图、缩略图或自定义 CSS 中的本机 `file:`/绝对路径。导入时按 `contentHash` 合并，较新的稳定进度和书签胜出；没有本机绑定的记录保留为不可用，等待用户重新定位。
- 桌面 EPUB/存档路径只通过系统文件选择、桌面拖放或受控命令进入；存档文本由 dialog/fs 插件保存和读取。桌面运行时不得重新注册旧复制正文/封面与 `shelf.json` 命令。
- 浏览器 IndexedDB 仅为隔离预览后端，不承诺持久源路径；真实链接书库行为以 Tauri 后端为准。
- 本次契约改变经用户明确同意不迁移测试书库。切换时可以删除旧托管正文和缓存，但不得扫描或删除用户原始 EPUB。
- B-062/C-51：书架筛选只消费已持久化元数据，不得在打开抽屉或切换筛选时读取源 EPUB。`language` 是可选同步字段；旧记录缺失必须归入“未知语言”。浏览器和 Rust 新导入取 OPF 第一个非空 `dc:language`，portable archive v1 以可选字段向后兼容。
- B-071/C-52：阅读器所有前台界面必须由单一 `ReaderForeground` 判别联合仲裁。普通 panel、正文 transient 和 modal 不得同时渲染；字体中心仅是 menu 子视图。modal 拒绝其它打开转换；替换 footnote/selection 时 App 必须分别完成 paginator dismiss/hover reset 与 iframe selection 清理。新增前台功能扩展 union 和 renderer，禁止新增独立 `xxxOpen` 真源或用 z-index 代替互斥。
- B-062/C-51：作者分类键使用 NFKC，并仅移除 Han/Hiragana/Katakana 字符之间的 Unicode `White_Space`/`Cf`；不得覆盖原始 `creator`，不得删除西文姓名内部空格。UI 必须复用 `createShelfFilterModel` 的索引、匹配和交叉计数，不维护第二套规范化实现。

## 6. 渲染规则变更

任何渲染变化必须回答：

1. 这是书籍内容问题、阅读器规则问题，还是浏览器引擎问题？
2. 属于 `rendering-layers.md` 的哪一层？
3. 是否需要 `!important`，会覆盖哪些书籍规则？
4. 是否能用通用触发条件代替书名或类名特判？
5. 使用哪个本地样本或合成章节验证？
6. 是否已写入 `BUGFIX_LOG.md` 和 CSS 冲突台账？

## 7. 契约变更流程

确有必要改变上述行为时，不应静默修改本文。任务记录中必须说明：

- 原契约为什么不再适用；
- 新契约是什么；
- 旧书架数据或旧 EPUB 行为如何处理；
- 使用什么回归证据证明变化可接受。

## 8. 桌面外壳

- Tauri 桌面运行时同一时间只能保留一个应用实例；浏览器 `pnpm dev` 不受此约束。
- 官方单实例插件必须先于其他 Tauri 插件注册。后续启动通知到达时，已有 `main` 窗口按“显示、取消最小化、聚焦”顺序恢复；窗口暂时不存在或单步窗口调用失败不得让现有实例退出。

## B-057/C-46：强制横排设置契约

- `ReaderSettings.forceHorizontal` 缺省/旧存储 `undefined` 等同 `false`；`DEFAULT_SETTINGS` 明确写入 `false`。
- `App` 负责初始化、localStorage 写入、恢复默认和存档导入；`MenuPanel` 只提交布尔切换，现有 `ReaderView` settings identity/debounce/reload 负责重载并保留锚点。
- `ReaderView` 对 `book.fixedLayout` 将有效渲染设置中的 `forceHorizontal` 置为 false；固定版式不被横排覆盖。
- `sanitizeChapter` 仅在开启时注入 `writing-mode: horizontal-tb !important`、`-webkit-writing-mode: horizontal-tb !important` 和 `text-orientation: mixed !important`。规则覆盖 html/body/viewer 及不在 SVG 树内的普通后代，不声明 `direction`。
- SVG 及其后代排除后代覆盖选择器；SVG 内显式声明的书写模式按 CSS 级联保留。仅依赖 html/body 继承、但 SVG 内未声明的原始竖排状态无法凭 CSS 恢复，这是已知边界。
- light/dark/sepia 不改变横排规则；设置持久化与 portable archive 白名单必须同时保留该字段。
