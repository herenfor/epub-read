import { useMemo, useState } from "react";
import { MENU_CLOSE_MS } from "./menuMotion";
import { effectiveFolderId, type LibraryOrganization } from "./libraryOrganization";
import type { ShelfEntry } from "./shelf";
import { useUiText } from "./localization/UiLanguageProvider";

/** Rows rendered before "show more": keeps a large library's first paint cheap. */
const INITIAL_ROWS = 120;

export interface AddBooksCandidate {
  readonly entry: ShelfEntry;
  /** Name of the folder that holds the book now; null = unclassified. */
  readonly folderName: string | null;
}

/**
 * Books the folder does not hold yet: unclassified first, then those filed
 * elsewhere, each group in the shelf's own order.
 */
export function addBooksCandidates(
  entries: readonly ShelfEntry[],
  organization: LibraryOrganization,
  folderId: string,
): AddBooksCandidate[] {
  const loose: AddBooksCandidate[] = [];
  const elsewhere: AddBooksCandidate[] = [];
  for (const entry of entries) {
    const current = effectiveFolderId(organization, entry.contentHash ?? entry.id);
    if (current === folderId) continue;
    if (current === null) loose.push({ entry, folderName: null });
    else elsewhere.push({ entry, folderName: organization.folders[current]?.name.value ?? null });
  }
  return [...loose, ...elsewhere];
}

export function matchesAddBooksQuery(candidate: AddBooksCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { entry } = candidate;
  return [entry.title, entry.creator, entry.fileName].some((text) => text?.toLowerCase().includes(q));
}

export interface ShelfFolderAddBooksDialogProps {
  folder: { id: string; name: string };
  entries: readonly ShelfEntry[];
  organization: LibraryOrganization;
  busy: boolean;
  onCancel(): void;
  /** Moves the chosen shelf entries (by id) into the folder. */
  onAdd(entryIds: string[]): Promise<void>;
}

export function ShelfFolderAddBooksDialog(props: ShelfFolderAddBooksDialogProps) {
  const { t, tn } = useUiText();
  const [isClosing, setIsClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleRows, setVisibleRows] = useState(INITIAL_ROWS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(
    () => addBooksCandidates(props.entries, props.organization, props.folder.id),
    [props.entries, props.organization, props.folder.id],
  );
  const filtered = useMemo(
    () => candidates.filter((candidate) => matchesAddBooksQuery(candidate, query)),
    [candidates, query],
  );
  // A book that left the candidate list (moved meanwhile, deleted) stops counting.
  const chosen = useMemo(
    () => candidates.filter((candidate) => selected.has(candidate.entry.id)).map((candidate) => candidate.entry.id),
    [candidates, selected],
  );
  const chosenElsewhere = useMemo(
    () => candidates.some((candidate) => candidate.folderName !== null && selected.has(candidate.entry.id)),
    [candidates, selected],
  );
  const allFilteredChosen = filtered.length > 0 && filtered.every((candidate) => selected.has(candidate.entry.id));

  const handleCancel = () => {
    if (saving) return;
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const candidate of filtered) {
        if (allFilteredChosen) next.delete(candidate.entry.id);
        else next.add(candidate.entry.id);
      }
      return next;
    });
  };

  const confirm = async () => {
    if (chosen.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await props.onAdd(chosen);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div
        className="shelf-confirm shelf-add-books-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("shelfFolder.addBooks.title", { name: props.folder.name })}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            handleCancel();
          }
        }}
      >
        <div className="shelf-confirm-title">{t("shelfFolder.addBooks.title", { name: props.folder.name })}</div>
        {candidates.length === 0 ? (
          <p className="shelf-add-books-empty">{t("shelfFolder.addBooks.none")}</p>
        ) : (
          <>
            <div className="shelf-add-books-tools">
              <input
                className="shelf-add-books-search"
                type="search"
                value={query}
                placeholder={t("shelfFolder.addBooks.search")}
                aria-label={t("shelfFolder.addBooks.search")}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setVisibleRows(INITIAL_ROWS);
                }}
              />
              <button
                className="shelf-add-books-all"
                type="button"
                disabled={filtered.length === 0}
                onClick={toggleAllFiltered}
              >
                {allFilteredChosen ? t("shelfFolder.addBooks.clearAll") : t("shelfFolder.addBooks.selectAll")}
              </button>
            </div>
            <div className="shelf-add-books-list" role="group" aria-label={t("shelfFolder.addBooks.title", { name: props.folder.name })}>
              {filtered.length === 0 && <p className="shelf-add-books-empty">{t("shelfFolder.addBooks.noMatch")}</p>}
              {filtered.slice(0, visibleRows).map(({ entry, folderName }) => (
                <label key={entry.id} className={`shelf-add-books-item${selected.has(entry.id) ? " selected" : ""}`}>
                  <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} />
                  <span className="shelf-add-books-text">
                    <span className="shelf-add-books-name" title={entry.title}>{entry.title || entry.fileName}</span>
                    {entry.creator && <span className="shelf-add-books-author">{entry.creator}</span>}
                  </span>
                  {folderName !== null && (
                    <span className="shelf-add-books-folder" title={t("shelfFolder.addBooks.inFolder", { name: folderName })}>
                      {folderName}
                    </span>
                  )}
                </label>
              ))}
              {filtered.length > visibleRows && (
                <button className="shelf-add-books-more" type="button" onClick={() => setVisibleRows((rows) => rows + INITIAL_ROWS)}>
                  {tn("shelfFolder.addBooks.more", filtered.length - visibleRows, { count: filtered.length - visibleRows })}
                </button>
              )}
            </div>
            {chosenElsewhere && (
              <p className="shelf-add-books-note">{t("shelfFolder.addBooks.moveNote")}</p>
            )}
          </>
        )}
        {error && <div className="shelf-dialog-error" role="alert">{error}</div>}
        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={saving}>
            {t("shelfFolder.cancel")}
          </button>
          <button
            className="shelf-confirm-primary"
            type="button"
            disabled={props.busy || saving || chosen.length === 0}
            onClick={() => void confirm()}
          >
            {saving
              ? t("shelfFolder.moving")
              : tn("shelfFolder.addBooks.confirm", chosen.length, { count: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
