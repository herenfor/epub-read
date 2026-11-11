import { memo, useEffect, useRef, useState } from "react";
import { formatShelfTime, type ShelfEntry } from "../shelf";
import { shelfProgressLabel, shelfReadingStatus } from "../shelfProgressDisplay";
import { uiPlural, uiText, useUiText } from "../localization/UiLanguageProvider";
import { useShelfPress, shelfLongPressKind, type ShelfLongPress } from "../shelfPress";
import { isShelfCardActionTarget } from "../shelfCardEventScope";
import { getRuntimeCapabilities } from "../../platform/runtimeCapabilities";
import {
  descriptorForEntry,
  isAbortError,
  loadThumbnailAsset,
  thumbnailTaskQueue,
  type ThumbnailProvider,
} from "../thumbnail";
import { acquireCoverUrl, peekCoverUrl, storeCoverUrl, type HeldCoverUrl } from "../coverUrlCache";
import type { FolderSelectionState } from "../shelfFolderSelection";
import { CheckIcon, DotsVerticalIcon, FolderIcon, PlusIcon, StarIcon } from "./icons";
import {
  buttonMenuOpener,
  contextMenuOpener,
  type ShelfMenuOpener,
  type ShelfMenuTarget,
} from "./menuTarget";

/* =========================================================================
 * 莫兰迪算法调色板与封面组件（高性能按需加载 + 高雅莫兰迪算法装帧）
 * ========================================================================= */

const MORANDI_PALETTES = [
  { bg: "#4A5568", fg: "#F7FAFC", border: "rgba(247, 250, 252, 0.25)", accent: "rgba(247, 250, 252, 0.18)" }, // 灰青
  { bg: "#2D3748", fg: "#EDF2F7", border: "rgba(237, 242, 247, 0.25)", accent: "rgba(237, 242, 247, 0.18)" }, // 墨黛
  { bg: "#5C5248", fg: "#FDF6E2", border: "rgba(253, 246, 226, 0.25)", accent: "rgba(253, 246, 226, 0.18)" }, // 枯茶
  { bg: "#3D4F53", fg: "#E6F1F2", border: "rgba(230, 241, 242, 0.25)", accent: "rgba(230, 241, 242, 0.18)" }, // 苍绿
  { bg: "#5A4E5C", fg: "#F5EDF7", border: "rgba(245, 237, 247, 0.25)", accent: "rgba(245, 237, 247, 0.18)" }, // 暮紫
  { bg: "#4B5358", fg: "#EDF3F7", border: "rgba(237, 243, 247, 0.25)", accent: "rgba(237, 243, 247, 0.18)" }, // 暮蓝
  { bg: "#5A4944", fg: "#F9ECE8", border: "rgba(249, 236, 232, 0.25)", accent: "rgba(249, 236, 232, 0.18)" }, // 焦赭
  { bg: "#48524B", fg: "#EDF5EF", border: "rgba(237, 245, 239, 0.25)", accent: "rgba(237, 245, 239, 0.18)" }, // 艾绿
];

