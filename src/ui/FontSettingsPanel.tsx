import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { SystemFont, UserFont } from "./fontStore";
import { createDragDepthTracker } from "./fontDrop";
import { CloseIcon } from "./readerIcons";

export interface FontSettingsPanelProps {
  source?: "system" | "imported";
  customFontId?: string;
  customFontName?: string;
  systemFonts: SystemFont[];
  userFonts: UserFont[];
  busy: boolean;
  onSelectSystem(family: string): void;
  onSelectBook(): void;
  onSelectImported(font: UserFont): void;
  onDelete(id: string): void;
  onImport(files: File[]): Promise<void> | void;
  onClose(): void;
  nativeDragActive?: boolean;
  systemFontsStatus?: "idle" | "loading" | "ready" | "error";
  systemFontsError?: string | null;
  onLoadSystemFonts?(): void;
}

export const FONT_ROW_HEIGHT = 36;
export interface FontVirtualWindow<T> {
  items: T[];
  start: number;
  end: number;
  top: number;
  bottom: number;
  totalHeight: number;
}

/** Fixed-size window with spacers keeps rendering bounded and scrollable. */
export function computeFontVirtualWindow<T>(items: readonly T[], scrollTop: number, viewportHeight: number, rowHeight = FONT_ROW_HEIGHT, overscan = 4): FontVirtualWindow<T> {
  const count = items.length;
  const safeRow = Math.max(1, rowHeight);
  const safeTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeViewport = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const first = Math.min(count, Math.max(0, Math.floor(safeTop / safeRow) - Math.max(0, Math.floor(overscan))));
  const last = Math.min(count, Math.max(first, Math.ceil((safeTop + safeViewport) / safeRow) + Math.max(0, Math.floor(overscan))));
  return { items: items.slice(first, last), start: first, end: last, top: first * safeRow, bottom: Math.max(0, (count - last) * safeRow), totalHeight: count * safeRow };
}

/** Compatibility helper for callers that already have a row offset. */
export function visibleFontWindow<T>(items: readonly T[], offset: number, size: number): T[] {
  const start = Math.max(0, Math.min(items.length, Math.floor(offset)));
  return items.slice(start, start + Math.max(0, Math.floor(size)));
}

