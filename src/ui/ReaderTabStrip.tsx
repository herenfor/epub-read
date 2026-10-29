import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useUiText } from "./localization/UiLanguageProvider";
import { PanelPaintWarmup } from "./panelPaintWarmup";
import {
  TAB_ACTIVE_MIN_PX,
  fitReaderTabs,
  splitTabTitle,
} from "./readerTabs";
import "./readerTabStrip.css";

export interface ReaderTabItem {
  id: string;
  title: string;
  /** 读到哪，如“第三章 · 37%”。 */
  detail?: string;
}

export interface ReaderTabStripProps {
  tabs: readonly ReaderTabItem[];
  activeId: string | null;
  max: number;
  /** “＋”里列出的最近读过、现在没开着的书。 */
  recent: readonly ReaderTabItem[];
  onSelect(id: string): void;
  onClose(id: string): void;
  /** 在新标签页打开这本。 */
  onOpenNew(id: string): void;
  /** 回书架挑一本，作为新标签打开。 */
  onPickFromShelf(): void;
  /** 只为预热画一次两个面板（见 panelPaintWarmup）。 */
  warm?: boolean;
  /** 面板开着时顶栏不能自动收起。 */
  onMenuOpenChange?(open: boolean): void;
  /** 只开一本时代替标签显示的书名，“＋”跟在它后面。 */
  children?: ReactNode;
}

const PLUS_PX = 28;
const MORE_PX = 48;
const GAP_PX = 2;
/** 中间进度胶囊至少留的宽度（够放章名、细条和百分比）。 */
const MIDDLE_MIN_PX = 260;
/** 标签条最多占两侧按钮之间的这么多。 */
const TABS_SHARE = 0.6;

type MenuKind = "new" | "list";

/**
 * 只开一本时显示书名加“＋”；两本以上时是顶栏标签条：标签先变窄，再从离当前最远的开始收进“+N”列表，
 * 给中间的进度胶囊留出位置。“＋”列出最近读过的书，也能回书架挑。
 */
