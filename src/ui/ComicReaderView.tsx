import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChapterState, ReadingAnchor } from "../render/paginator";
import type { ReaderHandle, ReaderViewProps } from "./ReaderView";
import type { RibbonBookmark, RibbonMark } from "./bookmarkRibbons";
import { pageRibbonLeft } from "./bookmarkRibbons";
import { BookmarkRibbonLayer } from "./BookmarkRibbonLayer";
import { comicSpreads, comicPageForAnchor, comicTurnTarget } from "./comicPages";
import { comicDecodeOrder, comicReadOrder, comicSpeculativeBusy } from "./comicReadOrder";
import { COMIC_ZOOM_MAX, COMIC_ZOOM_NONE, COMIC_ZOOM_RELEASE, panComicZoom, pinchComicZoom, zoomComicAt, type ComicZoomView, type ZoomPoint } from "./comicZoom";
import { createReaderTapGeometry, routeReaderTap } from "./readerTapRouting";
import { resolveReaderPalette } from "../config/readerPalette";
import { effectivePageProgression } from "../render/settings";
import { WheelTurnAccumulator } from "./turnIntent";
import { attachReaderPaint } from "../render/visual/readerVisualPaint";
import { DEFAULT_VISUAL_PREFERENCES } from "../render/visual/readerVisualPreferences";
import { uiText } from "./localization/UiLanguageProvider";
import { getAppBuildSession } from "../config/appBuildSession";
import { watchAndroidForeground } from "../platform/androidAppTask";
import { ComicPageRaster } from "./ComicPageRaster";
import "./comicReader.css";

const CHAPTER = "__reader__/comic.xhtml";
const PAGED_WINDOW_SCREENS = 24;
const PAGED_EDGE_SCREENS = 5;
const STRIP_WINDOW_PAGES = 96;
const STRIP_EDGE_PAGES = 12;

function stripWindowStart(page: number, count: number): number {
  return Math.max(0, Math.min(count - STRIP_WINDOW_PAGES, page - STRIP_WINDOW_PAGES / 2));
}
type Position = { page: number; ratio: number };
type Lease = { url: string; blob: Blob; release(): void; pixels: number | undefined };
const ANDROID_DECODE_PIXELS = 18_000_000;
const DESKTOP_DECODE_PIXELS = 32_000_000;
/**
 * One book's page reads. The visible pages and the goal (`urgent`) never queue
 * behind a preload; each read in flight has its own controller, so a stale one
 * stops at the next native chunk instead of holding up the page on screen.
 */
type Resources = {
  closed: boolean; hidden: boolean;
  urgent: Set<number>; order: number[]; wanted: Set<number>;
  held: Map<number, Lease>; pending: Map<number, AbortController>;
  painted: Set<number>;
  publishImages(): void;
  pump(): void;
};
type Seek = Parameters<NonNullable<ReaderHandle["seekContentFraction"]>>;
/** A strip point: a page, how far down it, and how far across the strip. */
type StripAnchor = { page: number; down: number; across: number };

