import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FolderNameField } from "../FolderNameField";
import { validateFolderNameDraft, folderNameDraftError } from "../folderNameDraft";
import { MENU_CLOSE_MS } from "../menuMotion";
import { useUiText } from "../localization/UiLanguageProvider";
import type { ShelfEntry, ShelfSort } from "../shelf";
import { isFavorite, type LibraryOrganization } from "../libraryOrganization";
import type { ThumbnailProvider } from "../thumbnail";
import type { ShelfLongPress } from "../shelfPress";
import {
  CheckListIcon,
  CloseIcon,
  DotsVerticalIcon,
  EditIcon,
  ExportIcon,
  FolderIcon,
  PlusIcon,
  TrashIcon,
} from "./icons";
import { ShelfCard } from "./cards";
import { ShelfSelect } from "./chrome";
import { buttonMenuOpener, type ShelfMenuOpener, type ShelfMenuTarget } from "./menuTarget";
import type { ShelfSubmenuBackProps } from "./submenuBack";

/* =========================================================================
 * 文件夹管理弹窗（新建、重命名、解散、移动选择器）
 * ========================================================================= */

interface ShelfCreateFolderDialogProps {
  existingNames: string[];
  busy: boolean;
  subtitle?: string;
  onCancel(): void;
  onCreate(name: string): Promise<void>;
}

