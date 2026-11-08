import { currentUiLocale, useUiText } from "../localization/UiLanguageProvider";
import "../saveFileDialogs.css";
import "../readestImport/readestImport.css";
import "./koreaderImport.css";
import {
  canConfirmKoreader,
  splitKoreaderBooks,
  type KoreaderBlockReason,
  type KoreaderImportState,
  type KoreaderLocalBook,
  type KoreaderPosition,
} from "./koreaderImportModel";

/**
 * Single-book KOReader progress import, on the Readest import's dialog shell:
 * pick sidecar → choose local book → compare → confirm or cancel. The result
 * is reported by the owner as a shelf notice, as the Readest import does.
 */
export interface KoreaderImportDialogProps {
  state: KoreaderImportState;
  onChoose(bookId: string): void;
  onNext(): void;
  onBack(): void;
  onConfirm(): void;
  onCancel(): void;
}

type T = ReturnType<typeof useUiText>["t"];

function Shell(props: { title: string; subtitle?: string; children: React.ReactNode; actions: React.ReactNode }) {
  const { t } = useUiText();
  return (
    <div className="save-file-backdrop" role="presentation">
      <section className="save-file-dialog readest-import koreader-import" role="dialog" aria-modal="true" aria-label={t("koreaderImport.dialog")}>
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

function formatWhen(ms: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(currentUiLocale(), {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function positionText(t: T, position: KoreaderPosition): string {
  const when = position.updatedAtMs === null ? t("koreaderImport.time.unknown") : formatWhen(position.updatedAtMs);
  if (position.progressPct === null) return t("koreaderImport.position.none");
  return t("koreaderImport.position.value", { pct: Math.round(position.progressPct), when });
}

function bookDetail(t: T, book: KoreaderLocalBook): string {
  const basis = book.basis ? t(`koreaderImport.basis.${book.basis}`) : null;
  const progress = book.progressPct === null ? t("koreaderImport.position.none") : t("koreaderImport.local.progress", { pct: Math.round(book.progressPct) });
  return [basis, book.author || null, progress].filter(Boolean).join(t("koreaderImport.sep"));
}

function blockText(t: T, reason: KoreaderBlockReason, code?: string): string {
  return reason === "other" ? t("koreaderImport.block.other", { code: code ?? "?" }) : t(`koreaderImport.block.${reason}`);
}

function ChooseStep(props: KoreaderImportDialogProps & { state: Extract<KoreaderImportState, { kind: "choose" }> }) {
  const { t } = useUiText();
  const { sidecar, books, chosen } = props.state;
  const { candidates, others } = splitKoreaderBooks(books);
  const chosenOther = others.some((book) => book.id === chosen) ? chosen! : "";
  return (
    <Shell
      title={t("koreaderImport.title")}
      subtitle={t("koreaderImport.subtitle", { source: sidecar.label })}
      actions={<>
        <button type="button" onClick={props.onCancel}>{t("koreaderImport.cancel")}</button>
        <button type="button" className="primary" disabled={!chosen} onClick={props.onNext}>{t("koreaderImport.next")}</button>
      </>}
    >
      {(sidecar.title || sidecar.author) && (
        <p className="koreader-source">
          <b>{sidecar.title ?? t("koreaderImport.source.untitled")}</b>
          {sidecar.author && <span>{sidecar.author}</span>}
        </p>
      )}
      {books.length === 0 ? <p className="save-file-muted">{t("koreaderImport.choose.noLocal")}</p> : (
        <div className="readest-group" role="radiogroup" aria-label={t("koreaderImport.choose.label")}>
          <p className="readest-group-label">
            {candidates.length > 0 ? t("koreaderImport.group.candidates") : t("koreaderImport.group.noCandidates")}
          </p>
          {candidates.map((book) => (
            <label className={`readest-row koreader-pick${chosen === book.id ? " chosen" : ""}`} key={book.id}>
              <input type="radio" name="koreader-local" checked={chosen === book.id} onChange={() => props.onChoose(book.id)} />
              <span className="readest-row-text">
                <b>{book.title}</b>
                <span>{bookDetail(t, book)}</span>
              </span>
            </label>
          ))}
          {others.length > 0 && (
            <div className={`readest-row koreader-pick${chosenOther ? " chosen" : ""}`}>
              <span aria-hidden="true" />
              <span className="readest-row-text">
                <b>{t("koreaderImport.choose.other")}</b>
                <span>{chosenOther ? bookDetail(t, others.find((book) => book.id === chosenOther)!) : t("koreaderImport.choose.otherHint")}</span>
              </span>
              <select
                className="readest-choose"
                aria-label={t("koreaderImport.choose.other")}
                value={chosenOther}
                onChange={(event) => { if (event.target.value) props.onChoose(event.target.value); }}
              >
                <option value="">{t("koreaderImport.choose.placeholder")}</option>
                {others.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
      <p className="save-file-muted">{t("koreaderImport.choose.hint")}</p>
      <p className="save-file-muted">{t("koreaderImport.scope")}</p>
    </Shell>
  );
}

function PreviewStep(props: KoreaderImportDialogProps & { state: Extract<KoreaderImportState, { kind: "preview" }> }) {
  const { t } = useUiText();
  const { sidecar, books, chosen, preview } = props.state;
  const book = books.find((entry) => entry.id === chosen);
  const ready = canConfirmKoreader(props.state);
  const { status, target } = preview;
  const confirmLabel = preview.local.progressPct === null ? t("koreaderImport.confirm.add") : t("koreaderImport.confirm.replace");
  return (
    <Shell
      title={t("koreaderImport.preview.title")}
      subtitle={book ? t("koreaderImport.preview.subtitle", { title: book.title }) : sidecar.label}
      actions={<>
        <button type="button" onClick={props.onBack}>{t("koreaderImport.back")}</button>
        <button type="button" onClick={props.onCancel}>{t("koreaderImport.cancel")}</button>
        <button type="button" className="primary" disabled={!ready} onClick={props.onConfirm}>{confirmLabel}</button>
      </>}
    >
      <dl className="koreader-compare">
        <div>
          <dt>{t("koreaderImport.side.koreader")}</dt>
          <dd>{positionText(t, preview.koreader)}</dd>
        </div>
        <div>
          <dt>{t("koreaderImport.side.local")}</dt>
          <dd>{positionText(t, preview.local)}</dd>
        </div>
      </dl>
      {target && status.kind !== "blocked" && (
        <div className="readest-book koreader-target">
          <p className="readest-group-label">{t("koreaderImport.target.label")}</p>
          <b>{target.chapterTitle ?? t("koreaderImport.target.untitled")}</b>
          {target.excerpt && <q>{target.excerpt}</q>}
        </div>
      )}
      {status.kind === "blocked" && <p className="readest-bad" role="alert">{blockText(t, status.reason, status.code)}</p>}
      {status.kind === "same" && <p className="save-file-muted" role="status">{t("koreaderImport.preview.same")}</p>}
      {ready && preview.local.progressPct !== null && <p className="save-file-muted">{t("koreaderImport.preview.replaceHint")}</p>}
      <p className="save-file-muted">{t("koreaderImport.preview.footer")}</p>
    </Shell>
  );
}

function WorkingStep(props: KoreaderImportDialogProps & { state: Extract<KoreaderImportState, { kind: "working" }> }) {
  const { t } = useUiText();
  const { step, sourceLabel } = props.state;
  return (
    <Shell
      title={t("koreaderImport.title")}
      subtitle={sourceLabel}
      actions={<button type="button" disabled={step === "committing"} onClick={props.onCancel}>{t("koreaderImport.cancel")}</button>}
    >
      <p className="save-file-muted" role="status" aria-live="polite">{t(`koreaderImport.working.${step}`)}</p>
    </Shell>
  );
}

export function KoreaderImportDialog(props: KoreaderImportDialogProps) {
  const { state } = props;
  if (state.kind === "choose") return <ChooseStep {...props} state={state} />;
  if (state.kind === "preview") return <PreviewStep {...props} state={state} />;
  if (state.kind === "working") return <WorkingStep {...props} state={state} />;
  return null;
}
