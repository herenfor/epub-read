import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChapterState, ReadingAnchor } from "../render/paginator";
import type { ReaderHandle, ReaderViewProps } from "./ReaderView";
import type { RibbonBookmark, RibbonMark } from "./bookmarkRibbons";
import { pageRibbonLeft } from "./bookmarkRibbons";
import { BookmarkRibbonLayer } from "./BookmarkRibbonLayer";
import { comicSpreads, comicPageForAnchor, comicTurnTarget } from "./comicPages";
import { createReaderTapGeometry, routeReaderTap } from "./readerTapRouting";
import { resolveReaderPalette } from "../config/readerPalette";
import { effectivePageProgression } from "../render/settings";
import { WheelTurnAccumulator } from "./turnIntent";
import { attachReaderPaint } from "../render/visual/readerVisualPaint";
import { DEFAULT_VISUAL_PREFERENCES } from "../render/visual/readerVisualPreferences";
import { uiText } from "./localization/UiLanguageProvider";
import "./comicReader.css";

const CHAPTER = "__reader__/comic.xhtml";
type Position = { page: number; ratio: number };
type Lease = { url: string; release(): void };
type Resources = { closed: boolean; wanted: Set<number>; held: Map<number, Lease>; pending: Set<number> };
type Seek = Parameters<NonNullable<ReaderHandle["seekContentFraction"]>>;

