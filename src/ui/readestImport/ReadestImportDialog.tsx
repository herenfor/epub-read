import { useState } from "react";
import { useUiText } from "../localization/UiLanguageProvider";
import "../saveFileDialogs.css";
import "./readestImport.css";
import type { ImportCandidate } from "./readestConvert";
import {
  canImportRow,
  commitPlan,
  gradeCounts,
  isSelectable,
  type BookReview,
  type LocalImportBook,
  type MatchRow,
  type ReviewItem,
} from "./readestImportModel";
import type { ReadestImportState } from "./useReadestImport";

export interface ReadestImportDialogProps {
  state: ReadestImportState;
  updateRows(update: (rows: MatchRow[]) => MatchRow[]): void;
  updateReviews(update: (reviews: BookReview[]) => BookReview[]): void;
  onNext(): void;
  onBack(): void;
  onCommit(): void;
  onCancel(): void;
}

type T = ReturnType<typeof useUiText>["t"];

function Shell(props: { title: string; subtitle?: string; children: React.ReactNode; actions: React.ReactNode; wide?: boolean }) {
  const { t } = useUiText();
  return (
    <div className="save-file-backdrop" role="presentation">
      <section className={`save-file-dialog readest-import${props.wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={t("readestImport.dialog")}>
        <header className="save-file-dialog-head">
          <h2>{props.title}</h2>
          {props.subtitle && <p>{props.subtitle}</p>}
        </header>
        <div className="save-file-dialog-body">{props.children}</div>
        <footer className="save-file-dialog-actions">{props.actions}</footer>
      </section>
    </div>
  );
}

function MatchStep(props: ReadestImportDialogProps & { state: Extract<ReadestImportState, { kind: "match" }> }) {
  const { t } = useUiText();
  const { rows, locals, sourceLabel } = props.state;
  const byId = new Map(locals.map((book) => [book.id, book]));
  const setRow = (hash: string, patch: Partial<MatchRow>) =>
    props.updateRows((all) => all.map((row) => (row.readestHash === hash ? { ...row, ...patch } : row)));
  const groups: Array<[string, MatchRow[]]> = [
    [t("readestImport.group.matched"), rows.filter((row) => row.status === "matched")],
    [t("readestImport.group.choose"), rows.filter((row) => row.status === "ambiguous" || row.status === "unmatched")],
    [t("readestImport.group.unavailable"), rows.filter((row) => !canImportRow(row))],
  ];
  const ready = rows.some((row) => row.selected && row.chosen);
  return (
    <Shell
      title={t("readestImport.match.title")}
      subtitle={t("readestImport.match.subtitle", { source: sourceLabel })}
      actions={<>
        <button type="button" onClick={props.onCancel}>{t("readestImport.cancel")}</button>
        <button type="button" className="primary" disabled={!ready} onClick={props.onNext}>{t("readestImport.next")}</button>
      </>}
    >
      {locals.length === 0 && <p className="save-file-muted">{t("readestImport.match.noLocal")}</p>}
      {groups.map(([label, group]) => group.length > 0 && (
        <div className="readest-group" key={label}>
          <p className="readest-group-label">{label}</p>
          {group.map((row) => {
            const importable = canImportRow(row);
            return (
              <div className={`readest-row${importable ? "" : " disabled"}`} key={row.readestHash}>
                <input
                  type="checkbox"
                  aria-label={row.title}
                  disabled={!importable || !row.chosen}
                  checked={row.selected && Boolean(row.chosen)}
                  onChange={(event) => setRow(row.readestHash, { selected: event.target.checked })}
                />
                <span className="readest-row-text">
                  <b>{row.title}</b>
                  <span>{rowDetail(t, row, byId)}</span>
                </span>
                {importable && row.status !== "matched" && (
                  <select
                    className="readest-choose"
                    aria-label={t("readestImport.choose.label")}
                    value={row.chosen ?? ""}
                    onChange={(event) => setRow(row.readestHash, { chosen: event.target.value || null, selected: Boolean(event.target.value) })}
                  >
                    <option value="">{t("readestImport.choose.placeholder")}</option>
                    {localOptions(row, locals).map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <p className="save-file-muted">{t("readestImport.match.hint")}</p>
      <p className="save-file-muted">{t("readestImport.match.scope")}</p>
    </Shell>
  );
}

function rowDetail(t: T, row: MatchRow, byId: Map<string, LocalImportBook>): string {
  switch (row.status) {
    case "matched": return t("readestImport.row.matched", { title: byId.get(row.chosen!)?.title ?? "" });
    case "ambiguous": return row.chosen ? t("readestImport.row.matched", { title: byId.get(row.chosen)?.title ?? "" }) : t("readestImport.row.ambiguous", { count: row.candidates.length });
    case "unmatched": return row.chosen ? t("readestImport.row.matched", { title: byId.get(row.chosen)?.title ?? "" }) : t("readestImport.row.unmatched");
    case "deleted": return t("readestImport.row.deleted");
    case "unsupported-format": return t("readestImport.row.format", { format: row.format });
  }
}

/** Digest candidates first, then every other local EPUB. */
function localOptions(row: MatchRow, locals: readonly LocalImportBook[]): LocalImportBook[] {
  const first = locals.filter((book) => row.candidates.includes(book.id));
  return [...first, ...locals.filter((book) => !row.candidates.includes(book.id))];
}

function reasonText(t: T, candidate: ImportCandidate<unknown>): string {
  // Every ImportReason has a readestImport.reason.* message without parameters.
  const plain = t as (key: string) => string;
  return candidate.reasons.map((reason) => plain(`readestImport.reason.${reason}`)).join(t("readestImport.reasonSeparator"));
}

function quote(item: ReviewItem<unknown>, t: T): string {
  const value = item.candidate.value as { selectedText?: string; text?: string } | null;
  return item.candidate.source.text ?? value?.selectedText ?? value?.text ?? t("readestImport.review.bookmark");
}

function ReviewBook(props: { review: BookReview; index: number; update: ReadestImportDialogProps["updateReviews"] }) {
  const { t } = useUiText();
  const { review, index } = props;
  const [expanded, setExpanded] = useState(false);
  const counts = gradeCounts(review);
  const patch = (change: (review: BookReview) => BookReview) =>
    props.update((all) => all.map((entry, at) => (at === index ? change(entry) : entry)));
  const toggleItem = (kind: "bookmarks" | "notes", at: number, selected: boolean) =>
    patch((entry) => ({ ...entry, [kind]: entry[kind].map((item, i) => (i === at ? { ...item, selected } : item)) }));
  const details = (["bookmarks", "notes"] as const).flatMap((kind) =>
    (review[kind] as ReviewItem<unknown>[]).map((item, at) => ({ kind, at, item })).filter(({ item }) => item.candidate.grade !== "exact"));
  const progress = review.progress;
  const empty = !progress && review.bookmarks.length === 0 && review.notes.length === 0;
  const readestPct = progress?.candidate.value?.progressPctHint;
  return (
    <div className="readest-book">
      <div className="readest-book-top">
        <input type="checkbox" aria-label={review.title} checked={review.selected} disabled={empty}
          onChange={(event) => patch((entry) => ({ ...entry, selected: event.target.checked }))} />
        <b>{review.title}</b>
        {details.length > 0 && (
          <button type="button" className="readest-link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? t("readestImport.review.collapse") : t("readestImport.review.expand")}
          </button>
        )}
      </div>
      {empty ? <p className="save-file-muted">{t("readestImport.review.empty")}</p> : (
        <div className="readest-counts">
          {review.bookmarks.length > 0 && <span>{t("readestImport.review.bookmarks", { count: review.bookmarks.length })}</span>}
          {review.notes.length > 0 && <span>{t("readestImport.review.notes", { count: review.notes.length })}</span>}
          {counts.exact > 0 && <span className="readest-ok">{t("readestImport.grade.exact", { count: counts.exact })}</span>}
          {counts.approximate > 0 && <span className="readest-warn">{t("readestImport.grade.approximate", { count: counts.approximate })}</span>}
          {counts.unresolved > 0 && <span className="readest-bad">{t("readestImport.grade.unresolved", { count: counts.unresolved })}</span>}
          {counts.unsupported > 0 && <span className="readest-muted">{t("readestImport.grade.unsupported", { count: counts.unsupported })}</span>}
        </div>
      )}
      {progress && (
        isSelectable(progress.candidate) ? (
          <label className="readest-progress">
            <input type="checkbox" checked={progress.selected} disabled={!review.selected}
              onChange={(event) => patch((entry) => ({ ...entry, progress: entry.progress && { ...entry.progress, selected: event.target.checked } }))} />
            <span>
              {review.local.progressPct === null ? t("readestImport.progress.add") : t("readestImport.progress.replace")}
              <small>
                {review.local.progressPct === null
                  ? t("readestImport.progress.readestOnly", { readest: readestPct ?? 0 })
                  : t("readestImport.progress.both", { readest: readestPct ?? 0, local: Math.round(review.local.progressPct) })}
                {progress.candidate.grade === "approximate" ? ` · ${reasonText(t, progress.candidate)}` : ""}
              </small>
            </span>
          </label>
        ) : <p className="save-file-muted readest-bad">{t("readestImport.progress.unresolved")}</p>
      )}
      {expanded && (
        <div className="readest-detail">
          {details.map(({ kind, at, item }) => {
            const selectable = isSelectable(item.candidate);
            return (
              <label className={`readest-item${selectable ? "" : " off"}`} key={item.candidate.sourceKey}>
                {selectable
                  ? <input type="checkbox" checked={item.selected} disabled={!review.selected} onChange={(event) => toggleItem(kind, at, event.target.checked)} />
                  : <span aria-hidden="true" />}
                <span>
                  <q>{quote(item, t)}</q>
                  <small>{reasonText(t, item.candidate)}</small>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewStep(props: ReadestImportDialogProps & { state: Extract<ReadestImportState, { kind: "review" }> }) {
  const { t } = useUiText();
  const { reviews } = props.state;
  const plan = commitPlan(reviews);
  const count = plan.ok ? plan.records : 0;
  const styles = reviews.some((review) => review.notes.length > 0);
  return (
    <Shell
      wide
      title={t("readestImport.review.title")}
      subtitle={t("readestImport.review.subtitle")}
      actions={<>
        <button type="button" onClick={props.onBack}>{t("readestImport.back")}</button>
        <button type="button" className="primary" disabled={count === 0} onClick={props.onCommit}>{t("readestImport.confirm", { count })}</button>
      </>}
    >
      {reviews.map((review, index) => <ReviewBook key={review.readestHash} review={review} index={index} update={props.updateReviews} />)}
      {styles && <p className="save-file-muted">{t("readestImport.review.styles")}</p>}
      <p className="save-file-muted">{t("readestImport.review.footer")}</p>
    </Shell>
  );
}

function WorkingStep(props: ReadestImportDialogProps & { state: Extract<ReadestImportState, { kind: "working" }> }) {
  const { t } = useUiText();
  const { step, done, total, sourceLabel } = props.state;
  const text = step === "converting"
    ? t("readestImport.working.converting", { done, total })
    : t(`readestImport.working.${step}`);
  return (
    <Shell
      title={t("readestImport.match.title")}
      subtitle={sourceLabel}
      actions={<button type="button" disabled={step === "committing"} onClick={props.onCancel}>{t("readestImport.cancel")}</button>}
    >
      <p className="save-file-muted" role="status" aria-live="polite">{text}</p>
    </Shell>
  );
}

export function ReadestImportDialog(props: ReadestImportDialogProps) {
  const { state } = props;
  if (state.kind === "match") return <MatchStep {...props} state={state} />;
  if (state.kind === "review") return <ReviewStep {...props} state={state} />;
  if (state.kind === "working") return <WorkingStep {...props} state={state} />;
  return null;
}
