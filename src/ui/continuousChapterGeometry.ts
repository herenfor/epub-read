/**
 * 连续滚动章节高度的“可提交”判定。纯函数、无 DOM 依赖，便于单测。
 *
 * 背景：连续滚动视图用绝对定位的章节包裹层承载 iframe，章节未就绪时包裹层
 * 处于 `display: none`。此时 iframe 既不参与布局，也不产生任何 rect，任何高度
 * 测量都会得到 0。若把 0 当作“已测量”提交进布局，整本书的总高会塌成 0
 * （`ContinuousChapterLayout.project` 会跳过所有 height === 0 的章节），
 * 于是投影窗口为空、iframe 永远不挂载、阅读器停在加载态。
 *
 * 因此 0 高度只代表“此刻还测不准”，不代表“这一章真的没有内容”：
 * 必须保留估算高度并安排重测，只有正的、且元素确实参与布局的测量结果才可提交。
 */
export interface ContinuousChapterHeightSample {
  /** 章节真实内容高度；测不准时为 0 或负数。 */
  readonly height: number;
  /** 承载该章节 iframe 的元素是否已参与布局（脱离文档树或祖先 display:none 时为 false）。 */
  readonly laidOut: boolean;
}

export function canCommitContinuousChapterHeight(sample: ContinuousChapterHeightSample): boolean {
  return sample.laidOut && Number.isFinite(sample.height) && sample.height > 0;
}