/** One native scrolling surface. Display spreads never become source-page identities. */
export const ComicReaderView = forwardRef<ReaderHandle, ReaderViewProps>(function ComicReaderView(props, ref) {
  const latest = useRef(props);
  latest.current = props;
  const pages = props.book.comicPages!;
  const root = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);
  const initial = comicPageForAnchor(pages, props.initialAnchor?.mediaAnchor?.signature, props.initialAnchor?.mediaAnchor?.index ?? 0);
  const position = useRef<Position>({ page: initial ?? 0, ratio: props.initialAnchor?.mediaAnchor?.ratio ?? 0 });
  const [page, setPage] = useState(position.current.page);
  const [width, setWidth] = useState(0), [moving, setMoving] = useState(false);
  const command = useRef(false), lastDirection = useRef<1 | -1 | null>(null);
  const motion = useRef(false), goal = useRef(page), [warmPage, setWarmPage] = useState(page);
  const [urls, setUrls] = useState<Record<number, string>>({}), [revision, redraw] = useState(0);
  const decoded = useRef(new Set<number>()), errors = useRef(new Map<number, string>());
  const dimensions = useRef(new Map<number, { width: number; height: number }>());
  const owner = useRef<Resources | null>(null);
  const alignment = useRef<Position | null>({ ...position.current });
  const readyOnce = useRef(false), navigationPending = useRef(false), seek = useRef<Seek[1] | null>(null);
  const userMoved = useRef(false), pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null), fade = useRef<Animation | null>(null);
  const wheel = useRef(new WheelTurnAccumulator());
  const scroll = props.settings.readingMode === "scroll";
  const columns: 1 | 2 = !scroll && props.settings.columnsPerView === 2 && width >= 600 ? 2 : 1;
  const groups = useMemo(() => comicSpreads(pages, columns), [pages, columns]);
  const groupForPage = useMemo(() => {
    const indexes: number[] = [];
    groups.forEach((group, i) => group.forEach(p => { indexes[p] = i; }));
    return indexes;
  }, [groups]);
  const rtl = effectivePageProgression(props.book.pageProgression, props.settings, true) === "rtl";
  const paper = resolveReaderPalette(props.settings.theme);
  const visible = () => scroll ? [position.current.page] : groups[groupForPage[position.current.page]];
  // CSS pixels may be fractional at OS/WebView zoom; clientWidth rounds and drifts over many pages.
  const pitch = () => track.current?.firstElementChild?.getBoundingClientRect().width ?? width;
  const fraction = () => (position.current.page + position.current.ratio) / pages.length;
  const atEnd = () => scroll
    ? !!track.current && track.current.scrollTop + track.current.clientHeight >= track.current.scrollHeight - 1
    : groupForPage[position.current.page] === groups.length - 1;
  const atStart = () => scroll ? (track.current?.scrollTop ?? 0) <= 1 : groupForPage[position.current.page] === 0;
  const state = (): ChapterState => {
    const shown = visible();
    const failed = shown.map(i => errors.current.get(i)).find(Boolean);
    if (failed) return { status: "error", message: failed };
    if (shown.some(i => !urls[i] || !decoded.current.has(i))) return { status: "loading" };
    return {
      status: "ready", empty: false, mode: scroll ? "scroll" : "paginated", effectiveColumns: columns,
      pageCount: scroll ? pages.length : groups.length,
      currentPage: scroll ? position.current.page : groupForPage[position.current.page],
      ...(motion.current ? { transient: true as const } : {}), atEnd: atEnd(), scrollProgress: fraction(), totalScrollProgress: fraction(),
      leafRange: { first: shown[0] + 1, last: shown[shown.length - 1] + 1, total: pages.length },
    };
  };
  const anchor = (p = position.current.page): ReadingAnchor => {
    const ratio = p === position.current.page ? position.current.ratio : 0;
    return { index: p, ratio, charsRead: (p + ratio) * 1000, totalChars: pages.length * 1000,
      mediaUnits: pages.length, textOffset: null, textSnippet: null,
      mediaAnchor: { index: p, tag: "img", signature: pages[p].path, ratio } };
  };
  const report = () => {
    if (owner.current?.closed) return;
    const current = state();
    latest.current.onPageState(current);
    if (current.status !== "ready" || current.transient) return;
    if (!readyOnce.current) {
      readyOnce.current = true;
      latest.current.onRestoreResult?.({ chapterPath: CHAPTER, located: initial !== null, ticket: latest.current.restoreTicket ?? null });
      latest.current.onDisplayReady(latest.current.restoreTicket ?? null);
    }
    if (navigationPending.current) {
      navigationPending.current = false;
      latest.current.onInternalNavigationSettled();
    }
    if (seek.current) {
      const token = seek.current;
      seek.current = null;
      latest.current.onContentFractionSettled?.(token, { key: CHAPTER, spineIndex: 0, fraction: fraction(), atEnd: atEnd() });
    }
    if (userMoved.current) {
      userMoved.current = false;
      latest.current.onUserReadingPositionChange?.(latest.current.restoreTicket ?? null);
    }
    latest.current.onUserProgressSample?.({ key: CHAPTER, spineIndex: 0, fraction: fraction(), atEnd: atEnd() });
  };
  const align = (p: Position, behavior: ScrollBehavior = "auto") => {
    const el = track.current;
    if (!el) return;
    if (scroll) {
      const child = el.children[p.page] as HTMLElement | undefined;
      if (child) el.scrollTo({ top: child.offsetTop + p.ratio * Math.max(0, child.offsetHeight - el.clientHeight), behavior });
    } else {
      el.scrollTo({ left: (rtl ? -1 : 1) * groupForPage[p.page] * pitch(), behavior });
    }
  };
  const locate = (p: number, ratio = 0, behavior: ScrollBehavior = "auto") => {
    p = Math.max(0, Math.min(pages.length - 1, p));
    goal.current = p;
    setWarmPage(p);
    command.current = behavior === "smooth";
    if (behavior !== "smooth") {
      position.current = { page: p, ratio };
      setPage(p);
      alignment.current = { ...position.current };
      motion.current = false;
      setMoving(false);
    }
    align({ page: p, ratio }, behavior);
    // Same-page seeks have no scroll event; still resolve only after the image is ready.
    queueMicrotask(() => actions.current.report());
  };
  const turn = (direction: 1 | -1) => {
    if (latest.current.inputPaused) return;
    userMoved.current = true;
    alignment.current = null;
    fade.current?.cancel();
    if (scroll) {
      track.current?.scrollBy({ top: direction * track.current.clientHeight * .9, behavior: "smooth" });
      return;
    }
    const visual = Math.abs(track.current?.scrollLeft ?? 0) / Math.max(1, pitch());
    const target = comicTurnTarget(visual, groupForPage[goal.current], direction, lastDirection.current);
    const next = groups[target];
    if (!next) return;
    lastDirection.current = direction;
    const animation = latest.current.settings.turnAnimation;
    if (animation === "fade") fade.current = track.current?.animate([{ opacity: .45 }, { opacity: 1 }], { duration: 160, easing: "ease-out" }) ?? null;
    locate(next[0], 0, animation === "slide" ? "smooth" : "auto");
  };
  const sample = () => {
    frame.current = null;
    const el = track.current;
    if (!el || owner.current?.closed) return;
    if (alignment.current) {
      if (visible().some(i => !decoded.current.has(i))) return;
      align(alignment.current);
      alignment.current = null;
    }
    if (scroll) {
      const line = el.scrollTop + el.clientHeight * .2;
      let low = 0, high = pages.length - 1, p = 0;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        if ((el.children[mid] as HTMLElement).offsetTop <= line) { p = mid; low = mid + 1; }
        else high = mid - 1;
      }
      const child = el.children[p] as HTMLElement;
      position.current = { page: p, ratio: Math.max(0, Math.min(1, (el.scrollTop - child.offsetTop) / Math.max(1, child.offsetHeight - el.clientHeight))) };
      setWarmPage(p);
    } else {
      const distance = Math.abs(el.scrollLeft), step = Math.max(1, pitch());
      const screen = Math.max(0, Math.min(groups.length - 1, Math.round(distance / step)));
      const targetReached = Math.abs(distance - groupForPage[goal.current] * step) <= .75;
      if (targetReached) command.current = false;
      motion.current = Math.abs(distance - screen * step) > .75 || command.current;
      setMoving(motion.current);
      const shown = groups[screen];
      if (!shown.includes(position.current.page)) position.current = { page: shown[0], ratio: 0 };
      if (!motion.current) { goal.current = position.current.page; setWarmPage(position.current.page); lastDirection.current = null; }
    }
    setPage(position.current.page);
    report();
  };
  // Native listeners read the current layout/actions, never a previous mode's closure.
  const actions = useRef({ report, sample, turn });
  actions.current = { report, sample, turn };
  useLayoutEffect(() => {
    const el = root.current!;
    const resize = () => setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(resize);
    observer.observe(el); resize();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    alignment.current = { ...position.current };
    align(alignment.current);
    if (visible().every(i => decoded.current.has(i))) alignment.current = null;
  }, [width, columns, scroll, rtl]);
  useLayoutEffect(() => {
    if (!alignment.current) return;
    align(alignment.current);
    if (visible().every(i => decoded.current.has(i))) alignment.current = null;
  }, [revision, urls]);
  useEffect(() => {
    const resources: Resources = { closed: false, wanted: new Set(), held: new Map(), pending: new Set() };
    owner.current = resources;
    decoded.current.clear(); errors.current.clear(); setUrls({});
    return () => {
      resources.closed = true;
      for (const lease of resources.held.values()) lease.release();
      resources.held.clear();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      fade.current?.cancel();
    };
  }, [props.server]);
  useEffect(() => {
    const resources = owner.current!;
    const screen = groupForPage[page];
    const wanted = scroll ? [page - 1, page, page + 1, warmPage] : [
      ...groups.slice(Math.max(0, screen - 1), screen + 2).flat(), ...groups[groupForPage[warmPage]],
    ];
    resources.wanted = new Set(wanted.filter(i => i >= 0 && i < pages.length));
    for (const [i, lease] of resources.held) if (!resources.wanted.has(i)) {
      lease.release(); resources.held.delete(i); decoded.current.delete(i);
    }
    setUrls(Object.fromEntries([...resources.held].map(([i, lease]) => [i, lease.url])));
    for (const i of resources.wanted) {
      if (resources.held.has(i) || resources.pending.has(i) || errors.current.has(i)) continue;
      resources.pending.add(i);
      void props.server.acquireResource(pages[i].path).then(lease => {
        if (resources.closed || !resources.wanted.has(i)) { lease.release(); return; }
        resources.held.set(i, lease);
        setUrls(old => ({ ...old, [i]: lease.url }));
      }).catch(error => {
        if (!resources.closed) { errors.current.set(i, String(error)); redraw(n => n + 1); }
      }).finally(() => resources.pending.delete(i));
    }
  }, [page, warmPage, groups, scroll, props.server, pages, groupForPage]);
  useEffect(() => { report(); }, [page, moving, urls, revision, width, columns, scroll]);
  useEffect(() => {
    const el = track.current!;
    const onWheel = (event: WheelEvent) => {
      if (scroll || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      if (latest.current.inputPaused) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1);
      const direction = wheel.current.push(delta);
      if (direction) actions.current.turn(direction);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scroll]);
  useEffect(() => {
    if (!props.inputPaused) return;
    fade.current?.cancel(); command.current = false; lastDirection.current = null;
    if (scroll) track.current?.scrollTo({ top: track.current.scrollTop, behavior: "auto" });
    else align(position.current);
    motion.current = false; setMoving(false);
  }, [props.inputPaused]);
  useEffect(() => {
    if (!props.anchor) return;
    const match = /^page-(\d+)$/.exec(props.anchor);
    if (match) { navigationPending.current = true; locate(Number(match[1])); }
  }, [props.anchor, props.anchorNonce]);
  useEffect(() => {
    const paint = attachReaderPaint(track.current!, root.current!, props.visualPreferences ?? DEFAULT_VISUAL_PREFERENCES, paper.background);
    paint.update(props.visualPreferences ?? DEFAULT_VISUAL_PREFERENCES, props.compareOriginal === true);
    return () => paint.dispose();
  }, [props.visualPreferences, props.compareOriginal, paper.background]);

  const bookmarkPages = (bookmarks: readonly RibbonBookmark[]) => visible().map((p, lane) => {
    const side = columns === 1 || (rtl ? lane === 0 : lane === 1) ? "right" as const : "left" as const;
    const child = track.current?.children[p] as HTMLElement | undefined;
    const y = (mark: RibbonBookmark) => scroll && child && track.current
      ? child.offsetTop + (mark.mediaAnchor?.ratio ?? 0) * Math.max(0, child.offsetHeight - track.current.clientHeight) - track.current.scrollTop : 0;
    const own = bookmarks.filter(mark => mark.mediaAnchor?.signature === pages[p].path && (!scroll || (y(mark) >= -1 && y(mark) < (track.current?.clientHeight ?? 0))));
    return { lane: lane as 0 | 1, side, spineIndex: 0, ids: own.map(mark => mark.id), y: own[0] ? Math.max(0, y(own[0])) : 0 };
  });
  useImperativeHandle(ref, () => ({
    nextPage: () => turn(1), prevPage: () => turn(-1),
    setPage: i => locate(scroll ? i : groups[i]?.[0] ?? 0),
    scrollToRatio: r => locate(Math.min(pages.length - 1, Math.floor(r * pages.length))),
    seekContentFraction(target, token) {
      const units = Math.max(0, Math.min(1, target.fraction)) * pages.length;
      const p = Math.min(pages.length - 1, Math.floor(units));
      seek.current = token; locate(p, units - p);
    },
    diagnose: () => `comic ${position.current.page + 1}/${pages.length}; columns=${columns}; phase=${state().status}`,
    getReadingAnchor: () => state().status === "ready" ? { path: CHAPTER, ...anchor(), mediaUnits: pages.length } : null,
    getAnchorText: () => pages[position.current.page].path.split('/').pop() ?? null,
    readPositionSnapshot: () => ({ chapterPath: CHAPTER, state: state(), readingAnchor: state().status === "ready" ? { path: CHAPTER, ...anchor(), mediaUnits: pages.length, mediaAnchor: anchor().mediaAnchor ?? null } : null, anchorText: pages[position.current.page].path.split('/').pop() ?? null }),
    resolveBookmarkPage(mark) {
      const p = comicPageForAnchor(pages, mark.mediaAnchor?.signature, mark.mediaAnchor?.index ?? mark.page ?? 0);
      return p === null ? null : scroll ? p : groupForPage[p];
    },
    captureBookmarkAnchor(lane) {
      const p = visible()[lane];
      return p === undefined || state().status !== "ready" ? null : { spineIndex: 0, page: groupForPage[p], anchor: anchor(p), text: pages[p].path.split('/').pop() ?? null };
    },
    screenBookmarks: bookmarks => state().status !== "ready" ? null : ({ kind: scroll ? "scroll" : "paged", columns, pages: bookmarkPages(bookmarks) }),
    jumpToAnchor(value) { const match = /^page-(\d+)$/.exec(value); if (match) locate(Number(match[1])); },
    navigateWithinCurrentChapter(options) {
      const media = options.mediaAnchor ?? options.readingAnchor?.mediaAnchor;
      if (media) {
        const p = comicPageForAnchor(pages, media.signature, media.index);
        if (p === null) return false;
        navigationPending.current = true; locate(p, media.ratio); return true;
      }
      const match = /^page-(\d+)$/.exec(options.fragment ?? "");
      if (!match) return false;
      navigationPending.current = true; locate(Number(match[1])); return true;
    },
    navigateToSearchTarget: () => "unresolved", getFootnoteMarkerRect: () => null,
    dismissFootnote() {}, pinFootnote() {}, setFootnoteOverlayHover() {}, clearTextSelection() {},
    scrollToStart: () => locate(0), scrollToEnd: () => locate(pages.length - 1, 1),
    atScrollBoundary: d => d === 1 ? atEnd() : atStart(),
    scrollByViewport(d) { if (d === 1 ? atEnd() : atStart()) return false; turn(d); return true; },
    scrollByDelta(delta) { userMoved.current = true; track.current?.scrollBy({ top: delta }); },
    applyTheme(theme) { root.current!.style.backgroundColor = resolveReaderPalette(theme).background; },
    pageMotionIdle: () => !pointer.current && !motion.current,
  }));
  const marks: RibbonMark[] = bookmarkPages(props.bookmarks ?? []).filter(p => p.ids.length > 0)
    .map(p => ({ key: `${page}:${p.lane}`, ids: p.ids, x: pageRibbonLeft(p.side, p.side === "right" ? width : 0), y: p.y, kind: "page", side: p.side }));
  const image = (i: number) => <div className="comic-page" key={pages[i].path} style={scroll ? { aspectRatio: dimensions.current.has(i) ? `${dimensions.current.get(i)!.width}/${dimensions.current.get(i)!.height}` : "3/4" } : undefined}>
    {urls[i] ? <img src={urls[i]} alt={`${i + 1}`} draggable={false} decoding="async" onLoad={event => {
      dimensions.current.set(i, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
      decoded.current.add(i); redraw(n => n + 1);
    }} onError={() => { errors.current.set(i, uiText("readerMisc.comic.decodeFailed")); redraw(n => n + 1); }}/> : <div className="comic-placeholder"/>}
  </div>;
  return <div ref={root} className={`comic-reader${scroll ? " is-scroll" : ""}`} style={{ backgroundColor: paper.background, color: paper.foreground }}>
    <div className="comic-track" ref={track} dir={!scroll && rtl ? "rtl" : "ltr"} style={props.inputPaused ? { touchAction: "none" } : undefined}
      onScroll={() => { if (frame.current === null) frame.current = requestAnimationFrame(() => actions.current.sample()); }}
      onPointerDown={event => {
        if (latest.current.inputPaused) return;
        alignment.current = null; fade.current?.cancel();
        pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; userMoved.current = true;
      }} onPointerCancel={() => { pointer.current = null; command.current = false; lastDirection.current = null; }} onPointerUp={event => {
        const start = pointer.current; pointer.current = null;
        if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8 || latest.current.inputPaused) return;
        const rect = root.current!.getBoundingClientRect(), taps = latest.current.tapRegions;
        const route = routeReaderTap({ device: taps?.device ?? "touch", preferences: taps?.preferences ?? { pc: { mode: "default" }, touch: { mode: "default" }, touchLeftTapForward: false, showTapHint: false }, progression: rtl ? "rtl" : "ltr", geometry: createReaderTapGeometry(rect.width, taps) }, rect.left, event.clientX, { hostTop: rect.top, clientY: event.clientY });
        if (route.kind === "turn" && !scroll) turn(route.direction === 1 ? 1 : -1);
        else if (route.kind === "bookmark") latest.current.onBookmarkCornerTap?.(route.side);
        else if (route.kind === "center" || (scroll && route.kind === "turn")) latest.current.onPlainTap?.();
      }}>{scroll ? pages.map((_, i) => image(i)) : groups.map((group, i) => <div className="comic-screen" key={i}>{group.map(image)}</div>)}</div>
    <BookmarkRibbonLayer marks={marks} cue={props.bookmarkCue ?? null} motion={moving}/>
    <button type="button" className="comic-zoom-reset" disabled={state().status !== "ready"} aria-label={uiText("readerMisc.comic.zoom")} onClick={() => {
      const p = position.current.page, dim = dimensions.current.get(p), url = urls[p];
      if (url && dim) latest.current.onImageActivation?.({ src: url, alt: pages[p].path.split('/').pop() ?? "", naturalWidth: dim.width, naturalHeight: dim.height, chapterPath: CHAPTER });
    }}>＋</button>
  </div>;
});
