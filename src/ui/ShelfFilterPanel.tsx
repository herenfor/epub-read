import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useExitPresence } from "./menuMotion";
import { useUiText, type Translate } from "./localization/UiLanguageProvider";
import { localizeFacetOptions, type ShelfFacetKind } from "./shelfFacetLabels";
import type { ShelfFilterFacets, ShelfSort, ShelfTimeSegment } from "./shelf";
import "./shelfSettings.css";

/** Facet selection of the shelf. Titles stay in the model but are no longer offered: search covers them. */
export interface ShelfFilters {
  authors: Set<string>;
  titles: Set<string>;
  saved: Set<ShelfTimeSegment>;
  languages: Set<string>;
}

export const EMPTY_SHELF_FILTERS: ShelfFilters = {
  authors: new Set(),
  titles: new Set(),
  saved: new Set(),
  languages: new Set(),
};

export function shelfFilterCount(filters: ShelfFilters): number {
  return filters.authors.size + filters.titles.size + filters.saved.size + filters.languages.size;
}

export type ShelfFilterDimension = "authors" | "languages" | "saved";

const DIMENSIONS: ReadonlyArray<{
  key: ShelfFilterDimension;
  facet: Exclude<ShelfFacetKind, "titles">;
  label: "shelfMenu.filter.author" | "shelfMenu.filter.language" | "shelfMenu.filter.saved";
}> = [
  { key: "authors", facet: "authors", label: "shelfMenu.filter.author" },
  { key: "languages", facet: "languages", label: "shelfMenu.filter.language" },
  { key: "saved", facet: "timeSegments", label: "shelfMenu.filter.saved" },
];

export interface ShelfFacetValue {
  value: string;
  label: string;
  count: number;
}

/** Values whose own selection is the reason they show 0 still stay listed. Picked first, then by book count. */
export function orderFacetValues(options: readonly ShelfFacetValue[], selected: ReadonlySet<string>, query = ""): {
  picked: ShelfFacetValue[];
  others: ShelfFacetValue[];
} {
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle)) : options;
  const byCount = (a: ShelfFacetValue, b: ShelfFacetValue) => b.count - a.count || a.label.localeCompare(b.label, "zh-Hans-CN");
  return {
    picked: matches.filter((option) => selected.has(option.value)).sort(byCount),
    others: matches.filter((option) => !selected.has(option.value)).sort(byCount),
  };
}

export interface ShelfFilterChip {
  dimension: ShelfFilterDimension;
  label: string;
  /** Accessible name of the chip's clear button. */
  clearLabel: string;
}

/** One chip per dimension, never per value: a hundred selected authors still make one chip. */
export function shelfFilterChips(
  filters: ShelfFilters,
  facets: ShelfFilterFacets,
  t: Translate,
  compact: boolean,
): ShelfFilterChip[] {
  const chips: ShelfFilterChip[] = [];
  for (const dimension of DIMENSIONS) {
    const selected = filters[dimension.key] as ReadonlySet<string>;
    if (selected.size === 0) continue;
    const name = t(dimension.label);
    const labels = new Map(localizeFacetOptions(dimension.facet, facets[dimension.facet].options, t)
      .map((option) => [option.value, option.label]));
    const values = [...selected].map((value) => labels.get(value) ?? value);
    const shown = values.slice(0, 2).join(t("notice.listSep"));
    const label = compact
      ? (values.length === 1 ? values[0] : t("shelfSettings.filter.chip.compact", { label: name, count: values.length }))
      : values.length <= 2
        ? t("shelfSettings.filter.chip", { label: name, values: shown })
        : t("shelfSettings.filter.chip.many", { label: name, values: shown, count: values.length });
    chips.push({ dimension: dimension.key, label, clearLabel: t("shelfSettings.filter.chip.clear", { label: name }) });
  }
  return chips;
}

function withoutDimension(filters: ShelfFilters, dimension: ShelfFilterDimension): ShelfFilters {
  return { ...filters, [dimension]: new Set() };
}

function CloseSmallIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>;
}

function CheckMark() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>;
}

/** Active filters on the shelf: one removable chip per dimension and "clear all". */
export function ShelfFilterSummary(props: {
  filters: ShelfFilters;
  facets: ShelfFilterFacets;
  compact: boolean;
  onFiltersChange(filters: ShelfFilters): void;
}) {
  const { t } = useUiText();
  const chips = shelfFilterChips(props.filters, props.facets, t, props.compact);
  if (chips.length === 0) return null;
  return <div className="shelf-filter-summary" role="group" aria-label={t("shelfSettings.filter.applied")}>
    {!props.compact && <span className="shelf-filter-summary-label">{t("shelfSettings.filter.applied")}</span>}
    {chips.map((chip) => <span key={chip.dimension} className="shelf-filter-chip">
      <span className="shelf-filter-chip-text" title={chip.label}>{chip.label}</span>
      <button type="button" className="shelf-filter-chip-clear" aria-label={chip.clearLabel}
        onClick={() => props.onFiltersChange(withoutDimension(props.filters, chip.dimension))}>
        <CloseSmallIcon />
      </button>
    </span>)}
    <button type="button" className="shelf-filter-summary-clear" onClick={() => props.onFiltersChange(EMPTY_SHELF_FILTERS)}>
      {t("shelfSettings.filter.clearAll")}
    </button>
  </div>;
}

