/**
 * 双栏核心实现（B 树重设计）。
 * 适用 horizontal-tb / LTR 的自然多栏分页；不承担 CSS 兼容或 DOM 测量。
 * 设置/DOM 入口保证有限合法输入，纯核心不重复容错。
 */
export type ReadingPresentation = "single" | "spread" | "scroll";

/** 一个菜单选项，兼容旧存储字段；不新增第三份持久化真相。 */
export function readingPresentation(settings: {
  readingMode?: "paginated" | "scroll";
  columnsPerView?: 1 | 2;
}): ReadingPresentation {
  return settings.readingMode === "scroll" ? "scroll"
    : settings.columnsPerView === 2 ? "spread" : "single";
}

export function presentationPatch(choice: ReadingPresentation): {
  readingMode: "paginated" | "scroll";
  columnsPerView?: 1 | 2;
} {
  // 滚动忽略栏数；旧偏好可留存，但 UI 只显示“滚动”已选。
  if (choice === "scroll") return { readingMode: "scroll" };
  return { readingMode: "paginated", columnsPerView: choice === "spread" ? 2 : 1 };
}

export interface SpreadGeometry {
  readonly viewportWidth: number;
  readonly columns: 1 | 2;
  readonly gap: number;
  readonly columnWidth: number;
  readonly columnStep: number;
  readonly spreadStep: number;
  /** Optional measured single-leaf edges (native vertical flow). */
  readonly pageIntervals?: readonly { readonly start: number; readonly end: number }[];
}

/** viewportWidth 是最终列容器内容宽，已且仅已扣一次读者边距/根 padding。 */
export function createSpreadGeometry(
  viewportWidth: number,
  gap: number,
  requestedColumns: 1 | 2,
  minimumColumnWidth = 280,
): SpreadGeometry {
  const columns = requestedColumns === 2 && (viewportWidth - gap) / 2 >= minimumColumnWidth ? 2 : 1;
  const columnWidth = (viewportWidth - (columns - 1) * gap) / columns;
  const columnStep = columnWidth + gap;
  return { viewportWidth, columns, gap, columnWidth, columnStep, spreadStep: columns * columnStep };
}

/** 必须明确控制 count，禁止从 computed column-count:auto 反猜实际栏数。 */
export function spreadColumnStyles(geometry: SpreadGeometry): Readonly<Record<string, string>> {
  return {
    "column-count": String(geometry.columns),
    "column-width": "auto",
    "column-gap": `${geometry.gap}px`,
    "column-fill": "auto",
  };
}

/**
 * rect.left 是 iframe 视口坐标；originClientX 是 viewer 内容起点的视口坐标。
 * originClientX = viewerRect.left + borderLeft + paddingLeft。
 * 不加入宿主窗口坐标，也不把 clientWidth/整屏宽误作单列步长。
 */
export function clientXToColumnX(clientX: number, originClientX: number, scrollLeft: number): number {
  return clientX - originClientX + scrollLeft;
}

export function columnForContentPoint(x: number, geometry: SpreadGeometry): number {
  const pages = geometry.pageIntervals;
  if (pages?.length) {
    let lo = 0, hi = pages.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pages[mid].end <= x) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, pages.length - 1);
  }
  return Math.max(0, Math.floor(x / geometry.columnStep));
}

export interface OccupiedColumns {
  /** 真实内容占据的首/末物理列（含中间作者强制空列）。 */
  readonly first: number;
  readonly last: number;
}

/**
 * 适配层传入真实文本 Range/媒体碎片的内容坐标区间；不传父盒 union、装饰、尾垫。
 * 本函数只算列边界，不识别 author overflow 或隐藏内容。
 */
export function occupiedColumns(
  fragments: Iterable<Readonly<{ left: number; right: number }>>,
  geometry: SpreadGeometry,
): OccupiedColumns | null {
  let first = Infinity;
  let last = -Infinity;
  for (const fragment of fragments) {
    if (fragment.right <= fragment.left) continue;
    // 仅避开 right 正好落下一列左缘时将其多算一列；不是像素修正/累计舍入。
    const insideRight = fragment.right - Math.min(0.01, (fragment.right - fragment.left) / 2);
    first = Math.min(first, columnForContentPoint(fragment.left, geometry));
    last = Math.max(last, columnForContentPoint(insideRight, geometry));
  }
  return first === Infinity ? null : { first, last };
}