function getMorandiPalette(title: string, id: string) {
  let hash = 0;
  const str = id + title;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % MORANDI_PALETTES.length;
  const initial = title.trim().charAt(0) || uiText("shelf.cover.initialFallback");
  return { ...MORANDI_PALETTES[idx], initial };
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function coverCacheKey(entry: ShelfEntry): string {
  return `${entry.id}|${entry.contentHash}|${entry.thumbnailMime ?? ""}|${entry.coverMime ?? ""}`;
}

/** The cover thumbnail already loaded for a shelf entry, if the shelf has shown it (share cards). */
export function shareCoverUrl(entry: ShelfEntry | undefined): string | null {
  return entry ? peekCoverUrl(coverCacheKey(entry)) : null;
}

export const Cover = memo(function Cover({
  entry,
  provider,
}: {
  entry: ShelfEntry;
  provider: ThumbnailProvider;
}) {
  const cacheKey = coverCacheKey(entry);
  // A cover seen before shows on the first frame, so coming back from a book
  // does not flash the fallback.
  const [url, setUrl] = useState<string | null>(() => peekCoverUrl(cacheKey));
  const loadedFor = useRef<string>(url ? entry.id : "");
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(() => url !== null);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node || nearViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([item]) => {
        if (!item?.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { root: null, rootMargin: "100% 0px", threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- observes the first node once
  }, []);

  useEffect(() => {
    if (entry.available === false) return;
    const cached = acquireCoverUrl(cacheKey);
    if (cached) {
      loadedFor.current = entry.id;
      setUrl(cached.url);
      return cached.release;
    }
    if (!nearViewport) return;
    let held: HeldCoverUrl | null = null;
    const controller = new AbortController();
    loadedFor.current = entry.id;
    setUrl(null);
    void thumbnailTaskQueue
      .enqueue(
        (signal) => loadThumbnailAsset(provider, descriptorForEntry(entry), signal),
        controller.signal
      )
      .then((asset) => {
        if (controller.signal.aborted || !asset || asset.bytes.byteLength === 0) return;
        const nextUrl = URL.createObjectURL(
          new Blob([asset.bytes.slice().buffer as ArrayBuffer], {
            type: asset.mime || entry.coverMime || "image/jpeg",
          })
        );
        if (controller.signal.aborted) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        held = storeCoverUrl(cacheKey, nextUrl, asset.bytes.byteLength);
        setUrl(held.url);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          /* 封面读取失败按无封面处理 */
        }
      });
    return () => {
      controller.abort();
      held?.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheKey covers the cover fields
  }, [cacheKey, entry.id, entry.available, nearViewport, provider]);

  if (!url || loadedFor.current !== entry.id) {
    const palette = getMorandiPalette(entry.title, entry.id);
    return (
      <div
        ref={nodeRef}
        className="shelf-cover fallback morandi-cover"
        style={{ backgroundColor: palette.bg, color: palette.fg }}
        aria-hidden="true"
        data-ui-scale="fixed"
      >
        <div className="morandi-spine-shadow" />
        <div className="morandi-inner-frame" style={{ borderColor: palette.border }}>
          <span className="morandi-watermark fallback-mark" style={{ color: palette.accent }}>
            {palette.initial}
          </span>
          <span className="morandi-title fallback-title">{entry.title}</span>
          {entry.creator && <span className="morandi-creator">{entry.creator}</span>}
        </div>
      </div>
    );
  }
  return <img className="shelf-cover" src={url} alt={entry.title} loading="lazy" draggable={false} />;
});

export function formatRelativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return uiText("shelf.time.justNow");
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.floor(diff / (60 * 1000));
    return uiPlural("shelf.time.minutesAgo", minutes, { count: minutes });
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    return uiPlural("shelf.time.hoursAgo", hours, { count: hours });
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(ms);
  if (
    target.getDate() === yesterday.getDate() &&
    target.getMonth() === yesterday.getMonth() &&
    target.getFullYear() === yesterday.getFullYear()
  ) {
    return uiText("shelf.time.yesterday");
  }
  return formatShelfTime(ms);
}

/* =========================================================================
 * 书籍卡片组件（现代极简排版、内嵌进度条、触控安全区）
 * ========================================================================= */

interface ShelfCardProps {
  entry: ShelfEntry;
  /** Folder-dialog books have no selection mode; their long press drags them out. */
  surface: "book" | "folderModalBook";
  selected: boolean;
  selectionMode: boolean;
  provider: ThumbnailProvider;
  isFavorite?: boolean;
  isDragging?: boolean;
  isDropTargetBook?: boolean;
  draggedEntry?: ShelfEntry | null;
  menuOpen?: boolean;
  canSelect?: boolean;
  canDrag?: boolean;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
  onToggleFavorite?(entry: ShelfEntry): void;
  onRequestMenu?(target: ShelfMenuTarget, opener: ShelfMenuOpener): void;
  onLongPress?(entry: ShelfEntry, kind: ShelfLongPress, point: { x: number; y: number }): void;
}

export const ShelfCard = memo(function ShelfCard(props: ShelfCardProps) {
  const { t } = useUiText();
  const { entry } = props;
  const moreRef = useRef<HTMLButtonElement>(null);
  const morePressedWith = useRef("");

  const last = entry.lastReadAtMs > 0 ? entry.lastReadAtMs : entry.addedAtMs;
  const recent = Date.now() - last < 1000 * 60 * 60 * 24 * 7;
  // Badge and status line follow the same judgement as the status filters.
  const status = shelfReadingStatus(entry);

  const press = useShelfPress({
    longPressKind: (pointerType) => shelfLongPressKind(props.surface, pointerType, props.selectionMode, {
      select: props.canSelect, drag: props.canDrag,
    }),
    onLongPress: (kind, point) => props.onLongPress?.(entry, kind, point),
  });

  const activate = (): void => {
    if (props.selectionMode) props.onToggleSelected(entry.id);
    else props.onOpen(entry.id);
  };

  const requestMenu = (opener: ShelfMenuOpener): void => {
    if (props.selectionMode) return;
    props.onRequestMenu?.({ kind: "book", id: entry.id, surface: props.surface === "folderModalBook" ? "folderModal" : "grid" }, opener);
  };

  return (
    <div
      className={`shelf-card${props.selected ? " selected" : ""}${entry.available === false ? " unavailable" : ""}${props.isDragging ? " is-dragging" : ""}${props.isDropTargetBook ? " drag-over-book" : ""}${props.menuOpen ? " menu-open" : ""}`}
      role="button"
      tabIndex={0}
      data-shelf-target="book"
      data-book-id={entry.id}
      {...press.handlers}
      onClick={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (press.swallowClick(e)) return;
        activate();
      }}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        if (press.swallowTouchContextMenu(e)) return;
        e.preventDefault();
        // 多选状态的长按留给拖动，不弹系统/卡片菜单。
        requestMenu(contextMenuOpener(e, moreRef.current ?? e.currentTarget));
      }}
      onKeyDown={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      title={`${entry.title}${entry.creator ? ` · ${entry.creator}` : ""}`}
    >
      <div className="shelf-cover-box">
        <Cover entry={entry} provider={props.provider} />

        {/* 模拟创建文件夹的交互预览态 */}
        {props.isDropTargetBook && (
          <div className="shelf-card-folder-sim-overlay" aria-hidden="true">
            <div className="shelf-folder-sim-pill">
              <FolderIcon />
              <span>{t("shelf.card.dropToCreateFolder")}</span>
            </div>
            <div className="shelf-folder-sim-mosaic">
              <div className="shelf-folder-sim-thumb primary">
                <Cover entry={entry} provider={props.provider} />
              </div>
              {props.draggedEntry && (
                <div className="shelf-folder-sim-thumb incoming">
                  <Cover entry={props.draggedEntry} provider={props.provider} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* 单卡片星标按钮 */}
        {!props.selectionMode && props.onToggleFavorite && (
          <button
            className={`shelf-card-star-btn${props.isFavorite ? " active" : ""}`}
            type="button"
            title={props.isFavorite ? t("shelf.card.unfavorite") : t("shelf.card.favorite")}
            aria-label={props.isFavorite ? t("shelf.card.unfavoriteBook", { title: entry.title }) : t("shelf.card.favoriteBook", { title: entry.title })}
            aria-pressed={props.isFavorite}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleFavorite?.(entry);
            }}
          >
            <StarIcon filled={props.isFavorite} />
          </button>
        )}

        {/* 多选模式勾选框 */}
        {props.selectionMode && (
          <div className={`shelf-card-checkbox${props.selected ? " checked" : ""}`} aria-hidden="true">
            {props.selected && <CheckIcon />}
          </div>
        )}

        {/* 状态徽标（极简胶囊，不破坏封面比例） */}
        <div className="shelf-card-badges" aria-hidden="true">
          {entry.available === false ? (
            <span className="shelf-badge missing">{getRuntimeCapabilities().platform === "android" ? t("shelf.card.reimport") : t("shelf.card.sourceMissing")}</span>
          ) : (
            <>
              {entry.isNew && !props.selectionMode && <span className="shelf-badge new">{t("shelf.card.new")}</span>}
              {recent && status === "reading" && !entry.isNew && !props.selectionMode && (
                <span className="shelf-badge reading">{t("shelf.card.reading")}</span>
              )}
            </>
          )}
        </div>

        {/* 贴合封面底边的纤细微光进度条 */}
        {entry.progressPct > 0 && (
          <div className="shelf-card-progress-bar" title={t("shelf.card.progress", { percent: entry.progressPct })}>
            <div
              className="shelf-card-progress-fill"
              style={{ width: `${Math.min(100, entry.progressPct)}%` }}
            />
          </div>
        )}

        {/* 三点按钮只请求书架唯一的操作菜单；按钮自身的按压不进入卡片手势。 */}
        {!props.selectionMode && props.onRequestMenu && (
          <div className="shelf-card-actions-wrap">
            <button
              ref={moreRef}
              className={`shelf-card-more-btn${props.menuOpen ? " active" : ""}`}
              type="button"
              title={t("shelf.card.more.tip")}
              aria-label={t("shelf.card.more", { title: entry.title })}
              aria-haspopup="menu"
              aria-expanded={props.menuOpen === true}
              onPointerDown={(e) => { morePressedWith.current = e.pointerType; }}
              onClick={(e) => {
                e.stopPropagation();
                requestMenu(buttonMenuOpener(e, morePressedWith.current));
              }}
            >
              <DotsVerticalIcon />
            </button>
          </div>
        )}
      </div>

      {/* 底部标题与元数据 */}
      <div className="shelf-card-info">
        <div className="shelf-card-title">{entry.title}</div>
        <div className="shelf-card-meta">
          <span className="shelf-card-creator" title={entry.creator || t("shelf.unknownAuthor")}>
            {entry.creator || t("shelf.unknownAuthor")}
          </span>
          <span className="shelf-card-subline">
            {status !== "unread" ? (
              <span className="shelf-read-stat">{shelfProgressLabel(entry, t("shelf.card.readSuffix"))}</span>
            ) : (
              <span className="shelf-read-stat unread">{t("shelf.card.unread")}</span>
            )}
            <span className="shelf-dot" aria-hidden="true">·</span>
            <span className="shelf-time">{formatShelfTime(last) || t("shelf.time.justNow")}</span>
          </span>
        </div>
      </div>
    </div>
  );
});

