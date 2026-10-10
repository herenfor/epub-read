import { defineMessages } from "../defineMessages";

/** Full-screen image viewer opened from a picture in the book. */
export const imageViewer = defineMessages("imageViewer", {
  "imageViewer.dialog": "图片查看",
  "imageViewer.controls": "图片查看控件",
  "imageViewer.openLink": { zh: "打开链接", max: 14 },
  "imageViewer.zoomOut": "缩小",
  "imageViewer.zoomIn": "放大",
  "imageViewer.fit": "适配窗口",
  "imageViewer.actualSize": "原始大小",
  "imageViewer.compare.tip": "按住临时查看原图，松开恢复滤镜",
  "imageViewer.compare": { zh: "原图", note: "Hold-to-compare button: show the image without filters.", max: 10 },
  "imageViewer.close": "关闭",
});
