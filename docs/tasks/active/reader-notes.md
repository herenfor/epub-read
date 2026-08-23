# B-060/C-49：正文笔记首版

- 状态：代码、自动化与 WSL Chromium 回归完成，待用户及 Windows WebView2 审核。
- 目标：在可重排正文中选中文本，通过自定义右键菜单添加笔记；提供按时间倒序的本书笔记页、编辑、删除、原文跳转和既有三步撤销/前进。
- 锚点：保存章节 spine/path、Unicode code-point 起止 offset、首尾各不超过 32 字符的片段和选中文字。章节内容轻微漂移时在原位置附近解析；不能可靠解析时不猜测。
- 渲染：使用 iframe 内 CSS Custom Highlight API 的 `reader-notes` 下划线，不包裹或修改 EPUB DOM，不参与测量、分页和阅读进度。没有 API 的内核只是不显示下划线，笔记数据和列表仍保留。
- 存储：笔记属于书架记录，进入无设备路径的 portable archive；同 ID 合并采用较新的 `updatedAtMs`。选择上限 4096 code points，笔记内容上限 10000；前端和 Rust 同时校验。
- 性能：不预扫描整书；只解析和高亮当前章节笔记。列表初始渲染最近 200 条，可分批显示全部记录。
- 验证：首版前端 Vitest 50 files/393 tests、Rust 18/18；B-069 后当前全量 Vitest 52 files/411 tests、TypeScript、Vite production build（110 modules）通过。WSL Chromium 首版链路已通过；B-069 的 Windows WebView2 选区末端定位与 iframe 左键关闭待 beta.1 实机确认。
- B-069 菜单生命周期：右键菜单以 Range 最后一个可见片段为锚点；仅在菜单打开后监听 iframe selectionchange，变化时刷新末端坐标，折叠/失效时关闭。宿主关闭同时清除 iframe 原生选区，普通选择过程不增加持续索引成本。
- 待确认：Windows WebView2 的右键、剪贴板、CSS Highlight 颜色与大量笔记列表观感。