export function ShelfCreateFolderDialog(props: ShelfCreateFolderDialogProps) {
  const { t } = useUiText();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const draft = validateFolderNameDraft(name, props.existingNames);
    if (!draft.ok) {
      setError(folderNameDraftError(draft.code));
      return;
    }
    try {
      await props.onCreate(draft.name);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="shelf-confirm-title">{t("shelfFolder.create.title")}</div>
          {props.subtitle && (
            <div style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0 10px" }}>
              {props.subtitle}
            </div>
          )}
          <div style={{ margin: "14px 0" }}>
            <FolderNameField
              inputRef={inputRef}
              value={name}
              disabled={props.busy}
              placeholder={t("shelfFolder.name.placeholder")}
              error={error}
              onChange={(value) => {
                setName(value);
                setError(null);
              }}
            />
          </div>
          <div className="shelf-confirm-actions">
            <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
              {t("shelfFolder.cancel")}
            </button>
            <button className="shelf-confirm-primary" type="submit" disabled={props.busy}>
              {props.busy ? t("shelfFolder.creating") : t("shelfFolder.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ShelfRenameDialogProps {
  folderId: string;
  currentName: string;
  existingNames: string[];
  busy: boolean;
  onCancel(): void;
  onRename(folderId: string, newName: string): Promise<void>;
}

export function ShelfRenameDialog(props: ShelfRenameDialogProps) {
  const { t } = useUiText();
  const [name, setName] = useState(props.currentName);
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const draft = validateFolderNameDraft(name, props.existingNames, props.currentName);
    if (!draft.ok) {
      setError(folderNameDraftError(draft.code));
      return;
    }
    if (draft.unchanged) {
      handleCancel();
      return;
    }
    try {
      await props.onRename(props.folderId, draft.name);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="shelf-confirm-title">{t("shelfFolder.rename.title")}</div>
          <div style={{ margin: "14px 0" }}>
            <FolderNameField
              inputRef={inputRef}
              value={name}
              disabled={props.busy}
              placeholder={t("shelfFolder.name.placeholder")}
              error={error}
              onChange={(value) => {
                setName(value);
                setError(null);
              }}
            />
          </div>
          <div className="shelf-confirm-actions">
            <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
              {t("shelfFolder.cancel")}
            </button>
            <button className="shelf-confirm-primary" type="submit" disabled={props.busy}>
              {props.busy ? t("shelfFolder.saving") : t("shelfFolder.confirm")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ShelfDissolveDialogProps {
  folderId: string;
  folderName: string;
  busy: boolean;
  onCancel(): void;
  onDissolve(folderId: string): Promise<void>;
}

export function ShelfDissolveDialog(props: ShelfDissolveDialogProps) {
  const { t } = useUiText();
  const [isClosing, setIsClosing] = useState(false);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="shelf-confirm-title">{t("shelfFolder.dissolve.title", { name: props.folderName })}</div>
        <div className="shelf-confirm-hint">{t("shelfFolder.dissolve.hint")}</div>
        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
            {t("shelfFolder.cancel")}
          </button>
          <button
            className="shelf-selection-delete"
            type="button"
            disabled={props.busy}
            onClick={() => void props.onDissolve(props.folderId)}
          >
            {props.busy ? t("shelfFolder.dissolving") : t("shelfFolder.dissolve")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ShelfMoveDialogProps {
  targets: ShelfEntry[];
  currentFolderId: string | null;
  folders: Array<{ id: string; name: string; count: number }>;
  busy: boolean;
  onCancel(): void;
  onMove(targetFolderId: string | null): Promise<void>;
  onCreateFolder(name: string): Promise<string>;
}

export function ShelfMoveDialog(props: ShelfMoveDialogProps) {
  const { t, tn } = useUiText();
  const [isClosing, setIsClosing] = useState(false);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  const initialFolderId = useMemo(() => {
    if (props.currentFolderId === null) {
      return props.folders.length > 0 ? props.folders[0].id : null;
    } else {
      return null;
    }
  }, [props.currentFolderId, props.folders]);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(initialFolderId);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleCreateInline = async (): Promise<void> => {
    const draft = validateFolderNameDraft(newName, props.folders.map((folder) => folder.name));
    if (!draft.ok) {
      setError(folderNameDraftError(draft.code));
      return;
    }
    try {
      const createdId = await props.onCreateFolder(draft.name);
      setSelectedFolderId(createdId);
      setCreating(false);
      setNewName("");
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleConfirmMove = async (): Promise<void> => {
    try {
      await props.onMove(selectedFolderId);
    } catch (err) {
      setError(String(err));
    }
  };

  const targetTitle =
    props.targets.length === 1
      ? t("shelfFolder.move.oneBook", { title: props.targets[0].title })
      : tn("shelfFolder.move.books", props.targets.length, { count: props.targets.length });

  const isRootCurrent = props.currentFolderId === null;
  const isSelectedSame = selectedFolderId === props.currentFolderId;

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm shelf-move-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="shelf-confirm-title">{t("shelfFolder.move.title", { target: targetTitle })}</div>
        <div className="shelf-move-list" role="radiogroup">
          <label
            className={`shelf-move-item${selectedFolderId === null ? " selected" : ""}${isRootCurrent ? " disabled is-current" : ""}`}
            title={isRootCurrent ? t("shelfFolder.move.current") : undefined}
          >
            <input
              type="radio"
              name="shelf-move-target"
              disabled={isRootCurrent}
              checked={selectedFolderId === null && !isRootCurrent}
              onChange={() => {
                if (!isRootCurrent) setSelectedFolderId(null);
              }}
            />
            <span className="shelf-move-item-name">{t("shelfFolder.move.root")}</span>
            {isRootCurrent && <span className="shelf-move-current-badge">{t("shelfFolder.move.currentBadge")}</span>}
          </label>
          {props.folders.map((f) => {
            const isFolderCurrent = props.currentFolderId === f.id;
            return (
              <label
                key={f.id}
                className={`shelf-move-item${selectedFolderId === f.id ? " selected" : ""}${isFolderCurrent ? " disabled is-current" : ""}`}
                title={isFolderCurrent ? t("shelfFolder.move.current") : undefined}
              >
                <input
                  type="radio"
                  name="shelf-move-target"
                  disabled={isFolderCurrent}
                  checked={selectedFolderId === f.id && !isFolderCurrent}
                  onChange={() => {
                    if (!isFolderCurrent) setSelectedFolderId(f.id);
                  }}
                />
                <span className="shelf-move-item-icon"><FolderIcon /></span>
                <span className="shelf-move-item-name" title={f.name}>{f.name}</span>
                <span className="shelf-move-item-count">{tn("shelfFolder.move.count", f.count, { count: f.count })}</span>
                {isFolderCurrent && <span className="shelf-move-current-badge">{t("shelfFolder.move.currentBadge")}</span>}
              </label>
            );
          })}
        </div>

        {creating ? (
          <div className="shelf-move-create-box">
            <FolderNameField
              value={newName}
              disabled={props.busy}
              placeholder={t("shelfFolder.move.newPlaceholder")}
              error={error}
              onChange={(value) => {
                setNewName(value);
                setError(null);
              }}
            />
            <div className="shelf-move-create-actions">
              <button
                className="shelf-selection-cancel"
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setError(null);
                }}
              >
                {t("shelfFolder.cancel")}
              </button>
              <button
                className="shelf-confirm-primary"
                type="button"
                disabled={props.busy}
                onClick={() => void handleCreateInline()}
              >
                {t("shelfFolder.move.createAndSelect")}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="shelf-move-new-btn"
            type="button"
            onClick={() => setCreating(true)}
            disabled={props.busy}
          >
            <PlusIcon />
            <span>{t("shelfFolder.move.new")}</span>
          </button>
        )}

        {error && !creating && <div className="shelf-dialog-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
            {t("shelfFolder.cancel")}
          </button>
          <button
            className="shelf-confirm-primary"
            type="button"
            disabled={props.busy || isSelectedSame || (selectedFolderId === null && isRootCurrent)}
            onClick={() => void handleConfirmMove()}
          >
            {props.busy ? t("shelfFolder.moving") : t("shelfFolder.move.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
 * 手机拟物居中文件夹弹窗组件（Folder Modal）
 * ========================================================================= */

interface ShelfFolderModalProps extends ShelfSubmenuBackProps {
  folder: { id: string; name: string };
  /** Already in the folder sort order. */
  books: ShelfEntry[];
  sort: ShelfSort;
  sortDisabled?: boolean;
  onSortChange(sort: ShelfSort): void;
  provider: ThumbnailProvider;
  originRect?: DOMRect;
  closing: boolean;
  draggedEntry: ShelfEntry | null;
  organization: LibraryOrganization;
  /** Book whose action menu is open, for the trigger's expanded state. */
  menuBookId: string | null;
  /** The folder's own action menu (phone header) is open. */
  folderMenuOpen: boolean;
  onClose(): void;
  onOpenBook(id: string): void;
  onRename(folderId: string, currentName: string): void;
  onDissolve(folderId: string, folderName: string): void;
  onExportBooks?(): void;
  exportDisabled: boolean;
  /** Import new EPUBs into this folder; absent hides it. */
  onImportBooks?(): void;
  /** Pick books already in the library; absent hides it. */
  onAddBooks?(): void;
  addDisabled: boolean;
  onToggleFavorite(entry: ShelfEntry): void;
  onRequestMenu(target: ShelfMenuTarget, opener: ShelfMenuOpener): void;
  onLongPress(entry: ShelfEntry, kind: ShelfLongPress, point: { x: number; y: number }): void;
  compact?: boolean;
  modalRef: React.RefObject<HTMLDivElement>;
}

const noopToggle = (): void => {};

export const ShelfFolderModal = memo(function ShelfFolderModal(props: ShelfFolderModalProps) {
  const { t, tn } = useUiText();
  const { folder, books, closing, modalRef } = props;
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const morePressedWith = useRef("");

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      // An action menu above the dialog consumes its own Escape first.
      if (e.key === "Escape" && !e.defaultPrevented) {
        closeRef.current();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <div
      className={`shelf-folder-modal-backdrop${closing ? " closing" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div
        className="shelf-folder-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("shelfFolder.modal", { name: folder.name })}
      >
        <div className="shelf-folder-modal-head">
          <div className="shelf-folder-modal-title-box">
            <FolderIcon />
            <span className="shelf-folder-modal-title" title={folder.name}>{folder.name}</span>
            <span className="shelf-folder-modal-count">{tn("shelfFolder.modal.count", books.length, { count: books.length })}</span>
          </div>
          <div className="shelf-folder-modal-sort">
            <ShelfSelect
              registerSubmenuBackHandler={props.registerSubmenuBackHandler}
              onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
              value={props.sort}
              busy={props.sortDisabled}
              title={t("shelfFolder.modal.sort")}
              options={[
                { value: "recent", label: t("shelfMain.sort.recent") },
                { value: "added", label: t("shelfMain.sort.added") },
                { value: "title", label: t("shelfMain.sort.title") },
                { value: "progress", label: t("shelfMain.sort.progress") },
              ]}
              onChange={(val) => props.onSortChange(val as ShelfSort)}
            />
          </div>
          <div className="shelf-folder-modal-actions">
            {/* 手机标题与动作同一行：导出/重命名/解散收进与文件夹卡片相同的操作面板。 */}
            {props.compact && (
              <button
                className="shelf-folder-modal-action-btn"
                type="button"
                title={t("shelfFolder.options.tip")}
                aria-label={t("shelfFolder.options", { name: folder.name })}
                aria-haspopup="menu"
                aria-expanded={props.folderMenuOpen}
                onPointerDown={(e) => { morePressedWith.current = e.pointerType; }}
                onClick={(e) => props.onRequestMenu(
                  { kind: "folder", id: folder.id, surface: "folderModal" },
                  buttonMenuOpener(e, morePressedWith.current),
                )}
              >
                <DotsVerticalIcon />
              </button>
            )}
            {!props.compact && props.onExportBooks && (
              <button
                className="shelf-folder-modal-action-btn"
                type="button"
                title={t("bookExport.action")}
                aria-label={t("bookExport.action")}
                disabled={props.exportDisabled || books.length === 0}
                onClick={props.onExportBooks}
              >
                <ExportIcon />
              </button>
            )}
            {!props.compact && (
              <>
                <button
                  className="shelf-folder-modal-action-btn"
                  type="button"
                  title={t("shelfFolder.modal.rename")}
                  aria-label={t("shelfFolder.modal.rename")}
                  onClick={() => props.onRename(folder.id, folder.name)}
                >
                  <EditIcon />
                </button>
                <button
                  className="shelf-folder-modal-action-btn danger"
                  type="button"
                  title={t("shelfFolder.dissolve")}
                  aria-label={t("shelfFolder.dissolve")}
                  onClick={() => props.onDissolve(folder.id, folder.name)}
                >
                  <TrashIcon />
                </button>
              </>
            )}
            <button
              className="shelf-folder-modal-action-btn"
              type="button"
              title={t("shelfFolder.modal.close.tip")}
              aria-label={t("shelfFolder.modal.close")}
              onClick={props.onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="shelf-folder-modal-body">
          {books.length === 0 ? (
            <div className="shelf-folder-modal-empty">
              {props.compact
                ? t("shelfFolder.modal.empty.touch")
                : t("shelfFolder.modal.empty.pointer")}
            </div>
          ) : (
            // 与书架共用 .shelf-grid：列数随排布密度，触屏卡片按钮也走同一套样式。
            <div className="shelf-grid shelf-folder-modal-grid">
              {books.map((entry) => (
                <ShelfCard
                  key={entry.id}
                  entry={entry}
                  surface="folderModalBook"
                  selected={false}
                  selectionMode={false}
                  provider={props.provider}
                  isFavorite={isFavorite(props.organization, entry.contentHash ?? entry.id)}
                  isDragging={props.draggedEntry?.id === entry.id}
                  isDropTargetBook={false}
                  draggedEntry={props.draggedEntry}
                  menuOpen={props.menuBookId === entry.id}
                  canDrag
                  onOpen={props.onOpenBook}
                  onToggleSelected={noopToggle}
                  onToggleFavorite={props.onToggleFavorite}
                  onRequestMenu={props.onRequestMenu}
                  onLongPress={props.onLongPress}
                />
              ))}
            </div>
          )}
        </div>
        {(props.onImportBooks || props.onAddBooks) && (
          <div className="shelf-folder-modal-foot">
            {props.onImportBooks && (
              <button
                className="shelf-folder-modal-foot-btn"
                type="button"
                disabled={props.addDisabled}
                title={t("shelfFolder.importHere.tip")}
                onClick={props.onImportBooks}
              >
                <PlusIcon />
                <span>{t("shelfFolder.importHere")}</span>
              </button>
            )}
            {props.onAddBooks && (
              <button
                className="shelf-folder-modal-foot-btn"
                type="button"
                disabled={props.addDisabled}
                title={t("shelfFolder.addBooks.open.tip")}
                onClick={props.onAddBooks}
              >
                <CheckListIcon />
                <span>{t("shelfFolder.addBooks.open")}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