/* =========================================================================
 * 文件夹卡片组件（叠层外形 + 固定四格封面、弹层菜单、触控安全区）
 * ========================================================================= */

interface ShelfFolderCardProps {
  id: string;
  name: string;
  books: ShelfEntry[];
  /** Effective direct child folders; 0 keeps the flat "N books" line. */
  childCount?: number;
  provider: ThumbnailProvider;
  selectionMode: boolean;
  /** Batch selection: derived from the selected books (see shelfFolderSelection). */
  selectionState?: FolderSelectionState;
  onToggleSelected?(id: string): void;
  isDropTarget?: boolean;
  menuOpen?: boolean;
  onOpen(id: string, element?: HTMLElement | null): void;
  onRequestMenu?(target: ShelfMenuTarget, opener: ShelfMenuOpener): void;
}

const FOLDER_MOSAIC_SLOTS = [0, 1, 2, 3] as const;

export const ShelfFolderCard = memo(function ShelfFolderCard(props: ShelfFolderCardProps) {
  const { t, tn } = useUiText();
  const cardRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const morePressedWith = useRef("");

  const requestMenu = (opener: ShelfMenuOpener): void => {
    if (props.selectionMode) return;
    props.onRequestMenu?.({ kind: "folder", id: props.id }, opener);
  };

  // 触屏长按文件夹直接给出操作面板（原先依赖系统 contextmenu，会和点击抢同一手势）。
  const press = useShelfPress({
    longPressKind: (pointerType) => shelfLongPressKind("folder", pointerType, props.selectionMode, { menu: Boolean(props.onRequestMenu) }),
    onLongPress: (kind) => {
      if (kind === "menu") requestMenu({ trigger: moreRef.current ?? cardRef.current, pointerType: "touch", keyboard: false, toggle: false });
    },
  });

  const selectable = props.selectionState !== undefined && props.selectionState !== "empty";
  const handleCardClick = (): void => {
    if (!props.selectionMode) props.onOpen(props.id, cardRef.current);
    else if (selectable) props.onToggleSelected?.(props.id);
  };

  const sampleBooks = props.books.slice(0, FOLDER_MOSAIC_SLOTS.length);
  const checked = props.selectionState === "all";
  const mixed = props.selectionState === "mixed";

  return (
    <div
      ref={cardRef}
      className={`shelf-card shelf-folder-card${props.isDropTarget ? " is-drop-target" : ""}${props.menuOpen ? " menu-open" : ""}${props.selectionMode && checked ? " selected" : ""}`}
      role={props.selectionMode ? "checkbox" : "button"}
      aria-checked={props.selectionMode ? (mixed ? "mixed" : checked) : undefined}
      aria-disabled={props.selectionMode && !selectable ? true : undefined}
      aria-label={props.selectionMode ? t("shelfFolder.select", { name: props.name }) : undefined}
      tabIndex={0}
      data-shelf-target="folder"
      data-folder-id={props.id}
      {...press.handlers}
      onClick={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (press.swallowClick(e)) return;
        handleCardClick();
      }}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        if (press.swallowTouchContextMenu(e)) return;
        e.preventDefault();
        requestMenu(contextMenuOpener(e, moreRef.current ?? e.currentTarget));
      }}
      onKeyDown={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      title={props.selectionMode && !selectable
        ? t("shelfFolder.select.empty")
        : tn("shelfFolder.card.tip", props.books.length, { name: props.name, count: props.books.length })}
    >
      <div className="shelf-cover-box shelf-folder-cover-box">
        {props.selectionMode && (
          <div className={`shelf-card-checkbox${checked ? " checked" : ""}${mixed ? " mixed" : ""}${selectable ? "" : " disabled"}`} aria-hidden="true">
            {checked && <CheckIcon />}
            {mixed && <span className="shelf-card-checkbox-dash" />}
          </div>
        )}
        {props.isDropTarget && (
          <div className="shelf-folder-drop-overlay" aria-hidden="true">
            <div className="shelf-folder-drop-badge">
              <PlusIcon />
              <span>{t("shelfFolder.card.drop")}</span>
            </div>
          </div>
        )}
        {/* 叠层外形：上沿露出两层纸边，封面固定四格；样子不随里面有几本变化。 */}
        <span className="shelf-folder-sheet shelf-folder-sheet-back" aria-hidden="true" />
        <span className="shelf-folder-sheet" aria-hidden="true" />
        <div className="shelf-folder-face">
          <div className="shelf-folder-mosaic">
            {FOLDER_MOSAIC_SLOTS.map((slot) => {
              const book = sampleBooks[slot];
              return (
                <div key={book?.id ?? `empty-${slot}`} className={`shelf-folder-mosaic-cell${book ? "" : " is-empty"}`}>
                  {book && <Cover entry={book} provider={props.provider} />}
                </div>
              );
            })}
          </div>
        </div>

        {!props.selectionMode && props.onRequestMenu && (
          <div className="shelf-card-actions-wrap">
            <button
              ref={moreRef}
              className={`shelf-card-more-btn${props.menuOpen ? " active" : ""}`}
              type="button"
              title={t("shelfFolder.options.tip")}
              aria-label={t("shelfFolder.options", { name: props.name })}
              aria-haspopup="menu"
              aria-expanded={props.menuOpen === true}
              onPointerDown={(e) => { morePressedWith.current = e.pointerType; }}
              onClick={(e) => {
                e.stopPropagation();
                requestMenu(buttonMenuOpener(e, morePressedWith.current));
              }}
            >
              <DotsVerticalIcon />
            </button>
          </div>
        )}
      </div>

      <div className="shelf-card-info">
        <div className="shelf-card-title"><FolderIcon />{props.name}</div>
        <div className="shelf-card-meta">
          {/* 和书卡片一样两行：第一行本数，第二行子文件夹数；没有子文件夹也留着这一行，保证整行等高。 */}
          <span className="shelf-card-creator">
            {tn("shelfFolder.bookCount", props.books.length, { count: props.books.length })}
          </span>
          <span className="shelf-card-subline">
            {(props.childCount ?? 0) > 0
              ? tn("shelfFolder.card.subfolders", props.childCount ?? 0, { count: props.childCount ?? 0 })
              : "\u00a0"}
          </span>
        </div>
      </div>
    </div>
  );
});
