# B-071/C-52：阅读器前台层统一仲裁

- 状态：代码、自动化与生产构建完成，归入 `0.1.9-beta.1`；待 Windows WebView2 交互验收。
- 目标：菜单、目录、书签、搜索、笔记和日志只能有一个处于前台；脚注/选区菜单与普通面板互斥；笔记编辑器独占整个前台。

## 状态模型

- `ReaderForeground` 是唯一真源：`none | panel | transient | modal`。
- 普通 panel：`menu | toc | bookmarks | search | notes | log`。
- 字体中心是 menu 的 `main/fonts` 子视图，不是第二个前台状态。
- transient：携带 payload 的正文选区菜单或脚注；二者互斥并替换普通 panel。
- modal：携带 create/edit draft 的笔记编辑器。modal 存在时拒绝工具栏 panel 和 iframe transient 打开，关闭后回到 none，不恢复旧层。
- 新增普通功能只需扩展 `ReaderPanelId`、对应渲染和入口，不得重新增加 `xxxOpen` 独立 boolean。

## 生命周期与例外

- 目录导航仍可保持目录打开以连续选择；搜索结果仍可保持搜索面板；书签/笔记跳转沿用原有关闭语义。
- 替换脚注必须同步 paginator dismiss/hover reset；替换选区菜单必须清除 iframe 原生选区。
- Escape、backdrop、关闭按钮、切书和返回书架均走统一 foreground close。
- 笔记编辑器遮罩使用 fixed 覆盖完整应用，工具栏不会呈现可操作假象。
- z-index 只负责同一 foreground 类型的视觉层级，不再承担业务互斥。

## 验证

- 状态转换及 App 单一真源/模态遮罩契约：6/6。
- Luna High 定向验证：4 文件/16 用例与 `tsc --noEmit`。
- 主代理审核后：全量 Vitest 53 文件/420 用例；TypeScript 与 Vite production build（111 modules）通过。
- 待 Windows 验证所有工具栏入口两两切换、Escape、backdrop、脚注/选区替换以及笔记编辑期间工具栏阻断。
