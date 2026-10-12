import { useEffect, useRef } from "react";
import { useExitPresence } from "./menuMotion";
import { useUiText } from "./localization/UiLanguageProvider";
import { getSearchStatusLabel, SearchIndexCard, SearchResultList } from "./SearchPanel";
import type { ShelfBodySearchProps } from "./ShelfView";
import "./shelfSettings.css";

/** Index state, status line and results of the library-wide body search (shared by both presentations). */
function BodySearchResults(props: { body: ShelfBodySearchProps; onManageIndex?(): void }) {
  const { t } = useUiText();
  const body = props.body;
  const status = body.statusMessage ?? getSearchStatusLabel(body.status, body.processed, body.total);
  const hasQuery = Boolean(body.query.trim());
  return <>
    {/* Concurrency tuning stays in Settings › Storage; here only what is needed to search. */}
    {body.indexStatus && <SearchIndexCard props={{ ...body, onConcurrencyChange: undefined, onClose: () => undefined}} />}
    <div className="shelf-body-search-status" aria-live="polite">
      <span>{status}</span>
      {body.status === "searching" && body.onCancel && <button type="button" onClick={body.onCancel}>{t("search.cancel")}</button>}
      {props.onManageIndex && <button type="button" onClick={props.onManageIndex}>{t("shelfSettings.search.manageIndex")}</button>}
    </div>
    {body.status === "error" && body.errorMessage && <div className="search-error">{t("search.errorDetail", { message: body.errorMessage })}</div>}
    {!hasQuery && body.status !== "searching" && <div className="search-empty">{t("search.hint.all")}</div>}
    {body.status === "complete" && hasQuery && body.results.length === 0 && <div className="search-empty">{t("search.empty")}</div>}
    {body.navigationBusy && <div className="search-navigation-busy">{t("search.locating")}</div>}
    <SearchResultList results={body.results} navigationBusy={body.navigationBusy} onSelect={body.onSelect} />
    {body.truncated && body.results.length <= 100 && <div className="search-truncated">{t("search.truncated", { limit: 100 })}</div>}
  </>;
}

/** Desktop: results open under the shelf search box while it searches book text. */
export function ShelfBodySearchDropdown(props: {
  open: boolean;
  body: ShelfBodySearchProps;
  /** The search box: clicks inside it never close the dropdown. */
  anchor: HTMLElement | null;
  onClose(): void;
  onManageIndex?(): void;
}) {
  const { t } = useUiText();
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (ref.current?.contains(target) || props.anchor?.contains(target))) return;
      props.onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [props.open, props.onClose, props.anchor]);
  if (!props.open) return null;
  return <section ref={ref} className="shelf-body-search-dropdown" aria-label={t("shelfSettings.search.results")}>
    <BodySearchResults body={props.body} onManageIndex={props.onManageIndex} />
  </section>;
}

/** Phone: a full-screen search page; back (header or Android) leaves it. */
export function ShelfBodySearchPage(props: {
  open: boolean;
  body: ShelfBodySearchProps;
  busy?: boolean;
  onClose(): void;
  onManageIndex?(): void;
}) {
  const { t } = useUiText();
  const { present, closing } = useExitPresence(props.open);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (props.open) inputRef.current?.focus();
  }, [props.open]);
  if (!present) return null;
  const body = props.body;
  const indexBusy = body.indexStatus === "checking" || body.indexStatus === "indexing" || body.indexStatus === "cancelling";
  return <section className={`shelf-body-search-page${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={t("shelfSettings.search.results")}>
    <header className="shelf-body-search-page-head">
      <button type="button" className="shelf-settings-icon-btn is-back" onClick={props.onClose} aria-label={t("shelfSettings.search.close")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
      </button>
      <label className="shelf-body-search-page-input">
        <input ref={inputRef} type="search" value={body.query} placeholder={t("search.placeholder.all")}
          aria-label={t("search.placeholder.all")} disabled={props.busy || indexBusy}
          onChange={(event) => body.onQueryChange(event.target.value)} />
      </label>
    </header>
    <div className="shelf-body-search-page-scroll">
      <BodySearchResults body={body} onManageIndex={props.onManageIndex} />
    </div>
  </section>;
}