const PICKED_PREVIEW = 3;
const LIST_LIMIT = 80;

function ValueRow(props: { option: ShelfFacetValue; checked: boolean; onToggle(): void }) {
  return <label className={`shelf-filter-value${props.option.count === 0 && !props.checked ? " is-empty" : ""}`}>
    <input type="checkbox" checked={props.checked} onChange={props.onToggle} />
    <span className="shelf-filter-check" aria-hidden="true">{props.checked && <CheckMark />}</span>
    <span className="shelf-filter-value-label" title={props.option.label}>{props.option.label}</span>
    <span className="shelf-filter-value-count">{props.option.count}</span>
  </label>;
}

function FacetValues(props: {
  dimension: (typeof DIMENSIONS)[number];
  facets: ShelfFilterFacets;
  filters: ShelfFilters;
  onFiltersChange(filters: ShelfFilters): void;
}) {
  const { t } = useUiText();
  const [query, setQuery] = useState("");
  const [pickedOpen, setPickedOpen] = useState(false);
  const name = t(props.dimension.label);
  const options = useMemo(() => localizeFacetOptions(props.dimension.facet, props.facets[props.dimension.facet].options, t),
    [props.dimension.facet, props.facets, t]);
  const selected = props.filters[props.dimension.key] as ReadonlySet<string>;
  const { picked, others } = orderFacetValues(options, selected, query);
  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    props.onFiltersChange({ ...props.filters, [props.dimension.key]: next });
  };
  const shownPicked = pickedOpen || query ? picked : picked.slice(0, PICKED_PREVIEW);
  const shownOthers = others.slice(0, LIST_LIMIT);
  return <div className="shelf-filter-values">
    {options.length > 8 && <label className="shelf-filter-search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder={t("shelfSettings.filter.search", { count: options.length })}
        aria-label={t("shelfSettings.filter.search", { count: options.length })} />
    </label>}
    {selected.size > 0 && <>
      <div className="shelf-filter-values-head">
        <span>{t("shelfSettings.filter.picked", { count: selected.size })}</span>
        <button type="button" onClick={() => props.onFiltersChange(withoutDimension(props.filters, props.dimension.key))}>
          {t("shelfSettings.filter.clearDimension", { label: name })}
        </button>
      </div>
      <div className="shelf-filter-value-list is-picked">
        {shownPicked.map((option) => <ValueRow key={option.value} option={option} checked onToggle={() => toggle(option.value)} />)}
        {!query && picked.length > PICKED_PREVIEW && <button type="button" className="shelf-filter-more"
          aria-expanded={pickedOpen} onClick={() => setPickedOpen((open) => !open)}>
          {pickedOpen ? t("shelfSettings.filter.collapsePicked") : t("shelfSettings.filter.morePicked", { count: picked.length - PICKED_PREVIEW })}
        </button>}
      </div>
    </>}
    {others.length > 0 && <div className="shelf-filter-values-head is-plain">{t("shelfSettings.filter.allByCount", { label: name })}</div>}
    <div className="shelf-filter-value-list">
      {shownOthers.map((option) => <ValueRow key={option.value} option={option} checked={false} onToggle={() => toggle(option.value)} />)}
    </div>
    {picked.length + others.length === 0 && <div className="shelf-filter-empty">{t("shelfFolder.filter.none")}</div>}
    {others.length > shownOthers.length && <div className="shelf-filter-empty">{t("shelfFolder.filter.limited", { count: shownOthers.length })}</div>}
  </div>;
}

function Segmented<T extends string>(props: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange(value: T): void }) {
  return <div className="shelf-filter-control">
    <span className="shelf-filter-control-label">{props.label}</span>
    <div className="shelf-segmented" role="group" aria-label={props.label}>
      {props.options.map((option) => <button key={option.value} type="button" aria-pressed={props.value === option.value}
        className={props.value === option.value ? "active" : ""} onClick={() => props.onChange(option.value)}>{option.label}</button>)}
    </div>
  </div>;
}