export interface SpreadLayout {
  readonly geometry: SpreadGeometry;
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly pageCount: number;
  readonly empty: boolean;
  /** 含末屏留白的最小可滚动宽度；不是正文测量输入。 */
  readonly requiredScrollWidth: number;
}

export function createSpreadLayout(
  geometry: SpreadGeometry,
  occupied: OccupiedColumns | null,
): SpreadLayout {
  const firstColumn = occupied?.first ?? 0;
  const lastColumn = occupied?.last ?? -1;
  const pageCount = occupied ? Math.ceil((lastColumn - firstColumn + 1) / geometry.columns) : 1;
  const lastIndex = firstColumn + (pageCount - 1) * geometry.columns;
  const lastStart = occupied ? geometry.pageIntervals?.[lastIndex]?.start ?? lastIndex * geometry.columnStep : 0;
  return {
    geometry, firstColumn, lastColumn, pageCount, empty: occupied === null,
    requiredScrollWidth: lastStart + geometry.viewportWidth,
  };
}

export function spreadForColumn(layout: SpreadLayout, physicalColumn: number): number {
  return Math.max(0, Math.min(layout.pageCount - 1,
    Math.floor((physicalColumn - layout.firstColumn) / layout.geometry.columns)));
}

/** A15：物理列在所在屏中的阅读顺序位置（0 = 第一页，1 = 第二页）；与 spreadForColumn 同一夹取。 */
export function laneForColumn(layout: SpreadLayout, physicalColumn: number): 0 | 1 {
  if (layout.geometry.columns !== 2) return 0;
  const spread = spreadForColumn(layout, physicalColumn);
  const lane = physicalColumn - layout.firstColumn - spread * layout.geometry.columns;
  return lane >= 1 ? 1 : 0;
}

export function spreadStart(layout: SpreadLayout, page: number): number {
  const clamped = Math.max(0, Math.min(layout.pageCount - 1, Math.floor(page)));
  const index = layout.firstColumn + clamped * layout.geometry.columns;
  return layout.empty ? 0 : layout.geometry.pageIntervals?.[index]?.start ?? index * layout.geometry.columnStep;
}

/** 第一/第二可见列的采样坐标；第二列不存在正文时返回 null。 */
export function visibleColumnInterval(layout: SpreadLayout, page: number, lane: 0 | 1) {
  if (layout.empty || lane >= layout.geometry.columns) return null;
  const clamped = Math.max(0, Math.min(layout.pageCount - 1, Math.floor(page)));
  const physicalColumn = layout.firstColumn + clamped * layout.geometry.columns + lane;
  if (physicalColumn > layout.lastColumn) return null;
  return {
    physicalColumn,
    screenLeft: lane * layout.geometry.columnStep,
    screenRight: lane * layout.geometry.columnStep + (layout.geometry.pageIntervals?.[physicalColumn]
      ? Math.min(layout.geometry.columnWidth, layout.geometry.pageIntervals[physicalColumn].end - layout.geometry.pageIntervals[physicalColumn].start)
      : layout.geometry.columnWidth),
  };
}

/** UI 叶页编号从 1 开始，现有 currentPage/pageCount 仍表示“屏”，不改历史 DTO。 */
export function visibleLeafRange(layout: SpreadLayout, page: number):
  { first: number; last: number; total: number } | null {
  if (layout.empty) return null;
  const clamped = Math.max(0, Math.min(layout.pageCount - 1, Math.floor(page)));
  const total = layout.lastColumn - layout.firstColumn + 1;
  const first = clamped * layout.geometry.columns + 1;
  return { first, last: Math.min(total, first + layout.geometry.columns - 1), total };
}

/** 一次输入移动一整屏，不从 [1,2] 滑成 [2,3]，也不暗自跨章配对。 */
export function planSpreadTurn(layout: SpreadLayout, page: number, direction: 1 | -1):
  | { kind: "page"; page: number }
  | { kind: "chapter-boundary"; direction: 1 | -1 } {
  const next = page + direction;
  return next < 0 || next >= layout.pageCount
    ? { kind: "chapter-boundary", direction }
    : { kind: "page", page: next };
}

export interface PagedViewportPort {
  /** 同步调整非正文尾垫；不得把该节点写入文本、媒体或正文范围索引。 */
  ensureScrollWidth(width: number): void;
  readScrollWidth(): number;
  readClientWidth(): number;
  readScrollLeft(): number;
  writeScrollLeft(value: number): void;
}

