# B-059/C-48：当前书正文基础搜索

- 状态：代码、自动化与 WSL Chromium 实机验收完成，待用户确认交互与 Windows WebView2 实机表现。
- 对应能力：当前打开书籍的按需正文搜索；这是搜索到 RAG 路线的首个实现切片，不包含跨书检索、向量检索或 AI 功能。
- 编号核对：在既有文档最高 B-058/C-47 之后登记 B-059/C-48。

## 第一版范围

- 搜索范围仅为当前打开的可重排 EPUB；fixed-layout 书籍不显示搜索入口。
- 关闭/切书时释放 session、取消进行中的查询并阻止旧代次回写；不持久化正文索引，不进入阅读存档。
- 第一次有非空查询时按 spine 顺序提取章节，按章节缓存于当前书籍会话；每章处理后主动让出主线程并报告进度。
- 标准化正文保存为紧凑字符串，原文/锚点映射使用 `Uint32Array`，不为每个字符创建 JavaScript 对象；锚点片段从命中位置最多扫描 32 个 code point，不为每条结果重复拆分整章。
- 排除 `script/style/noscript/template/head`、`hidden`、`aria-hidden` 和脚注结构；块级元素形成上下文边界，行内元素可自然拼接。
- 标准化使用 NFKC、小写、软连字符移除和布局空白处理；保留原文与标准化文本之间的范围映射。
- 支持标准化短语匹配，以及同一段落/上下文内的多关键词 AND 匹配；短语结果优先并去重。
- 结果最多保留 101 条供截断判断，界面最多显示 100 条；显示章节名、上下文片段和原文命中高亮。
- 点击结果才执行阅读跳转：使用现有 code-point 文本锚点和 32 字符锚点片段；预览结果不改变阅读进度，点击跳转记录现有最多 3 步历史。
- 当前章节优先 direct 定位，跨章节经过既有 display gate；搜索输入使用 180ms debounce，查询支持取消和 generation 防旧结果回写。

## 明确不属于本版

- 跨书全文搜索、SQLite FTS/持久化倒排索引、n-gram/编辑距离模糊搜索、OR/前缀/邻近搜索。
- 简繁转换、日文假名归一化、正则表达式、搜索历史、语义检索、标签、RAG 与模型调用。
- 固定版式 EPUB 的精确搜索定位。

## 验证

- 全量 Vitest：46 files/377 tests；搜索核心 8/8；`tsc --noEmit`；Vite build 106 modules。
- WSL Chromium 900×650 使用《ePub指南——从入门到放弃 20230418.epub》搜索“opacity 属性”：得到 4 条结果，标准化命中 `opacity属性` 并正确高亮。
- 点击结果后 back 可用；back 后 forward 可用；forward 返回正文仍包含 `opacity`。
- 临时测试脚本、截图和书籍文件均未进入仓库；开发服务器已停止，5173 无监听。
- B-068 Windows 修复：章节正文提取改为严格 XML/XHTML 优先、parser error 时才退回 HTML，避免 WebView2 按 HTML 规则误解 XHTML 自闭合 head 标签并得到空正文。新增有效 XHTML 与畸形旧 HTML 两类回归；当前全量 Vitest 52 files/410 tests、tsc、Vite 110 modules 通过，`0.1.9-beta.1` Windows 发布包待复验。
- B-070 输入框修复：隐藏 Chromium/WebView2 原生 search cancel/decoration/results 伪元素，只保留应用自定义清除按钮；长查询保持单行内部水平滚动，面板不扩宽并为按钮预留 40px。当前全量 Vitest 52 files/414 tests、tsc、Vite 110 modules 通过。

## 后续接口方向

当前 `SearchResult` 已携带 spine index、章节路径/标题、原文片段范围和既有文本锚点，可供后续持久化索引、跨书检索或 RAG 引用复用；本任务不提前引入这些存储与模型依赖。
