# C-57：字体拖动导入

- 状态：代码与自动化完成，待 Windows WebView2 实机验收。
- 版本基线：`0.1.9-beta.2` 开发阶段。

## 目标

字体设置页面除文件选择外，允许一次拖入一个或多个 TTF、OTF、WOFF、WOFF2 文件。浏览器预览与 Windows 发行版必须共用原有哈希、持久化和选中字体链路。

## 实现边界

- 浏览器使用字体面板内的 HTML5 drag/drop，并阻止事件冒泡到全局 EPUB 导入。
- Windows WebView2 使用 Tauri `onDragDropEvent`；按物理坐标和设备缩放判断是否落在字体面板内，再通过 `plugin-fs.readFile` 读取路径。
- 面板外继续只处理 EPUB；非 EPUB/非字体文件不读取。
- 多字体严格串行读取、哈希和写入，使用同步 busy ref 防止相邻 drop 批次竞态。
- `dragenter`/`dragleave` 使用深度计数，经过面板子元素时不闪烁；关闭面板清除原生高亮。
- 混合拖入同时报告成功字体数和忽略文件数。

## 验证

- 字体拖放 helper：5/5。
- 前端全量 Vitest：73 文件/509 用例。
- TypeScript `--noEmit` 通过。
- Vite production build：137 modules。

## Windows 验收

- [ ] 100%、125%、150% 系统缩放下，字体拖入面板内均显示高亮并成功导入。
- [ ] 同一批拖入多个字体，列表完整且最终字体可用于正文。
- [ ] 字体与非字体混合拖入时只导入字体，提示数量正确。
- [ ] EPUB 拖到字体面板外仍进入书架导入；字体拖到面板外不出现 EPUB 导入遮罩。