/** 唯一分页位置提交入口；调用方在成功后才更新 metrics/anchor/ready。 */
export function commitSpreadPosition(port: PagedViewportPort, layout: SpreadLayout, requestedPage: number):
  | { ok: true; page: number; scrollLeft: number }
  | { ok: false; reason: "unreachable" } {
  const page = Math.max(0, Math.min(layout.pageCount - 1, Math.floor(requestedPage)));
  const target = spreadStart(layout, page);
  port.ensureScrollWidth(layout.requiredScrollWidth);
  // CSSOM 宽度取整允许最多 1 CSS px 的差，不拿误差改写列步长。
  if (port.readScrollWidth() - port.readClientWidth() + 1 < target) return { ok: false, reason: "unreachable" };
  const previous = port.readScrollLeft();
  port.writeScrollLeft(target);
  const accepted = port.readScrollLeft();
  if (Math.abs(accepted - target) > 1) {
    port.writeScrollLeft(previous);
    return { ok: false, reason: "unreachable" };
  }
  return { ok: true, page, scrollLeft: accepted };
}

/** A15 书签丝带挂点：页外缘离正文最多这么远（单页跟着版心，不贴窗口边）。 */
export const BOOKMARK_PAGE_MARGIN_MAX_PX = 56;

export interface BookmarkPageFrame {
  /** 阅读顺序：0 = 这一屏的第一页。 */
  readonly lane: 0 | 1;
  /** 物理位置；丝带挂在这一侧的外缘。单页按外侧（右）。 */
  readonly side: "left" | "right";
  /** 页外缘的横坐标（与输入同一坐标系）。 */
  readonly outerX: number;
}

/**
 * 只读已提交的几何：这一屏第一栏的左缘、栏宽和正文限宽（单页正文在栏内居中，
 * 不超过限宽）。页外缘 = 版心外侧再留最多 56px，不超出可见视口。
 * 双页中线两侧各一页；单页挂右侧（图片双页左叶传 left）。RTL 只交换左右对应的阅读顺序。
 */
export function bookmarkPageFrames(input: {
  readonly contentLeft: number;
  readonly geometry: Pick<SpreadGeometry, "columns" | "columnWidth" | "columnStep">;
  /** 正文限宽（px）；栏比它宽时正文居中。 */
  readonly measure: number;
  readonly viewportLeft: number;
  readonly viewportRight: number;
  readonly rtl: boolean;
  /** 阅读顺序上第一、第二页是否有正文（末屏右页可能空）。 */
  readonly present: readonly [boolean, boolean];
  /**
   * 一页章并排（A13 裁剪显示）：这一章只露出第一页，被挪到 side 那一格，挪动了 shift 像素。
   * 丝带挂在那一格的外缘；结果仍在本章自己的坐标里（显示时整体再挪 shift）。
   * 单栏时只用 side。默认：单页挂外侧（右）。
   */
  readonly slot?: { readonly side: "left" | "right"; readonly shift: number };
}): BookmarkPageFrame[] {
  const { contentLeft, geometry, rtl, present } = input;
  const text = Math.min(geometry.columnWidth, Math.max(0, input.measure) || geometry.columnWidth);
  const inset = (geometry.columnWidth - text) / 2;
  const textLeft = contentLeft + inset;
  const textRight = contentLeft + (geometry.columns - 1) * geometry.columnStep + inset + text;
  const leftEdge = textLeft - Math.max(0, Math.min(textLeft - input.viewportLeft, BOOKMARK_PAGE_MARGIN_MAX_PX));
  const rightEdge = textRight + Math.max(0, Math.min(input.viewportRight - textRight, BOOKMARK_PAGE_MARGIN_MAX_PX));
  if (geometry.columns !== 2 || input.slot) {
    const side = input.slot?.side ?? "right";
    const shift = geometry.columns === 2 ? input.slot?.shift ?? 0 : 0;
    return present[0] ? [{ lane: 0, side, outerX: (side === "left" ? leftEdge : rightEdge) - shift }] : [];
  }
  const frames: BookmarkPageFrame[] = [];
  for (const lane of [0, 1] as const) {
    if (!present[lane]) continue;
    const side = (lane === 0) !== rtl ? "left" : "right";
    frames.push({ lane, side, outerX: side === "left" ? leftEdge : rightEdge });
  }
  return frames;
}