export interface ShelfFilterPanelProps {
  open: boolean;
  /** "sheet": phone bottom sheet that also carries sort/view/density; "popover": anchored under the button. */
  presentation: "popover" | "sheet";
  anchor?: HTMLElement | null;
  filters: ShelfFilters;
  facets: ShelfFilterFacets;
  matchingCount: number;
  onFiltersChange(filters: ShelfFilters): void;
  onClose(): void;
  sort?: ShelfSort;
  onSortChange?(sort: ShelfSort): void;
  viewMode?: "grid" | "list";
  onViewModeChange?(mode: "grid" | "list"): void;
  density?: "comfortable" | "standard" | "compact";
  onDensityChange?(density: "comfortable" | "standard" | "compact"): void;
}

export function ShelfFilterPanel(props: ShelfFilterPanelProps) {
  const { t, tn } = useUiText();
  const { present, closing } = useExitPresence(props.open);
  const available = DIMENSIONS.filter((dimension) => props.facets[dimension.facet].options.length > 0);
  const [active, setActive] = useState<ShelfFilterDimension>("authors");
  const current = available.find((dimension) => dimension.key === active) ?? available[0];
  const [position, setPosition] = useState<CSSProperties>({});
  const count = shelfFilterCount(props.filters);
  const sheet = props.presentation === "sheet";

  useLayoutEffect(() => {
    if (!props.open || sheet || !props.anchor) return;
    const place = () => {
      const rect = props.anchor!.getBoundingClientRect();
      setPosition({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [props.open, props.anchor, sheet]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  if (!present) return null;
  let controls: ReactNode = null;
  if (sheet) {
    controls = <div className="shelf-filter-controls">
      {props.sort && props.onSortChange && <Segmented label={t("shelfMenu.sort")} value={props.sort} onChange={props.onSortChange}
        options={[
          { value: "recent", label: t("shelfMenu.sort.recent") },
          { value: "added", label: t("shelfMenu.sort.added") },
          { value: "title", label: t("shelfMenu.sort.title") },
        ]} />}
      {props.viewMode && props.onViewModeChange && <Segmented label={t("shelfMenu.viewMode")} value={props.viewMode} onChange={props.onViewModeChange}
        options={[{ value: "grid", label: t("shelfMenu.viewMode.grid") }, { value: "list", label: t("shelfMenu.viewMode.list") }]} />}
      {props.density && props.onDensityChange && <Segmented label={t("shelfMenu.density")} value={props.density} onChange={props.onDensityChange}
        options={[
          { value: "comfortable", label: t("shelfMenu.density.comfortable") },
          { value: "standard", label: t("shelfMenu.density.standard") },
          { value: "compact", label: t("shelfMenu.density.compact") },
        ]} />}
    </div>;
  }
  return <div className={`shelf-filter-layer is-${props.presentation}${closing ? " is-closing" : ""}`}>
    <div className="shelf-filter-backdrop" aria-hidden="true" onClick={props.onClose} />
    <section className="shelf-filter-panel" role="dialog" aria-modal={sheet} style={sheet ? undefined : position}
      aria-label={sheet ? t("shelfSettings.filter.title.sheet") : t("shelfSettings.filter.title")}>
      {sheet && <div className="shelf-filter-grip" aria-hidden="true" />}
      <header className="shelf-filter-head">
        <span className="shelf-filter-title">{sheet ? t("shelfSettings.filter.title.sheet") : t("shelfSettings.filter.title")}</span>
        {count > 0 && !sheet && <span className="shelf-filter-head-note">{t("shelfSettings.filter.conditions", { count })}</span>}
        {sheet && <button type="button" className="shelf-filter-done" onClick={props.onClose}>{t("shelfSettings.filter.done")}</button>}
      </header>
      <div className="shelf-filter-body">
        {controls}
        {current && <div className="shelf-filter-facets">
          {sheet && <span className="shelf-filter-control-label">{t("shelfSettings.filter.title")}</span>}
          <div className="shelf-filter-tabs" role="tablist" aria-label={t("shelfSettings.filter.dimensions")}>
            {available.map((dimension) => {
              const selected = props.filters[dimension.key].size;
              const label = t(dimension.label);
              return <button key={dimension.key} type="button" role="tab" aria-selected={dimension.key === current.key}
                className={dimension.key === current.key ? "active" : ""} onClick={() => setActive(dimension.key)}>
                {selected > 0 ? t("shelfSettings.filter.tab.count", { label, count: selected }) : label}
              </button>;
            })}
          </div>
          <FacetValues key={current.key} dimension={current} facets={props.facets} filters={props.filters} onFiltersChange={props.onFiltersChange} />
        </div>}
      </div>
      <footer className="shelf-filter-foot">
        <button type="button" className="shelf-filter-clear-all" disabled={count === 0}
          onClick={() => props.onFiltersChange(EMPTY_SHELF_FILTERS)}>{t("shelfSettings.filter.clearAll")}</button>
        <button type="button" className="shelf-filter-show" onClick={props.onClose}>
          {tn("shelfSettings.filter.show", props.matchingCount, { count: props.matchingCount })}
        </button>
      </footer>
    </section>
  </div>;
}
