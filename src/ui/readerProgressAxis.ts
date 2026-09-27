/**
 * 统一固定内容进度轴与 Scrubber 状态机（Zen UI）
 *
 * 规范与拓扑参见 docs/tasks/active/progress-scrubber-review.md
 */

export type AxisInput = Readonly<{
  key: string;
  spineIndex: number;
  weight: number;
}>;

export type AxisSegment = AxisInput & Readonly<{ start: number; end: number }>;
export type ContentPoint = Readonly<{ key: string; fraction: number }>;

export interface ContentAxis {
  readonly segments: readonly AxisSegment[];
  locate(ratio: number): (ContentPoint & { spineIndex: number }) | null;
  ratioAt(point: ContentPoint): number | null;
}

export const unit = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * 输入来自本次书籍会话一次性冻结的完整结构统计：唯一 key、有限非负 weight。
 * unknown/error 不能传 0；零权重明确表示结构无正文/媒体，不占进度条区间。
 * 不接收 DOM 高度，也不在滚动、字号变更或单章 measured 回调中重建。
 */
export function createContentAxis(input: readonly AxisInput[]): ContentAxis {
  const positive = input.filter((item) => Number.isFinite(item.weight) && item.weight > 0);
  const total = positive.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0 || positive.length === 0) {
    return {
      segments: [],
      locate: () => null,
      ratioAt: () => null,
    };
  }

  let before = 0;
  const segments: readonly AxisSegment[] = positive.map((item, i) => {
    const start = before / total;
    before += item.weight;
    return {
      ...item,
      start,
      end: i === positive.length - 1 ? 1 : before / total,
    };
  });
  const byKey = new Map(segments.map((segment) => [segment.key, segment]));

  return {
    segments,
    /** 精确接缝归下一章；100% 归最后非空章末。仅 UI 展示时四舍五入。 */
    locate(ratio: number): (ContentPoint & { spineIndex: number }) | null {
      if (!Number.isFinite(ratio) || segments.length === 0) return null;
      const r = unit(ratio);
      const segment = segments.find((item) => r < item.end) ?? segments[segments.length - 1];
      const span = segment.end - segment.start;
      return {
        key: segment.key,
        spineIndex: segment.spineIndex,
        fraction: span > 0 ? unit((r - segment.start) / span) : 0,
      };
    },
    ratioAt(point: ContentPoint): number | null {
      const segment = byKey.get(point.key);
      if (!segment || !Number.isFinite(point.fraction)) return null;
      return segment.start + unit(point.fraction) * (segment.end - segment.start);
    },
  };
}

export type ScrubToken = Readonly<{ session: number; request: number }>;
export type CommittedProgress = Readonly<{ ratio: number; atEnd: boolean }>;

export type ScrubUiState = Readonly<{
  session: number;
  actual: CommittedProgress | null;
  preview: number | null;
  pending: (ScrubToken & { ratio: number }) | null;
}>;

export type ScrubUiEvent =
  | { type: "reset"; session: number }
  | { type: "preview"; session: number; ratio: number | null }
  | { type: "begin"; token: ScrubToken; ratio: number }
  | { type: "settled"; token: ScrubToken; actual: CommittedProgress }
  | { type: "failed" | "cancelled"; token: ScrubToken }
  | { type: "sample"; session: number; actual: CommittedProgress };

export function initialScrubUi(session: number): ScrubUiState {
  return { session, actual: null, preview: null, pending: null };
}

/**
 * 仅控制显示，不拥有导航票据。sample 只接受宿主已就绪且未被旧定位污染的采样。
 * settled 必须携带本次实际提交位置，不拿请求 ratio 冒充 actual。
 */
export function reduceScrubUi(state: ScrubUiState, event: ScrubUiEvent): ScrubUiState {
  if (event.type === "reset") return initialScrubUi(event.session);
  const session = "token" in event ? event.token.session : event.session;
  if (session !== state.session) return state;
  switch (event.type) {
    case "preview":
      return { ...state, preview: event.ratio === null ? null : unit(event.ratio) };
    case "begin":
      return { ...state, preview: null, pending: { ...event.token, ratio: unit(event.ratio) } };
    case "sample":
      return state.pending ? state : { ...state, actual: event.actual };
    case "settled":
    case "failed":
    case "cancelled": {
      const pending = state.pending;
      if (!pending || pending.request !== event.token.request) return state;
      return {
        ...state,
        pending: null,
        actual: event.type === "settled" ? event.actual : state.actual,
      };
    }
  }
}

export function displayedScrubRatio(state: ScrubUiState): number | null {
  return state.preview ?? state.pending?.ratio ?? state.actual?.ratio ?? null;
}

/** 100% 必须由宿主确认书尾；不能让普通 99.6% 四舍五入成“已读完”。未到书尾最多展示 99%。 */
export function labelProgressPct(actual: CommittedProgress): number {
  return actual.atEnd ? 100 : Math.min(99, Math.round(unit(actual.ratio) * 100));
}