export function FontSettingsPanel(props: FontSettingsPanelProps) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"system" | "imported">("system");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const [dropBusy, setDropBusy] = useState(false);
  const [htmlDragActive, setHtmlDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(createDragDepthTracker());
  useEffect(() => {
    if (props.systemFontsStatus === "idle") props.onLoadSystemFonts?.();
  }, [props.systemFontsStatus, props.onLoadSystemFonts]);
  const normalized = query.trim().toLocaleLowerCase();
  const systems = useMemo(() => props.systemFonts.filter((font) => {
    if (!normalized) return true;
    return [font.family, ...font.localizedNames.map((item) => item.name)]
      .some((name) => name.toLocaleLowerCase().includes(normalized));
  }), [props.systemFonts, normalized]);
  const imported = useMemo(() => props.userFonts.filter((font) => {
    if (!normalized) return true;
    return `${font.family} ${font.fileName}`.toLocaleLowerCase().includes(normalized);
  }), [props.userFonts, normalized]);
  const virtual = tab === "system"
    ? computeFontVirtualWindow(systems, scrollTop, viewportHeight)
    : computeFontVirtualWindow(imported, scrollTop, viewportHeight);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const sync = () => setViewportHeight((current) => element.clientHeight === current ? current : element.clientHeight);
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(element);
    window.addEventListener("resize", sync);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, []);
  const resetScroll = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  };
  const selectTab = (next: "system" | "imported") => { setTab(next); resetScroll(); };
  const importFiles = async (files: File[]) => {
    if (props.busy || dropBusy || files.length === 0) return;
    setDropBusy(true);
    try {
      await props.onImport(files);
    } finally {
      setDropBusy(false);
    }
  };
  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.dataTransfer.types.includes("Files")) return;
    setHtmlDragActive(dragDepthRef.current.enter());
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setHtmlDragActive(dragDepthRef.current.leave());
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setHtmlDragActive(dragDepthRef.current.reset());
    void importFiles(Array.from(event.dataTransfer.files));
  };
  const dragActive = htmlDragActive || props.nativeDragActive === true;
  const effectiveBusy = props.busy || dropBusy;
  return <div className={`font-settings-panel${dragActive ? " font-drag-active" : ""}`} role="dialog" aria-modal="true" aria-label="字体设置"
    onDragEnter={onDragEnter}
    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = effectiveBusy ? "none" : "copy"; }}
    onDragLeave={onDragLeave} onDrop={onDrop}>
    <div className="drawer-drag-handle" aria-hidden="true" />
    <div className="menu-head">
      <div className="drawer-title-wrap">
        <span>字体设置</span>
      </div>
      <button className="tb-btn tb-close" onClick={props.onClose} title="关闭字体设置" aria-label="关闭字体设置">
        <CloseIcon size={14} />
      </button>
    </div>
    <div className="font-settings-current">
      当前字体：{props.source === "system" || props.source === "imported" ? props.customFontName : "跟随书籍"}
    </div>
    <button className={`font-settings-row${!props.source ? " active" : ""}`} onClick={props.onSelectBook}>跟随书籍{!props.source ? " ✓" : ""}</button>
    <input className="font-search" placeholder="搜索字体名称" value={query}
      onChange={(event) => { setQuery(event.target.value); resetScroll(); }} />
    <div className="font-settings-tabs">
      <button className={tab === "system" ? "active" : ""} onClick={() => selectTab("system")}>系统字体（{systems.length}）</button>
      <button className={tab === "imported" ? "active" : ""} onClick={() => selectTab("imported")}>已导入（{imported.length}）</button>
    </div>
    <div ref={scrollRef} className="font-settings-scroll" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      {tab === "system" && props.systemFontsStatus === "loading" && <div className="font-empty">正在读取系统字体…</div>}
      {tab === "system" && props.systemFontsStatus === "error" && <div className="font-empty">系统字体读取失败：{props.systemFontsError ?? "未知错误"}<br /><button className="menu-item" onClick={props.onLoadSystemFonts}>重试</button></div>}
      {tab === "system" && props.systemFontsStatus !== "loading" && props.systemFontsStatus !== "error" && props.source === "system" && props.customFontName && props.systemFontsStatus === "ready" && !systems.some((font) => font.family === props.customFontName) && <div className="font-empty">当前设备不可用：{props.customFontName}</div>}
      {tab === "system" && systems.length === 0 && props.systemFontsStatus === "ready" && <div className="font-empty">未找到系统字体</div>}
      {tab === "imported" && imported.length === 0 && <div className="font-empty">尚未导入字体</div>}
      <div style={{ height: virtual.totalHeight, position: "relative" }}>
        <div style={{ height: virtual.top }} />
      {virtual.items.map((font) => tab === "system" ? <button key={(font as unknown as SystemFont).family}
        className={`font-settings-row${props.source === "system" && props.customFontName === font.family ? " active" : ""}`}
        onClick={() => props.onSelectSystem((font as unknown as SystemFont).family)}>{(font as unknown as SystemFont).family}{props.source === "system" && props.customFontName === (font as unknown as SystemFont).family ? " ✓" : ""}</button> : <div key={(font as UserFont).id} className="font-settings-row-wrap">
        <button className={`font-settings-row${props.source === "imported" && props.customFontId === (font as UserFont).id ? " active" : ""}`}
          onClick={() => props.onSelectImported(font as UserFont)} title={(font as UserFont).fileName}>{(font as UserFont).family}{props.customFontId === (font as UserFont).id ? " ✓" : ""}</button>
        <button className="font-delete" onClick={() => props.onDelete((font as UserFont).id)} disabled={effectiveBusy} title="删除字体">✕</button>
      </div>)}
        <div style={{ height: virtual.bottom }} />
      </div>
    </div>
    <div className="font-drop-zone" aria-live="polite" aria-label="拖入字体文件导入">
      {effectiveBusy ? "正在导入字体…" : dragActive ? "松开以导入字体" : "可拖入 TTF、OTF、WOFF 或 WOFF2 字体"}
    </div>
    <button className="menu-item" onClick={() => inputRef.current?.click()} disabled={effectiveBusy}>＋ 导入字体</button>
    <input ref={inputRef} type="file" accept=".ttf,.otf,.woff,.woff2" multiple hidden onChange={(event) => {
      const files = Array.from(event.target.files ?? []); void importFiles(files); event.target.value = "";
    }} />
  </div>;
}