/** One native scrolling surface. Display spreads never become source-page identities. */
export const ComicReaderView = forwardRef<ReaderHandle, ReaderViewProps>(function ComicReaderView(props, ref) {
  const latest = useRef(props);
  latest.current = props;
  const pages = props.book.comicPages!;
  const root = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);
  const initial = comicPageForAnchor(pages, props.initialAnchor?.mediaAnchor?.signature, props.initialAnchor?.mediaAnchor?.index ?? 0);
  const position = useRef<Position>({ page: initial ?? 0, ratio: props.initialAnchor?.mediaAnchor?.ratio ?? 0 });
  const [page, setPage] = useState(position.current.page);
  const [intersectingScreen, setIntersectingScreen] = useState<number | null>(null);
  const [{ width, height }, setViewport] = useState({ width: 0, height: 0 });
  const [moving, setMoving] = useState(false);
  const command = useRef(false), lastDirection = useRef<1 | -1 | null>(null);
  const motion = useRef(false), goal = useRef(page), [warmPage, setWarmPage] = useState(page);
  const heading = useRef<{ page: number; sign: 1 | -1 }>({ page, sign: 1 });
  const [urls, setUrls] = useState<Record<number, string>>({}), [revision, redraw] = useState(0);
  const decoded = useRef(new Set<number>()), errors = useRef(new Map<number, string>());
  const dimensions = useRef(new Map<number, { width: number; height: number }>());
  const owner = useRef<Resources | null>(null);
  const alignment = useRef<Position | null>({ ...position.current });
  const lastReportKey = useRef("");
  const readyOnce = useRef(false), navigationPending = useRef(false), seek = useRef<Seek[1] | null>(null);
  const userMoved = useRef(false), pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null), fade = useRef<Animation | null>(null);
  const wheel = useRef(new WheelTurnAccumulator());
  // In-place zoom of the visible screen (paged modes only). Any turn or layout change leaves it.
  const zoom = useRef<{ el: HTMLElement; box: DOMRect; view: ComicZoomView } | null>(null);
  const gesture = useRef<{ kind: "pinch"; mid: ZoomPoint; distance: number; start: ComicZoomView } | { kind: "pan"; x: number; y: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  // Scroll mode zooms the whole strip instead: pages widen, and native scrolling pans both ways.
  const stripZoom = useRef(1);
  const stripGesture = useRef<{ distance: number; scale: number; anchor: StripAnchor } | null>(null);
  const scroll = props.settings.readingMode === "scroll";
  const [stripViewport, setStripViewport] = useState("");
  const windowedStrip = scroll && pages.length > STRIP_WINDOW_PAGES;
  const [stripStart, setStripStart] = useState(() => stripWindowStart(page, pages.length));
  const stripEnd = windowedStrip ? Math.min(pages.length, stripStart + STRIP_WINDOW_PAGES) : pages.length;
  const stripShift = useRef<{ start: number; page: number; offset: number } | null>(null);
  const firstStripPage = windowedStrip ? stripStart : 0;
  const stripChild = (index: number) => {
    const el = track.current;
    const first = el?.firstElementChild as HTMLElement | null;
    if (!first || first.dataset.comicPage === undefined) return undefined;
    return el?.children[index - Number(first.dataset.comicPage)] as HTMLElement | undefined;
  };
  const columns: 1 | 2 = !scroll && props.settings.columnsPerView === 2 && width >= 600 ? 2 : 1;
  const groups = useMemo(() => comicSpreads(pages, columns), [pages, columns]);
  const groupForPage = useMemo(() => {
    const indexes: number[] = [];
    groups.forEach((group, i) => group.forEach(p => { indexes[p] = i; }));
    return indexes;
  }, [groups]);
  const screenWindowStart = (screen: number) => Math.max(0, Math.min(screen - Math.floor(PAGED_WINDOW_SCREENS / 2), groups.length - PAGED_WINDOW_SCREENS));
  const [screenStart, setScreenStart] = useState(() => screenWindowStart(groupForPage[page]));
  const screenEnd = Math.min(groups.length, screenStart + PAGED_WINDOW_SCREENS);
  const screenShift = useRef<{ start: number; screen: number } | null>(null);
  const screenChild = (screen: number) => {
    const el = track.current;
    const first = (el?.firstElementChild as HTMLElement | null)?.dataset.comicScreen;
    return first === undefined ? undefined : el?.children[screen - Number(first)] as HTMLElement | undefined;
  };
  const rtl = effectivePageProgression(props.book.pageProgression, props.settings, true) === "rtl";
  const paper = resolveReaderPalette(props.settings.theme);
  const visible = () => scroll ? [position.current.page] : groups[groupForPage[position.current.page]];
  // CSS pixels may be fractional at OS/WebView zoom; clientWidth rounds and drifts over many pages.
  // A zoomed screen's rect includes its scale; every screen shares the unzoomed width.
  const pitch = () => zoom.current?.box.width ?? track.current?.firstElementChild?.getBoundingClientRect().width ?? width;
  const fraction = () => (position.current.page + position.current.ratio) / pages.length;
  const atEnd = () => scroll
    ? stripEnd === pages.length && !!track.current && track.current.scrollTop + track.current.clientHeight >= track.current.scrollHeight - 1
    : groupForPage[position.current.page] === groups.length - 1;
  const atStart = () => scroll ? firstStripPage === 0 && (track.current?.scrollTop ?? 0) <= 1 : groupForPage[position.current.page] === 0;
  const state = (): ChapterState => {
    const shown = visible();
    const failed = shown.map(i => errors.current.get(i)).find(Boolean);
    if (failed) return { status: "error", message: failed };
    if ((scroll ? !stripChild(position.current.page) : !screenChild(groupForPage[position.current.page])) || shown.some(i => !urls[i] || !decoded.current.has(i))) return { status: "loading" };
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
    const key = current.status === "ready"
      ? [current.mode, current.effectiveColumns, current.currentPage, current.pageCount, current.leafRange?.first,
        current.leafRange?.last, current.totalScrollProgress, current.transient, current.atEnd].join(":")
      : current.status === "error" ? "error:" + current.message : current.status;
    const changed = key !== lastReportKey.current;
    if (changed) {
      lastReportKey.current = key;
      latest.current.onPageState(current);
    }
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
    if (changed) latest.current.onUserProgressSample?.({ key: CHAPTER, spineIndex: 0, fraction: fraction(), atEnd: atEnd() });
  };
  const align = (p: Position, behavior: ScrollBehavior = "auto") => {
    const el = track.current;
    if (!el) return false;
    if (scroll) {
      const child = stripChild(p.page);
      if (!child) {
        if (windowedStrip) setStripStart(stripWindowStart(p.page, pages.length));
        return false;
      }
      el.scrollTo({ top: child.offsetTop + p.ratio * Math.max(0, child.offsetHeight - el.clientHeight), behavior });
    } else {
      const screen = groupForPage[p.page];
      if (!screenChild(screen)) {
        setScreenStart(screenWindowStart(screen));
        return false;
      }
      el.scrollTo({ left: (rtl ? -1 : 1) * (screen - screenStart) * pitch(), behavior });
    }
    return true;
  };
  const paintZoom = () => {
    const z = zoom.current;
    if (!z) return;
    z.el.style.transformOrigin = "0 0";
    z.el.style.transform = `translate(${z.view.x}px, ${z.view.y}px) scale(${z.view.scale})`;
  };
  const beginZoom = (): boolean => {
    if (zoom.current) return true;
    if (scroll || latest.current.inputPaused || motion.current) return false;
    const el = screenChild(groupForPage[position.current.page]);
    if (!el) return false;
    zoom.current = { el, box: el.getBoundingClientRect(), view: COMIC_ZOOM_NONE };
    setZoomed(true);
    return true;
  };
  const endZoom = (springBack = false) => {
    const z = zoom.current;
    zoom.current = null; gesture.current = null;
    if (!z) return;
    const from = z.el.style.transform;
    z.el.style.transform = ""; z.el.style.transformOrigin = ""; z.el.classList.remove("is-zooming");
    if (springBack && from && document.documentElement.dataset.motion !== "reduced")
      z.el.animate([{ transform: from, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], { duration: 180, easing: "ease-out" });
    setZoomed(false);
  };
  const settleZoom = () => { if (zoom.current && zoom.current.view.scale <= COMIC_ZOOM_RELEASE) endZoom(true); };
  /** The strip page whose top is at or above `y` (track content px). */
  const stripPageAt = (y: number) => {
    const el = track.current!;
    let low = 0, high = el.children.length - 1, p = 0;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if ((el.children[mid] as HTMLElement).offsetTop <= y) { p = mid; low = mid + 1; }
      else high = mid - 1;
    }
    return p + firstStripPage;
  };
  /** The strip point under (x, y), relative to the track's box. */
  const stripAnchor = (x: number, y: number): StripAnchor => {
    const el = track.current!, page = stripPageAt(el.scrollTop + y), child = stripChild(page)!;
    return { page, down: (el.scrollTop + y - child.offsetTop) / Math.max(1, child.offsetHeight), across: (el.scrollLeft + x) / Math.max(1, el.clientWidth * stripZoom.current) };
  };
  /** Widens the strip to `scale` and puts `anchor` back under (x, y). */
  const zoomStrip = (scale: number, anchor: StripAnchor, x: number, y: number) => {
    const el = track.current;
    if (!el) return;
    scale = Math.min(COMIC_ZOOM_MAX, Math.max(1, scale));
    stripZoom.current = scale;
    if (scale === 1) el.style.removeProperty("--comic-strip-zoom");
    else el.style.setProperty("--comic-strip-zoom", String(scale));
    setZoomed(scale > 1);
    const child = stripChild(anchor.page);
    if (child) el.scrollTop = child.offsetTop + anchor.down * child.offsetHeight - y;
    el.scrollLeft = anchor.across * el.clientWidth * scale - x;
  };
  const settleStrip = () => {
    const el = track.current;
    if (!el || stripZoom.current === 1 || stripZoom.current > COMIC_ZOOM_RELEASE) return;
    zoomStrip(1, stripAnchor(el.clientWidth / 2, el.clientHeight / 2), el.clientWidth / 2, el.clientHeight / 2);
  };
  const locate = (p: number, ratio = 0, behavior: ScrollBehavior = "auto") => {
    endZoom();
    stripShift.current = null;
    screenShift.current = null;
    p = Math.max(0, Math.min(pages.length - 1, p));
    if (!scroll && !screenChild(groupForPage[p])) behavior = "auto";
    goal.current = p;
    setWarmPage(p);
    command.current = behavior === "smooth";
    if (behavior !== "smooth") {
      position.current = { page: p, ratio };
      setPage(p);
      alignment.current = { ...position.current };
      motion.current = false;
      setIntersectingScreen(null);
      setMoving(false);
    }
    align({ page: p, ratio }, behavior);
    // Same-page seeks have no scroll event; still resolve only after the image is ready.
    queueMicrotask(() => actions.current.report());
  };
  const turn = (direction: 1 | -1) => {
    if (latest.current.inputPaused) return;
    endZoom();
    userMoved.current = true;
    fade.current?.cancel();
    if (scroll) {
      alignment.current = null;
      track.current?.scrollBy({ top: direction * track.current.clientHeight * .9, behavior: "smooth" });
      return;
    }
    const visual = alignment.current ? groupForPage[goal.current] : screenStart + Math.abs(track.current?.scrollLeft ?? 0) / Math.max(1, pitch());
    const target = comicTurnTarget(visual, groupForPage[goal.current], direction, lastDirection.current);
    const next = groups[target];
    if (!next) return;
    alignment.current = null;
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
      if (visible().some(i => !decoded.current.has(i)) || !align(alignment.current)) return;
      alignment.current = null;
    }
    if (scroll) {
      const first = stripPageAt(el.scrollTop);
      const last = stripPageAt(el.scrollTop + el.clientHeight - 1);
      setStripViewport(`${first}:${last}`);
      const p = stripEnd === pages.length && el.scrollHeight > el.clientHeight && atEnd()
        ? pages.length - 1
        : stripPageAt(el.scrollTop + el.clientHeight * .2);
      const child = stripChild(p);
      if (!child) return;
      if (windowedStrip && !stripShift.current &&
          ((firstStripPage > 0 && first - firstStripPage < STRIP_EDGE_PAGES) ||
           (stripEnd < pages.length && stripEnd - last <= STRIP_EDGE_PAGES))) {
        const start = stripWindowStart(p, pages.length);
        const top = stripChild(first);
        if (start !== firstStripPage && top && first >= start) {
          stripShift.current = { start, page: first, offset: el.scrollTop - top.offsetTop };
          setStripStart(start);
        }
      }
      position.current = { page: p, ratio: Math.max(0, Math.min(1, (el.scrollTop - child.offsetTop) / Math.max(1, child.offsetHeight - el.clientHeight))) };
      setWarmPage(p);
    } else {
      if (screenShift.current) return;
      const step = Math.max(1, pitch());
      const distance = screenStart * step + Math.abs(el.scrollLeft);
      const screen = Math.max(screenStart, Math.min(screenEnd - 1, Math.round(distance / step)));
      // Native gestures can expose the next spread before it becomes the current page.
      const otherScreen = distance < screen * step ? screen - 1 : screen + 1;
      setIntersectingScreen(Math.abs(distance - screen * step) > .75 && groups[otherScreen] ? otherScreen : null);
      const targetReached = Math.abs(distance - groupForPage[goal.current] * step) <= .75;
      if (targetReached) command.current = false;
      motion.current = Math.abs(distance - screen * step) > .75 || command.current;
      setMoving(motion.current);
      const shown = groups[screen];
      if (zoom.current && zoom.current.el !== screenChild(screen)) endZoom();
      if (!shown.includes(position.current.page)) position.current = { page: shown[0], ratio: 0 };
      if (!motion.current) {
        goal.current = position.current.page;
        setWarmPage(position.current.page);
        lastDirection.current = null;
        if (!pointer.current && !zoom.current &&
            ((screenStart > 0 && screen - screenStart < PAGED_EDGE_SCREENS) ||
             (screenEnd < groups.length && screenEnd - screen <= PAGED_EDGE_SCREENS))) {
          const start = screenWindowStart(screen);
          if (start !== screenStart) {
            screenShift.current = { start, screen };
            setScreenStart(start);
          }
        }
      }
    }
    setPage(position.current.page);
    report();
  };
  // Native listeners read the current layout/actions, never a previous mode's closure.
  const actions = useRef({ report, sample, turn, beginZoom, paintZoom, settleZoom, stripAnchor, zoomStrip, settleStrip });
  actions.current = { report, sample, turn, beginZoom, paintZoom, settleZoom, stripAnchor, zoomStrip, settleStrip };
  useLayoutEffect(() => {
    const el = root.current!;
    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el); resize();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    endZoom();
    screenShift.current = null;
    setIntersectingScreen(null);
    if (!scroll && stripZoom.current !== 1) {
      stripZoom.current = 1; stripGesture.current = null;
      track.current?.style.removeProperty("--comic-strip-zoom");
      setZoomed(false);
    }
    alignment.current = { ...position.current };
    if (align(alignment.current) && visible().every(i => decoded.current.has(i))) alignment.current = null;
  }, [width, columns, scroll, rtl]);
  useLayoutEffect(() => {
    const shift = stripShift.current;
    const el = track.current;
    if (scroll && shift?.start === stripStart && el) {
      stripShift.current = null;
      const child = stripChild(shift.page);
      if (child) el.scrollTop = child.offsetTop + shift.offset;
    }
    const horizontalShift = screenShift.current;
    if (!scroll && el && horizontalShift?.start === screenStart) {
      screenShift.current = null;
      el.scrollTo({ left: (rtl ? -1 : 1) * (horizontalShift.screen - screenStart) * pitch(), behavior: "instant" });
    }
    if (alignment.current && align(alignment.current) && visible().every(i => decoded.current.has(i))) {
      alignment.current = null;
    }
  }, [revision, urls, stripStart, screenStart]);
  useEffect(() => {
    const server = props.server;
    const session = getAppBuildSession();
    const android = session?.source === "desktop" && session.platform === "android";
    let nativeForeground = !android;
    let displayed = new Set<number>();
    const budget = android ? ANDROID_DECODE_PIXELS : DESKTOP_DECODE_PIXELS;
    const resources: Resources = {
      closed: false, hidden: document.hidden || !nativeForeground,
      urgent: new Set(), order: [], wanted: new Set(), held: new Map(), pending: new Map(), painted: new Set(),
      publishImages() {
        const order = resources.hidden ? resources.order.filter(i => resources.urgent.has(i)) : resources.order;
        const next = new Set(comicDecodeOrder(order, resources.urgent, i => resources.held.get(i)?.pixels, budget)
          .filter(i => resources.held.has(i)));
        if (next.size === displayed.size && [...next].every(i => displayed.has(i))) return;
        displayed = next;
        setUrls(Object.fromEntries([...next].map(i => [i, resources.held.get(i)!.url])));
      },
      pump() {
        if (resources.closed) return;
        resources.publishImages();
        const urgentReady = [...resources.urgent].every(i => resources.painted.has(i) || errors.current.has(i));
        // Preloads give way until the visible pages arrive, and wait while in the background.
        const preload = urgentReady && !resources.hidden;
        if (!preload) for (const [i, controller] of resources.pending) if (!resources.urgent.has(i)) {
          controller.abort(); resources.pending.delete(i);
        }
        let speculativeBusy = comicSpeculativeBusy(resources.order, resources.urgent, resources.pending, displayed,
          i => resources.painted.has(i) || errors.current.has(i));
        for (const i of resources.order) {
          const urgent = resources.urgent.has(i);
          if (!urgent && (!preload || speculativeBusy)) break;
          if (resources.held.has(i) || resources.pending.has(i) || errors.current.has(i)) continue;
          const controller = new AbortController();
          if (!urgent) speculativeBusy = true;
          resources.pending.set(i, controller);
          void server.acquireResource(pages[i].path, controller.signal).then(lease => {
            if (resources.closed || controller.signal.aborted || !resources.wanted.has(i)) { lease.release(); return; }
            resources.held.set(i, { ...lease, pixels: server.resourceRasterPixels(pages[i].path) });
          }).catch(error => {
            if (!resources.closed && !controller.signal.aborted) { errors.current.set(i, String(error)); redraw(n => n + 1); }
          }).finally(() => {
            // A newer read of the same page owns the slot now.
            if (resources.pending.get(i) !== controller) return;
            resources.pending.delete(i);
            resources.pump();
          });
        }
      },
    };
    owner.current = resources;
    lastReportKey.current = "";
    decoded.current.clear(); errors.current.clear(); setUrls({});
    const onVisibility = () => {
      resources.hidden = document.hidden || !nativeForeground;
      resources.pump();
    };
    const unwatch = android ? watchAndroidForeground(foreground => {
      nativeForeground = foreground;
      onVisibility();
    }) : undefined;
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      resources.closed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      unwatch?.();
      for (const controller of resources.pending.values()) controller.abort();
      resources.pending.clear();
      for (const lease of resources.held.values()) lease.release();
      resources.held.clear();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      fade.current?.cancel();
    };
  }, [props.server]);
  useEffect(() => {
    const resources = owner.current!;
    if (page !== heading.current.page) heading.current = { page, sign: page > heading.current.page ? 1 : -1 };
    // Scroll mode may show more than one page; the strip's top and bottom edges name them.
    const el = track.current;
    const adjacent = intersectingScreen !== null && Math.abs(intersectingScreen - groupForPage[page]) === 1
      ? groups[intersectingScreen]?.[0] : undefined;
    const shown = scroll && el && stripChild(page)
      ? [stripPageAt(el.scrollTop), stripPageAt(el.scrollTop + el.clientHeight - 1)]
      : adjacent === undefined ? [page] : [page, adjacent];
    const plan = comicReadOrder(groups, groupForPage, shown, warmPage, heading.current.sign);
    resources.urgent = new Set(plan.urgent);
    resources.order = plan.order;
    resources.wanted = new Set(plan.order);
    for (const [i, controller] of resources.pending) if (!resources.wanted.has(i)) {
      controller.abort(); resources.pending.delete(i);
    }
    for (const [i, lease] of resources.held) if (!resources.wanted.has(i)) {
      lease.release(); resources.held.delete(i);
    }
    resources.pump();
  }, [page, warmPage, intersectingScreen, groups, scroll, stripViewport, stripStart, revision, props.server, pages, groupForPage]);
  useEffect(() => {
    const resources = owner.current;
    if (!resources) return;
    let paintedFrame = 0;
    const frame = requestAnimationFrame(() => {
      paintedFrame = requestAnimationFrame(() => {
        if (resources.closed) return;
        for (const i of decoded.current) resources.painted.add(i);
        resources.pump();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(paintedFrame);
    };
  }, [revision, props.server]);
  useEffect(() => { report(); }, [page, moving, urls, revision, width, columns, scroll]);
  useEffect(() => {
    const el = track.current!;
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      if (scroll) {
        // The wheel scrolls the strip natively; Ctrl+wheel (and a trackpad pinch) widens it at the pointer.
        if (!event.ctrlKey) return;
        event.preventDefault();
        if (latest.current.inputPaused) return;
        const box = el.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
        actions.current.zoomStrip(stripZoom.current * Math.exp(-event.deltaY * unit * 0.002), actions.current.stripAnchor(x, y), x, y);
        actions.current.settleStrip();
        return;
      }
      // Ctrl+wheel (and a trackpad pinch) zooms at the pointer; a zoomed screen pans with the wheel.
      if (event.ctrlKey || zoom.current) {
        event.preventDefault();
        if (latest.current.inputPaused || !actions.current.beginZoom()) return;
        const z = zoom.current!;
        z.view = event.ctrlKey
          ? zoomComicAt(z.view, { x: event.clientX - z.box.left, y: event.clientY - z.box.top }, Math.exp(-event.deltaY * unit * 0.002), z.box.width, z.box.height)
          : panComicZoom(z.view, -event.deltaX * unit, -event.deltaY * unit, z.box.width, z.box.height);
        actions.current.paintZoom();
        actions.current.settleZoom();
        return;
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      if (latest.current.inputPaused) return;
      const delta = event.deltaY * unit;
      const direction = wheel.current.push(delta);
      if (direction) actions.current.turn(direction);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scroll]);
  useEffect(() => {
    if (!scroll) return;
    const el = track.current!;
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList) => {
      const box = el.getBoundingClientRect();
      return { x: (t[0].clientX + t[1].clientX) / 2 - box.left, y: (t[0].clientY + t[1].clientY) / 2 - box.top };
    };
    // Layout follows the fingers once per frame; the strip re-lays out at every scale.
    let pending: { scale: number; x: number; y: number } | null = null, raf: number | null = null;
    const flush = () => {
      raf = null;
      const g = stripGesture.current;
      if (g && pending) actions.current.zoomStrip(pending.scale, g.anchor, pending.x, pending.y);
      pending = null;
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2 || latest.current.inputPaused) return;
      const m = mid(event.touches);
      stripGesture.current = { distance: spread(event.touches), scale: stripZoom.current, anchor: actions.current.stripAnchor(m.x, m.y) };
    };
    const move = (event: TouchEvent) => {
      const g = stripGesture.current;
      if (!g || event.touches.length !== 2) return;
      event.preventDefault();
      pending = { scale: g.scale * spread(event.touches) / Math.max(1, g.distance), ...mid(event.touches) };
      if (raf === null) raf = requestAnimationFrame(flush);
    };
    const end = (event: TouchEvent) => {
      if (!stripGesture.current || event.touches.length >= 2) return;
      if (raf !== null) { cancelAnimationFrame(raf); flush(); }
      stripGesture.current = null;
      actions.current.settleStrip();
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [scroll]);
  useEffect(() => {
    if (scroll) return;
    const el = track.current!;
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList): ZoomPoint => {
      const box = zoom.current!.box;
      return { x: (t[0].clientX + t[1].clientX) / 2 - box.left, y: (t[0].clientY + t[1].clientY) / 2 - box.top };
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length === 2 && actions.current.beginZoom()) {
        const z = zoom.current!;
        z.el.classList.add("is-zooming");
        gesture.current = { kind: "pinch", mid: mid(event.touches), distance: spread(event.touches), start: z.view };
      } else if (event.touches.length === 1 && zoom.current) {
        zoom.current.el.classList.add("is-zooming");
        gesture.current = { kind: "pan", x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
    };
    const move = (event: TouchEvent) => {
      const z = zoom.current, g = gesture.current;
      if (!z || !g) return;
      // Neither the pinch nor a zoomed pan may scroll the track to another screen.
      event.preventDefault();
      if (g.kind === "pinch" && event.touches.length === 2) {
        z.view = pinchComicZoom(g.start, g.mid, g.distance, mid(event.touches), spread(event.touches), z.box.width, z.box.height);
      } else if (g.kind === "pan" && event.touches.length === 1) {
        const t = event.touches[0];
        z.view = panComicZoom(z.view, t.clientX - g.x, t.clientY - g.y, z.box.width, z.box.height);
        gesture.current = { kind: "pan", x: t.clientX, y: t.clientY };
      }
      actions.current.paintZoom();
    };
    const end = (event: TouchEvent) => {
      const z = zoom.current;
      if (!z) return;
      // The finger left on the glass after a pinch keeps panning.
      if (event.touches.length === 1 && z.view.scale > COMIC_ZOOM_RELEASE) {
        gesture.current = { kind: "pan", x: event.touches[0].clientX, y: event.touches[0].clientY };
        return;
      }
      if (event.touches.length > 0) return;
      gesture.current = null;
      z.el.classList.remove("is-zooming");
      actions.current.settleZoom();
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
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
    const child = scroll ? stripChild(p) : undefined;
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
  const image = useCallback((i: number) => {
    const url = urls[i];
    const lease = owner.current?.held.get(i);
    const size = url && !scroll ? props.server.resourceRasterSize(pages[i].path) : undefined;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const scale = size && width && height ? Math.min(width / columns * dpr / size.width, height * dpr / size.height) : 1;
    // Small chrome/viewport changes should not schedule a fresh decode.
    const targetHeight = size && scale < .8 && typeof createImageBitmap === "function"
      ? Math.min(size.height, Math.ceil(size.height * scale / 32) * 32)
      : undefined;
    return <div className="comic-page" key={pages[i].path} data-comic-page={scroll ? i : undefined}
      style={scroll ? { aspectRatio: dimensions.current.has(i) ? `${dimensions.current.get(i)!.width}/${dimensions.current.get(i)!.height}` : "3/4" } : undefined}>
      {url && lease ? <ComicPageRaster key={url} url={url} blob={lease.blob} alt={`${i + 1}`} targetHeight={targetHeight} zoomed={zoomed && !scroll && groupForPage[i] === groupForPage[page]}
        onReady={size => {
          dimensions.current.set(i, size);
          decoded.current.add(i);
          redraw(n => n + 1);
        }}
        onError={() => { errors.current.set(i, uiText("readerMisc.comic.decodeFailed")); redraw(n => n + 1); }}
        onGone={() => {
          // Decoded means "this page's element on screen has drawn". Releases and
          // re-reads that React folds into one render keep the element, so only
          // its removal may clear the mark.
          decoded.current.delete(i);
          owner.current?.painted.delete(i);
        }}/>
        : <div className="comic-placeholder"/>}
    </div>;
  }, [pages, scroll, urls, props.server, width, height, columns, zoomed, groupForPage, page]);
  const strip = useMemo(() => scroll ? pages.slice(firstStripPage, stripEnd).map((_, i) => image(firstStripPage + i))
    : groups.slice(screenStart, screenEnd).map((group, i) => (
      <div className="comic-screen" key={screenStart + i} data-comic-screen={screenStart + i}>{group.map(image)}</div>
    )), [scroll, pages, groups, image, revision, firstStripPage, stripEnd, screenStart, screenEnd]);
  return <div ref={root} className={`comic-reader${scroll ? " is-scroll" : ""}`} style={{ backgroundColor: paper.background, color: paper.foreground }}>
    <div className={`comic-track${zoomed ? " is-zoomed" : ""}`} ref={track} dir={!scroll && rtl ? "rtl" : "ltr"} style={props.inputPaused ? { touchAction: "none" } : undefined}
      onScroll={() => { if (frame.current === null) frame.current = requestAnimationFrame(() => actions.current.sample()); }}
      onPointerDown={event => {
        if (latest.current.inputPaused) return;
        alignment.current = null; fade.current?.cancel();
        pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; userMoved.current = true;
      }} onPointerMove={event => {
        if (event.pointerType !== "mouse" || event.buttons !== 1) return;
        if (scroll) { if (stripZoom.current > 1) track.current?.scrollBy(-event.movementX, -event.movementY); return; }
        const z = zoom.current;
        if (!z) return;
        z.view = panComicZoom(z.view, event.movementX, event.movementY, z.box.width, z.box.height);
        paintZoom();
      }} onPointerCancel={() => { pointer.current = null; command.current = false; lastDirection.current = null; }} onPointerUp={event => {
        const start = pointer.current; pointer.current = null;
        if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8 || latest.current.inputPaused) return;
        const rect = root.current!.getBoundingClientRect(), taps = latest.current.tapRegions;
        const route = routeReaderTap({ device: taps?.device ?? "touch", preferences: taps?.preferences ?? { pc: { mode: "default" }, touch: { mode: "default" }, touchLeftTapForward: false, showTapHint: false }, progression: rtl ? "rtl" : "ltr", geometry: createReaderTapGeometry(rect.width, taps) }, rect.left, event.clientX, { hostTop: rect.top, clientY: event.clientY });
        if (route.kind === "turn" && !scroll) turn(route.direction === 1 ? 1 : -1);
        else if (route.kind === "bookmark") latest.current.onBookmarkCornerTap?.(route.side);
        else if (route.kind === "center" || (scroll && route.kind === "turn")) latest.current.onPlainTap?.();
      }}>{strip}</div>
    <BookmarkRibbonLayer marks={marks} cue={props.bookmarkCue ?? null} motion={moving}/>
  </div>;
});
