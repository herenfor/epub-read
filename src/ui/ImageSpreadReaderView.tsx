import { effectivePageProgression } from "../render/settings";
import { forwardRef, useImperativeHandle, useRef, useState, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { nextLinearIndex } from "../core/book";
import type { ChapterState } from "../render/paginator";
import type { ReaderHandle, ReaderViewProps } from "./ReaderView";
import type { SingleLeafSpread } from "./singleLeafSpreads";
import { EdgeTurnZone } from "./EdgeTurnZone";
import { edgeFeedbackKeyOf, edgeTurnZoneSpecs, ReaderTurnOwnerContext, routeHostBlankTurn, useReaderTapRouting } from "./readerTapRouting";
import { WheelTurnAccumulator } from "./turnIntent";

interface Props extends ReaderViewProps {
  spread: SingleLeafSpread;
  onUnsupported(): void;
  Page: ForwardRefExoticComponent<ReaderViewProps & RefAttributes<ReaderHandle>>;
}

/**
 * Two isolated original documents, one visual spread. No synthetic chapter IDs or DOM merging.
 *
 * A13 裁剪显示：两章都按原来的整开双页几何排版（栏宽、页边、CSS 都不变），各自只露出
 * 第一页；阅读顺序第二章按它自己的栏步长整体挪到另一格。任何一章不止一页（内容伸进第二页）就
 * 不并排，退回单章显示；两章都确认前不显示。窗口或字号变化后两章各自重排，两章都按新视口
 * 排完才重新拼接，其间遮住，不拿一新一旧的几何拼屏。
 */
export const ImageSpreadReaderView = forwardRef<ReaderHandle, Props>(function ImageSpreadReaderView(props, ref) {
  const rtl = effectivePageProgression(props.book.pageProgression, props.settings, props.book.fixedLayout) === "rtl";
  const leftHandle = useRef<ReaderHandle>(null);
  const rightHandle = useRef<ReaderHandle>(null);
  const states = useRef(new Map<number, ChapterState>());
  const displayed = useRef(new Set<number>());
  const outerWheel = useRef(new WheelTurnAccumulator());
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const show = (value: boolean) => {
    readyRef.current = value;
    setReady(value);
  };
  /** 有叶子报告了 display-ready、还没对外转发（另一叶未排完时延到拼好再报）。 */
  const owesDisplayReady = useRef(false);
  /** 第二章挪到另一格的距离（= 第二章自己已提交几何的栏步长）；确认前为 null。 */
  const [step, setStep] = useState<number | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const active = () => latest.current.spineIndex === latest.current.spread.left ? leftHandle.current : rightHandle.current;
  const spreadState = (state: ChapterState): ChapterState => {
    const p = latest.current;
    const last = p.spread.right ?? p.spread.left;
    return state.status === "ready" && displayed.current.size === (p.spread.right === null ? 1 : 2)
      ? { ...state, effectiveColumns: 2, atEnd: nextLinearIndex(p.book, last, 1) < 0 }
      : state;
  };
  // Both leaves turn from the pair's outer edge: at the book start/end there
  // is no target, so neither leaf may begin a chapter exit.
  const neighbor = (dir: 1 | -1) => {
    const { book, spread } = latest.current;
    return nextLinearIndex(book, dir === 1 ? spread.right ?? spread.left : spread.left, dir);
  };
  const turn = (dir: 1 | -1) => {
    const p = latest.current;
    if (p.inputPaused || displayed.current.size < (p.spread.right === null ? 1 : 2)) return;
    const target = neighbor(dir);
    if (target >= 0) p.onRequestChapter(target, dir === -1 ? { atEnd: true } : undefined);
  };
  // Body taps in either leaf turn the pair, like its outer bands.
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const [turnOwner] = useState(() => (dir: 1 | -1) => turnRef.current(dir));
  const tapRouting = useReaderTapRouting();
  useImperativeHandle(ref, () => ({
    // Both leaves are live body hosts: each recolors before this returns.
    applyTheme: (theme) => {
      leftHandle.current?.applyTheme(theme);
      rightHandle.current?.applyTheme(theme);
    },
    nextPage: () => turn(1),
    prevPage: () => turn(-1),
    setPage: (page) => active()?.setPage(page),
    scrollToRatio: (ratio) => active()?.scrollToRatio?.(ratio),
    seekContentFraction: (target, token) => active()?.seekContentFraction?.(target, token),
    diagnose: () => `image spread ${latest.current.spread.left}/${latest.current.spread.right ?? "blank"}\n${active()?.diagnose() ?? ""}`,
    getReadingAnchor: () => active()?.getReadingAnchor() ?? null,
    resolveBookmarkPage: (bookmark) => active()?.resolveBookmarkPage?.(bookmark) ?? null,
    // Leaf order is reading order: the first leaf is lane 0 wherever it sits.
    pageMotionIdle: () => [leftHandle.current, rightHandle.current].every((leaf) => leaf?.pageMotionIdle?.() ?? true),
    screenBookmarks: (bookmarks) => {
      const leaves = [leftHandle.current, rightHandle.current];
      const pages = leaves.flatMap((leaf, lane) => (leaf?.screenBookmarks?.(bookmarks)?.pages ?? [])
        .map((page) => ({ ...page, lane: lane as 0 | 1 })));
      return pages.length > 0 ? { kind: "paged", columns: 2, pages } : null;
    },
    captureBookmarkAnchor: (lane) => (lane === 0 ? leftHandle.current : rightHandle.current)?.captureBookmarkAnchor?.(0) ?? null,
    getAnchorText: () => active()?.getAnchorText() ?? null,
    readPositionSnapshot: (options) => {
      const snapshot = active()?.readPositionSnapshot(options);
      return snapshot ? { ...snapshot, state: spreadState(snapshot.state) } : null;
    },
    jumpToAnchor: (anchor) => active()?.jumpToAnchor(anchor),
    navigateWithinCurrentChapter: (options) => active()?.navigateWithinCurrentChapter(options) ?? false,
    navigateToSearchTarget: (request) => active()?.navigateToSearchTarget(request) ?? "unresolved",
    getFootnoteMarkerRect: () => null,
    dismissFootnote: () => active()?.dismissFootnote(),
    pinFootnote: () => active()?.pinFootnote(),
    setFootnoteOverlayHover: (over) => active()?.setFootnoteOverlayHover(over),
    clearTextSelection: () => active()?.clearTextSelection(),
    scrollToStart: () => active()?.scrollToStart(),
    scrollToEnd: () => active()?.scrollToEnd(),
    atScrollBoundary: (direction) => active()?.atScrollBoundary(direction) ?? true,
    scrollByViewport: (direction) => active()?.scrollByViewport(direction) ?? false,
    scrollByDelta: (delta) => active()?.scrollByDelta(delta),
  }), []);

  // 首次显示与之后每次重排共用：读两叶各自已提交的几何再拼屏。
  const commit = () => {
    const p = latest.current;
    const count = p.spread.right === null ? 1 : 2;
    const state = states.current.get(p.spineIndex);
    if (displayed.current.size < count || state?.status !== "ready") return;
    const leaves = count === 2 ? [leftHandle.current, rightHandle.current] : [leftHandle.current];
    // 没有这项查询的视图（测试替身）不挪动；真实分页视图没有双页几何时不并排。
    const layouts = leaves.map((leaf) => leaf?.spreadLeafLayout ? leaf.spreadLeafLayout() : { columnStep: 0 });
    // 还没排完（窗口刚变、只有一叶按新视口提交）：先遮住，等另一叶的完成回调。
    if (layouts.includes("pending")) {
      show(false);
      return;
    }
    const second = layouts[count - 1];
    if (layouts.includes(null) || second === null || second === "pending") {
      p.onUnsupported();
      return;
    }
    setStep(count === 2 ? second.columnStep : 0);
    show(true);
    p.onPageState(spreadState(state));
    if (owesDisplayReady.current) {
      owesDisplayReady.current = false;
      p.onDisplayReady(p.restoreTicket ?? null);
    }
  };
  const page = (index: number, side: "left" | "right") => {
    const selected = index === props.spineIndex;
    const Page = props.Page;
    // side 是阅读顺序（left = 第一章）；physical 是显示在哪一格。第一章的第一页本来就在
    // 自己那一格，第二章挪一个栏步长过去。
    const physical: "left" | "right" = (side === "left") !== rtl ? "left" : "right";
    const shift = side === "left" || step === null ? 0 : (rtl ? -step : step);
    return <div className="reader-image-leaf" data-image-chapter={index} data-image-side={physical}
      style={{ clipPath: physical === "left" ? "inset(0 50% 0 0)" : "inset(0 0 0 50%)" }}>
      <div className="reader-image-leaf-shift" style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
      <Page {...props}
        ref={side === "left" ? leftHandle : rightHandle}
        spineIndex={index}
        leafSlot={{ side: physical, shift }}
        settings={{ ...props.settings, preloadNextChapter: false }}
        anchor={selected ? props.anchor : undefined}
        anchorNonce={selected ? props.anchorNonce : 0}
        initialAnchor={selected ? props.initialAnchor : null}
        initialPage={selected ? props.initialPage : 0}
        preciseTarget={selected ? props.preciseTarget : null}
        restoreTicket={selected ? props.restoreTicket : null}
        startAtEnd={selected ? props.startAtEnd : { nonce: 0, atEnd: false }}
        notes={selected ? props.notes : props.notesForChapter?.(index) ?? []}
        inputPaused={props.inputPaused || !ready}
        onPageState={(state) => {
          states.current.set(index, state);
          // Raw XHTML eligibility is not a page-count measurement. Author
          // CSS that produces multiple/empty leaves must keep the normal
          // paginator; never skip unseen pages by jumping to the next pair.
          // 整开几何下只能占第一页：伸进第二页（第二栏）也不并排。
          if (state.status === "ready" && (state.empty || state.pageCount !== 1 ||
            state.effectiveColumns !== 2 || (state.leafRange?.total ?? 1) > 1)) {
            latest.current.onUnsupported();
            return;
          }
          if (state.status !== "ready") {
            displayed.current.delete(index);
            show(false);
            latest.current.onPageState(state);
          } else if (readyRef.current && selected) latest.current.onPageState(spreadState(state));
        }}
        onDisplayReady={() => {
          displayed.current.add(index);
          owesDisplayReady.current = true;
          commit();
        }}
        onLayoutSettled={commit}
        chapterNeighbor={(_, dir) => neighbor(dir)}
        onRequestChapter={(target, options) => {
          // Empty/hidden authored pictures retain ordinary chapter handling.
          const state = states.current.get(index);
          if (state?.status === "ready" && state.empty) {
            return;
          }
          turn(options?.atEnd || target < index ? -1 : 1);
        }}
        onRestoreResult={selected ? props.onRestoreResult : undefined}
        onUserReadingPositionChange={selected ? props.onUserReadingPositionChange : undefined}
        onUserProgressSample={selected ? props.onUserProgressSample : undefined}
        onPreciseNavigationStatus={selected ? props.onPreciseNavigationStatus : undefined}
      />
      </div>
    </div>;
  };
  return <div className="reader-image-spread" data-image-spread-ready={ready}
    onClick={(event) => {
      // Leaves route their own taps; this fills the empty leaf and the gutter,
      // which the (now visual-only) edge bands used to cover.
      if (event.target instanceof Element && event.target.closest(".reader")) return;
      // Same gate as the leaves and the wheel: no turn and no arrow while paused or not ready.
      if (props.inputPaused || !ready) return;
      const route = routeHostBlankTurn(tapRouting, event.clientX, event.clientY);
      if (!route || !tapRouting) return;
      tapRouting.feedback.hold(edgeFeedbackKeyOf(route.side));
      turn(route.direction);
    }}
    onWheel={(event) => {
      // A leaf's ReaderView already owns its wheel events. Only fill the
      // blank leaf, gutter and outer-band paths without counting input twice.
      if (event.defaultPrevented || event.ctrlKey ||
        (event.target instanceof Element && event.target.closest(".reader"))) return;
      if (props.inputPaused || !ready) {
        outerWheel.current.reset();
        return;
      }
      const delta = event.deltaMode === 1 ? event.deltaY * 28
        : event.deltaMode === 2 ? event.deltaY * event.currentTarget.clientHeight
        : event.deltaY;
      const direction = outerWheel.current.push(delta);
      if (direction === null) return;
      event.preventDefault();
      turn(direction);
    }}
    >
    <ReaderTurnOwnerContext.Provider value={turnOwner}>
      {page(props.spread.left, "left")}
      {props.spread.right !== null ? page(props.spread.right, "right") : <div className="reader-image-leaf is-empty"
        data-image-side={rtl ? "left" : "right"} style={{ clipPath: rtl ? "inset(0 50% 0 0)" : "inset(0 0 0 50%)" }}
        aria-hidden="true" />}
    </ReaderTurnOwnerContext.Provider>
    {edgeTurnZoneSpecs(tapRouting).map((zone) => <EdgeTurnZone key={zone.side}
      direction={zone.direction} side={zone.sideProp} region={zone.region} />)}
  </div>;
});