export function ReaderTabStrip(props: ReaderTabStripProps) {
  const { t } = useUiText();
  const stripRef = useRef<HTMLDivElement>(null);
  const [budget, setBudget] = useState(0);
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: HTMLElement } | null>(null);
  const onMenuOpenChange = props.onMenuOpenChange;
  const single = props.tabs.length < 2;

  useLayoutEffect(() => {
    if (single) return;
    const strip = stripRef.current;
    const header = strip?.closest<HTMLElement>(".titlebar");
    const left = strip?.parentElement;
    if (!strip || !header || !left || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = header.clientWidth;
      if (width <= 0) return;
      const right = header.querySelector<HTMLElement>(".titlebar-right")?.offsetWidth ?? 0;
      let fixed = 0;
      for (const child of Array.from(left.children)) {
        if (child !== strip) fixed += (child as HTMLElement).offsetWidth + 6;
      }
      const between = width - right - fixed;
      // 触屏顶栏中间没有进度胶囊，只留一点拖动/点按的空白。
      const touch = header.classList.contains("is-mobile-compact");
      const next = Math.floor(touch ? between - 48 : Math.min(between * TABS_SHARE, between - MIDDLE_MIN_PX));
      setBudget(Math.max(TAB_ACTIVE_MIN_PX + PLUS_PX, next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [single]);

  useEffect(() => {
    onMenuOpenChange?.(menu !== null);
  }, [menu, onMenuOpenChange]);
  useEffect(() => () => onMenuOpenChange?.(false), [onMenuOpenChange]);

  const ids = props.tabs.map((tab) => tab.id);
  const fit = fitReaderTabs(ids, props.activeId, budget, { plus: PLUS_PX, more: MORE_PX, gap: GAP_PX });
  const byId = new Map(props.tabs.map((tab) => [tab.id, tab] as const));
  const full = props.tabs.length >= props.max;

  const toggle = (kind: MenuKind, anchor: HTMLElement) =>
    setMenu((current) => (current?.kind === kind ? null : { kind, anchor }));
  const close = () => setMenu(null);

  return (
    <>
      <div ref={stripRef} className={single ? "titlebar-reader-single" : "titlebar-reader-tabs"}
        role={single ? undefined : "tablist"} aria-label={single ? undefined : t("titlebar.tabs")}
        style={!single && budget > 0 ? { maxWidth: budget } : undefined}>
        {single ? props.children : fit.visible.map((id) => {
          const tab = byId.get(id)!;
          const active = id === props.activeId;
          const name = splitTabTitle(tab.title);
          return (
            <div
              key={id}
              className={`titlebar-reader-tab${active ? " is-active" : ""}`}
              onAuxClick={(event) => {
                if (event.button === 1) props.onClose(id);
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="titlebar-reader-tab-label"
                title={t("titlebar.tabs.tip", { title: tab.title })}
                onClick={() => props.onSelect(id)}
              >
                <span className="titlebar-reader-tab-head">{name.head}</span>
                {name.tail && <span className="titlebar-reader-tab-tail">{name.tail}</span>}
              </button>
              <button
                type="button"
                className="titlebar-reader-tab-close"
                aria-label={t("titlebar.tabs.close", { title: tab.title })}
                title={t("titlebar.tabs.close", { title: tab.title })}
                onClick={() => props.onClose(id)}
              >
                <CloseGlyph />
              </button>
            </div>
          );
        })}
        {!single && fit.hidden.length > 0 && (
          <button
            type="button"
            className={`titlebar-reader-tabs-more${menu?.kind === "list" ? " is-open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "list"}
            aria-label={t("titlebar.tabs.more", { count: fit.hidden.length })}
            title={t("titlebar.tabs.more", { count: fit.hidden.length })}
            onClick={(event) => toggle("list", event.currentTarget)}
          >
            +{fit.hidden.length}
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`titlebar-reader-tabs-new${menu?.kind === "new" ? " is-open" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={menu?.kind === "new"}
          aria-label={full ? t("titlebar.tabs.full", { max: props.max }) : t("titlebar.tabs.new")}
          title={full ? t("titlebar.tabs.full", { max: props.max }) : t("titlebar.tabs.new")}
          disabled={full}
          onClick={(event) => toggle("new", event.currentTarget)}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>
      {menu && (
        <TabMenuPortal anchor={menu.anchor} host={stripRef.current}>
          {menu.kind === "new"
            ? <NewTabPanel {...props} onDone={close} anchor={menu.anchor} />
            : <TabListPanel {...props} hidden={fit.hidden} onDone={close} anchor={menu.anchor} />}
        </TabMenuPortal>
      )}
      {props.warm && !menu && (
        <TabMenuPortal anchor={null} host={stripRef.current}>
          <PanelPaintWarmup active>
            <NewTabPanel {...props} onDone={noop} anchor={null} warm />
            {!single && <TabListPanel {...props} hidden={fit.hidden} onDone={noop} anchor={null} warm />}
          </PanelPaintWarmup>
        </TabMenuPortal>
      )}
    </>
  );
}

const noop = () => {};

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M2 2l6 6M8 2l-6 6" />
    </svg>
  );
}

/** 面板挂到 `.app` 下：自定义主题的界面颜色定义在那里，顶栏自己的滚动和变形也不会裁到它。 */
function TabMenuPortal({ host, children }: { anchor: HTMLElement | null; host: HTMLElement | null; children: ReactNode }) {
  const target = host?.closest<HTMLElement>(".app") ?? (typeof document === "undefined" ? null : document.body);
  return target ? createPortal(children, target) : null;
}

interface PanelProps extends ReaderTabStripProps {
  anchor: HTMLElement | null;
  onDone(): void;
  warm?: boolean;
}

/**
 * 面板的进场：先挂上（几乎透明，GPU 先把它画好），下一帧再开始过渡。
 * 关闭监听和定位与书签面板一致；预热实例不定位、不聚焦、不挂监听。
 */
function usePanel(props: PanelProps, width: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(Boolean(props.warm));
  const [position, setPosition] = useState({ top: 44, left: 8 });
  const { anchor, onDone, warm } = props;

  useLayoutEffect(() => {
    if (warm || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    setPosition({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left - 8, viewport - width - 8)) });
  }, [anchor, warm, width]);

  useEffect(() => {
    if (warm) return;
    const frame = requestAnimationFrame(() => setShown(true));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDone();
      anchor?.focus({ preventScroll: true });
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (ref.current?.contains(target) || anchor?.contains(target))) return;
      onDone();
    };
    // 点正文时焦点进入 iframe，宿主只收到 blur。
    const onBlur = () => onDone();
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onBlur);
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [anchor, onDone, warm]);

  return {
    ref,
    className: `reader-tab-panel${shown ? " is-shown" : ""}`,
    style: warm ? { width } : { top: position.top, left: position.left, width },
  };
}

function NewTabPanel(props: PanelProps) {
  const { t } = useUiText();
  const panel = usePanel(props, 300);
  return (
    <div ref={panel.ref} className={panel.className} style={panel.style} role="dialog" aria-label={t("titlebar.tabs.new")}>
      {props.recent.length > 0 && (
        <>
          <div className="reader-tab-panel-label">{t("titlebar.tabs.recent")}</div>
          <div className="reader-tab-panel-card">
            {props.recent.map((book) => (
              <button key={book.id} type="button" className="reader-tab-panel-row"
                onClick={() => {
                  props.onDone();
                  props.onOpenNew(book.id);
                }}>
                <span className="reader-tab-panel-text">
                  <span className="reader-tab-panel-title">{book.title}</span>
                  {book.detail && <span className="reader-tab-panel-detail">{book.detail}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      <button type="button" className="reader-tab-panel-card reader-tab-panel-shelf"
        onClick={() => {
          props.onDone();
          props.onPickFromShelf();
        }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="4" height="11" rx="0.8" />
          <rect x="9.5" y="2.5" width="4" height="11" rx="0.8" />
        </svg>
        {t("titlebar.tabs.pickFromShelf")}
      </button>
      <div className="reader-tab-panel-foot">{t("titlebar.tabs.count", { count: props.tabs.length, max: props.max })}</div>
    </div>
  );
}

function TabListPanel(props: PanelProps & { hidden: readonly string[] }) {
  const { t } = useUiText();
  const panel = usePanel(props, 320);
  const hidden = new Set(props.hidden);
  const groups = [
    props.tabs.filter((tab) => !hidden.has(tab.id)),
    props.tabs.filter((tab) => hidden.has(tab.id)),
  ];
  return (
    <div ref={panel.ref} className={panel.className} style={panel.style} role="menu" aria-label={t("titlebar.tabs")}>
      <div className="reader-tab-panel-label">{t("titlebar.tabs.count", { count: props.tabs.length, max: props.max })}</div>
      {groups.map((group, index) => group.length > 0 && (
        <div key={index} className="reader-tab-panel-group">
          {index === 1 && <div className="reader-tab-panel-label">{t("titlebar.tabs.overflow")}</div>}
          <div className="reader-tab-panel-card">
            {group.map((tab) => {
              const active = tab.id === props.activeId;
              return (
                <div key={tab.id} className={`reader-tab-panel-row${active ? " is-active" : ""}`}>
                  <button type="button" role="menuitem" className="reader-tab-panel-text" aria-current={active || undefined}
                    onClick={() => {
                      props.onDone();
                      props.onSelect(tab.id);
                    }}>
                    <span className="reader-tab-panel-title">{tab.title}</span>
                    {(active || tab.detail) && (
                      <span className="reader-tab-panel-detail">
                        {active ? (tab.detail ? t("titlebar.tabs.reading", { detail: tab.detail }) : t("titlebar.tabs.readingNow")) : tab.detail}
                      </span>
                    )}
                  </button>
                  <button type="button" className="reader-tab-panel-close" aria-label={t("titlebar.tabs.close", { title: tab.title })}
                    title={t("titlebar.tabs.close", { title: tab.title })}
                    onClick={() => props.onClose(tab.id)}>
                    <CloseGlyph />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {props.tabs.length >= props.max && <div className="reader-tab-panel-foot">{t("titlebar.tabs.full", { max: props.max })}</div>}
    </div>
  );
}
