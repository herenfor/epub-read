import { forwardRef, useImperativeHandle, useRef, useState, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { nextLinearIndex } from "../core/book";
import type { ChapterState } from "../render/paginator";
import type { ReaderHandle, ReaderViewProps } from "./ReaderView";
import type { ImageChapterSpread } from "./imageChapterSpreads";
import { EdgeTurnZone } from "./EdgeTurnZone";
import { edgeTurnZoneSpecs, ReaderTurnOwnerContext, useReaderTapRouting } from "./readerTapRouting";

interface Props extends ReaderViewProps {
  spread: ImageChapterSpread;
  gap: number;
  onUnsupported(): void;
  Page: ForwardRefExoticComponent<ReaderViewProps & RefAttributes<ReaderHandle>>;
}

/** Two isolated original documents, one visual spread. No synthetic chapter IDs or DOM merging. */
export const ImageSpreadReaderView = forwardRef<ReaderHandle, Props>(function ImageSpreadReaderView(props, ref) {
  const leftHandle = useRef<ReaderHandle>(null);
  const rightHandle = useRef<ReaderHandle>(null);
  const states = useRef(new Map<number, ChapterState>());
  const displayed = useRef(new Set<number>());
  const [ready, setReady] = useState(false);
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

  const publish = () => {
    const p = latest.current;
    const state = states.current.get(p.spineIndex);
    if (displayed.current.size < (p.spread.right === null ? 1 : 2) || state?.status !== "ready") return;
    setReady(true);
    p.onPageState(spreadState(state));
    p.onDisplayReady(p.restoreTicket ?? null);
  };
  const page = (index: number, side: "left" | "right") => {
    const selected = index === props.spineIndex;
    const Page = props.Page;
    return <div className="reader-image-leaf" data-image-chapter={index} data-image-side={side}>
      <Page {...props}
        ref={side === "left" ? leftHandle : rightHandle}
        spineIndex={index}
        settings={{ ...props.settings, columnsPerView: 1, preloadNextChapter: false,
          pageMarginsPx: { ...props.settings.pageMarginsPx, left: 0, right: 0 } }}
        anchor={selected ? props.anchor : undefined}
        anchorNonce={selected ? props.anchorNonce : 0}
        initialAnchor={selected ? props.initialAnchor : null}
        initialPage={selected ? props.initialPage : 0}
        preciseTarget={selected ? props.preciseTarget : null}
        restoreTicket={selected ? props.restoreTicket : null}
        startAtEnd={selected ? props.startAtEnd : { nonce: 0, atEnd: false }}
        notes={selected ? props.notes : []}
        inputPaused={props.inputPaused || !ready}
        onPageState={(state) => {
          states.current.set(index, state);
          // Raw XHTML eligibility is not a page-count measurement. Author
          // CSS that produces multiple/empty leaves must keep the normal
          // paginator; never skip unseen pages by jumping to the next pair.
          if (state.status === "ready" && (state.empty || state.pageCount !== 1)) {
            latest.current.onUnsupported();
            return;
          }
          if (state.status !== "ready") {
            displayed.current.delete(index);
            setReady(false);
            latest.current.onPageState(state);
          } else if (ready && selected) latest.current.onPageState(spreadState(state));
        }}
        onDisplayReady={() => { displayed.current.add(index); publish(); }}
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
    </div>;
  };
  return <div className="reader-image-spread" data-image-spread-ready={ready}
    style={{ gap: props.gap, paddingLeft: props.settings.pageMarginsPx?.left ?? 0,
      paddingRight: props.settings.pageMarginsPx?.right ?? 0 }}>
    <ReaderTurnOwnerContext.Provider value={turnOwner}>
      {page(props.spread.left, "left")}
      {props.spread.right !== null ? page(props.spread.right, "right") : <div className="reader-image-leaf is-empty" aria-hidden="true" />}
    </ReaderTurnOwnerContext.Provider>
    {edgeTurnZoneSpecs(tapRouting).map((zone) => <EdgeTurnZone key={zone.side}
      direction={zone.direction} side={zone.sideProp} region={zone.region}
      onTurn={(direction) => turn(direction)} />)}
  </div>;
});
