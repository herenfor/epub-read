import { defineMessages } from "../defineMessages";

/** Full-screen image viewer opened from a picture in the book. */
export const imageViewer = defineMessages("imageViewer", {
  "imageViewer.dialog": "图片查看",
  "imageViewer.controls": "图片查看控件",
  "imageViewer.openLink": { zh: "打开链接", max: 14 },
  "imageViewer.zoomOut": "缩小",
  "imageViewer.zoomIn": "放大",
  "imageViewer.zoomToggle": { zh: "{percent}%，点按在适配窗口和原始大小之间切换", note: "Label of the zoom percent button; {percent} is a number." },
  "imageViewer.rotateLeft": "向左旋转",
  "imageViewer.rotateRight": "向右旋转",
  "imageViewer.previous": "上一张",
  "imageViewer.next": "下一张",
  "imageViewer.counter": { zh: "第 {current} 张，共 {total} 张", note: "Screen-reader label for the image counter shown as “2 / 4”." },
  "imageViewer.compare.tip": "按住临时查看原图，松开恢复滤镜",
  "imageViewer.compare": { zh: "原图", note: "Hold-to-compare button: show the image without filters.", max: 10 },
  "imageViewer.close": "关闭",
});
