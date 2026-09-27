/**
 * 连续滚动章节高度的“可提交”判定。纯函数、无 DOM 依赖，便于单测。
 *
 * 背景：连续滚动视图用绝对定位的章节包裹层承载 iframe，章节未就绪时包裹层
 * 处于 `display: none`。此时 iframe 既不参与布局，也不产生任何 rect，任何高度
 * 测量都会得到 0。若把这种 0 当作“已测量”提交进布局，整本书的总高会塌成 0
 * （`ContinuousChapterLayout.project` 会跳过所有 height === 0 的章节），
 * 于是投影窗口为空、iframe 永远挂载不上、阅读器停在加载态。
 *
 * B-151 进一步区分两种 0：
 * - pending：容器未布局，或资源/字体/显示门尚未完成本轮 ready，测量不可信；
 * - empty：容器已参与布局且本章 display-ready 后测得的真实零内容。
 *
 * 因此最终提交不能只看 `height >= 0`，也不能继续把已就绪空章判成 pending。
 */
export type ChapterMeasurement =
  | { kind: "pending" }
  | { kind: "empty"; height: 0 }
  | { kind: "content"; height: number };

/**
 * `contentHeight` 必须来自真实绘制内容测量，不含“全书完”等阅读器节点或
 * 人为留白；`displayReady` 为 true 代表本轮资源/字体/布局显示门已完成。
 */
export function classifyChapterMeasurement(input: {
  displayReady: boolean;
  viewportLaidOut: boolean;
  contentHeight: number;
}): ChapterMeasurement {
  if (
    !input.displayReady ||
    !input.viewportLaidOut ||
    !Number.isFinite(input.contentHeight) ||
    input.contentHeight < 0
  ) {
    return { kind: "pending" };
  }
  return input.contentHeight === 0
    ? { kind: "empty", height: 0 }
    : { kind: "content", height: input.contentHeight };
}

export interface ContinuousChapterHeightSample {
  /** 章节真实内容高度；测不准时为 0 或负数。 */
  readonly height: number;
  /** 承载该章节 iframe 的元素是否已参与布局（脱离文档树或祖先 display:none 时为 false）。 */
  readonly laidOut: boolean;
}

/**
 * @deprecated 保留给旧的“只提交正高度”路径；B-151 的最终分类请使用
 * {@link classifyChapterMeasurement}，以便 zero 在 display-ready 后可提交为 empty。
 */
export function canCommitContinuousChapterHeight(sample: ContinuousChapterHeightSample): boolean {
  return sample.laidOut && Number.isFinite(sample.height) && sample.height > 0;
}
