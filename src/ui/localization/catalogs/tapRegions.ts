import { defineMessages } from "../defineMessages";

/**
 * Tap-to-turn region settings and preview (ReaderTapRegionsPanel).
 * Not registered in catalog.ts yet: the integrator registers it and maps
 * TAP_REGION_LABEL_KEYS through t() into the panel's labels prop.
 */
export const tapRegions = defineMessages("tapRegions", {
  "tapRegions.title": { zh: "点击翻页区域", max: 20 },
  "tapRegions.scope.pc": { zh: "仅用于电脑端，手机和平板单独设置", note: "The panel edits the desktop profile only." },
  "tapRegions.scope.touch": { zh: "仅用于手机和平板，电脑端单独设置", note: "The panel edits the touch-device profile only." },
  "tapRegions.preview.note": { zh: "预览按当前阅读区域的比例显示，点按预览不会翻页", note: "Under the preview drawing." },
  "tapRegions.size": { zh: "区域大小", max: 8 },
  "tapRegions.mode.default": { zh: "默认", max: 8 },
  "tapRegions.mode.custom": { zh: "自定义", max: 8 },
  "tapRegions.range.hint": { zh: "每侧 0～35%，设为 0 即关闭该侧；中间至少保留 30%", note: "Under the two sliders." },
  "tapRegions.left": { zh: "左侧", max: 6 },
  "tapRegions.right": { zh: "右侧", max: 6 },
  "tapRegions.center": { zh: "中间", max: 6 },
  "tapRegions.center.action": { zh: "正文操作", note: "Middle area: taps reach the book text (menus, links, selection).", max: 10 },
  "tapRegions.prev": { zh: "上一页", max: 8 },
  "tapRegions.next": { zh: "下一页", max: 8 },
  "tapRegions.off": { zh: "关闭", note: "A side whose tap area is set to 0.", max: 6 },
  "tapRegions.narrowed": { zh: "阅读区域较窄，两侧已自动收窄以保留中间区域" },
  "tapRegions.scrollMode": { zh: "滚动模式不使用点击翻页，设置在分页模式生效" },
  "tapRegions.leftForward": { zh: "左侧点击也下一页", note: "Touch-only switch: a tap on the left area also turns forward.", max: 28 },
  "tapRegions.leftForward.hint": { zh: "开启后左右两侧都翻到下一页；滑动、键盘和其他返回方式不变" },
  "tapRegions.reset": { zh: "恢复默认", max: 12 },
});

/** ReaderTapRegionsLabels field → message key. */
export const TAP_REGION_LABEL_KEYS = {
  title: "tapRegions.title",
  scopePc: "tapRegions.scope.pc",
  scopeTouch: "tapRegions.scope.touch",
  previewNote: "tapRegions.preview.note",
  size: "tapRegions.size",
  modeDefault: "tapRegions.mode.default",
  modeCustom: "tapRegions.mode.custom",
  rangeHint: "tapRegions.range.hint",
  left: "tapRegions.left",
  right: "tapRegions.right",
  center: "tapRegions.center",
  centerAction: "tapRegions.center.action",
  prev: "tapRegions.prev",
  next: "tapRegions.next",
  off: "tapRegions.off",
  narrowed: "tapRegions.narrowed",
  scrollMode: "tapRegions.scrollMode",
  leftForward: "tapRegions.leftForward",
  leftForwardHint: "tapRegions.leftForward.hint",
  reset: "tapRegions.reset",
} as const satisfies Record<string, keyof typeof tapRegions.zh>;
