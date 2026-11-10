import { useState } from "react";
import { Segmented } from "../controls/Segmented";
import { useUiText } from "../localization/UiLanguageProvider";
import "../saveFileDialogs.css";
import "./readestImport.css";
import { selectionSummary, type ImportResult, type ImportRow, type PositionRule, type RowKind } from "./readestImportModel";
import type { ReadestImportState } from "./useReadestImport";

export interface ReadestImportDialogProps {
  state: ReadestImportState;
  updateRows(update: (rows: ImportRow[]) => ImportRow[]): void;
  onRule(rule: PositionRule): void;
  onUseFound(): void;
  onPickBackup(): void;
  onPickFolder(): void;
  onBack(): void;
  onRun(): void;
  onStop(): void;
  onCancel(): void;
}

type T = ReturnType<typeof useUiText>["t"];
type Of<K extends ReadestImportState["kind"]> = Extract<ReadestImportState, { kind: K }>;

function Shell(props: { subtitle?: string; children: React.ReactNode; actions: React.ReactNode }) {
  const { t } = useUiText();
  return (
    <div className="save-file-backdrop" role="presentation">
      <section className="save-file-dialog readest-import readest-flow" role="dialog" aria-modal="true" aria-label={t("readestImport.title")}>
        <header className="save-file-dialog-head">
          <h2>{t("readestImport.title")}</h2>
          {props.subtitle && <p>{props.subtitle}</p>}
        </header>
        <div className="save-file-dialog-body">{props.children}</div>
        <footer className="save-file-dialog-actions">{props.actions}</footer>
      </section>
    </div>
  );
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? mb.toFixed(0) : mb >= 1 ? mb.toFixed(1) : Math.max(0.1, mb).toFixed(1);
}

function SourceStep({ state, ...props }: ReadestImportDialogProps & { state: Of<"source"> }) {
  const { t } = useUiText();
  const found = state.probe && state.probe !== "probing" ? state.probe : null;
  return (
    <Shell actions={<button type="button" onClick={props.onCancel}>{t("readestImport.cancel")}</button>}>
      {state.probe === "probing" && <p className="save-file-muted">{t("readestImport.source.probing")}</p>}
      {found && (
        <div className="readest-found">
          <div className="readest-row-text">
            <b>{t("readestImport.source.found")}</b>
            <span>{t("readestImport.source.foundBooks", { count: found.books })}</span>
            <span className="readest-path" title={found.path}>{found.path}</span>
          </div>
          <button type="button" className="readest-primary" onClick={props.onUseFound}>{t("readestImport.source.useFound")}</button>
        </div>
      )}
      {state.canPickFolder && state.probe === null && <p className="save-file-muted">{t("readestImport.source.notFound")}</p>}
      <div className="readest-group">
        <button type="button" className="readest-choice" onClick={props.onPickBackup}>
          <b>{t("readestImport.source.pickBackup")}</b>
          <span>{t("readestImport.source.pickBackup.detail")}</span>
        </button>
        {state.canPickFolder && (
          <button type="button" className="readest-choice" onClick={props.onPickFolder}>
            <b>{t("readestImport.source.pickFolder")}</b>
            <span>{t("readestImport.source.pickFolder.detail")}</span>
          </button>
        )}
      </div>
      {state.error && <p className="readest-bad" role="alert">{state.error}</p>}
    </Shell>
  );
}

function rowDetail(t: T, row: ImportRow): string {
  const parts = [row.author, row.format].filter(Boolean);
  if (row.kind === "new" && row.file) parts.push(`${megabytes(row.file.bytes)} MB`);
  if (row.kind === "new" && !row.records) parts.push(t("readestImport.row.bookOnly"));
  if (row.kind === "unavailable") parts.push(t(`readestImport.reason.${row.reason ?? "no-file"}`));
  return parts.join(" · ");
}

function ListStep({ state, ...props }: ReadestImportDialogProps & { state: Of<"list"> }) {
  const { t } = useUiText();
  const { rows, rule } = state;
  const importable = rows.filter((row) => row.kind !== "unavailable");
  const summary = selectionSummary(rows);
  const chosen = summary.newBooks + summary.existing;
  const allOn = importable.length > 0 && chosen === importable.length;
  const toggle = (hash: string, selected: boolean) =>
    props.updateRows((all) => all.map((row) => (row.readestHash === hash ? { ...row, selected } : row)));
  const toggleAll = (selected: boolean) =>
    props.updateRows((all) => all.map((row) => (row.kind === "unavailable" ? row : { ...row, selected })));
  const groups: Array<[RowKind, ImportRow[]]> = [
    ["new", rows.filter((row) => row.kind === "new")],
    ["existing", rows.filter((row) => row.kind === "existing")],
    ["unavailable", rows.filter((row) => row.kind === "unavailable")],
  ];
  return (
    <Shell
      subtitle={t("readestImport.list.source", { source: state.sourceLabel })}
      actions={<>
        <button type="button" onClick={props.onBack}>{t("readestImport.back")}</button>
        <button type="button" className="primary" disabled={chosen === 0} onClick={props.onRun}>
          {t("readestImport.run", { count: chosen })}
        </button>
      </>}
    >
      {rows.length === 0 && <p className="save-file-muted">{t("readestImport.list.empty")}</p>}
      {importable.length > 0 && (
        <label className="readest-all">
          <input type="checkbox" checked={allOn} onChange={(event) => toggleAll(event.target.checked)} />
          <span>{t("readestImport.list.all")}</span>
          <small>{summary.newBooks > 0
            ? t("readestImport.list.chosenWithSize", { count: chosen, size: megabytes(summary.bytes) })
            : t("readestImport.list.chosen", { count: chosen })}</small>
        </label>
      )}
      {groups.map(([kind, group]) => group.length > 0 && (
        <div className="readest-group" key={kind}>
          <p className="readest-group-label">{t(`readestImport.group.${kind}`, { count: group.length })}</p>
          {group.map((row) => {
            const off = row.kind === "unavailable";
            return (
              <label className={`readest-row${off ? " disabled" : ""}`} key={row.readestHash}>
                <input type="checkbox" checked={row.selected} disabled={off} aria-label={row.title}
                  onChange={(event) => toggle(row.readestHash, event.target.checked)} />
                <span className="readest-row-text">
                  <b>{row.title}</b>
                  <span>{rowDetail(t, row)}</span>
                </span>
              </label>
            );
          })}
        </div>
      ))}
      {summary.existing > 0 && (
        <div className="readest-rule">
          <p className="readest-group-label">{t("readestImport.rule.label")}</p>
          <Segmented label={t("readestImport.rule.label")} variant="fill" value={rule} onChange={props.onRule} options={[
            { value: "farther", label: t("readestImport.rule.farther") },
            { value: "readest", label: t("readestImport.rule.readest") },
            { value: "local", label: t("readestImport.rule.local") },
          ]} />
        </div>
      )}
    </Shell>
  );
}

function WorkingStep({ state, onCancel }: { state: Of<"working">; onCancel(): void }) {
  const { t } = useUiText();
  const text = state.step === "opening"
    ? t("readestImport.working.opening")
    : state.total > 0
      ? t("readestImport.working.matchingCount", { done: state.done, total: state.total })
      : t("readestImport.working.matching");
  return (
    <Shell subtitle={t("readestImport.list.source", { source: state.sourceLabel })}
      actions={<button type="button" onClick={onCancel}>{t("readestImport.cancel")}</button>}>
      <p className="save-file-muted" role="status">{text}</p>
    </Shell>
  );
}

function ImportingStep({ state, onStop }: { state: Of<"importing">; onStop(): void }) {
  const { t } = useUiText();
  const extracting = state.bytesTotal > 0 && state.bytesDone < state.bytesTotal;
  const ratio = state.total > 0 ? Math.min(1, state.done / state.total) : 0;
  return (
    <Shell subtitle={t("readestImport.list.source", { source: state.sourceLabel })}
      actions={<button type="button" disabled={state.stopping} onClick={onStop}>
        {state.stopping ? t("readestImport.stopping") : t("readestImport.stop")}
      </button>}>
      <div className="readest-progress" role="status">
        <b>{t("readestImport.importing", { done: state.done, total: state.total })}</b>
        <div className="readest-bar"><i style={{ transform: `scaleX(${ratio})` }} /></div>
        <span className="readest-now">{state.title}</span>
        {extracting && <small>{t("readestImport.importing.extracting", { done: megabytes(state.bytesDone), total: megabytes(state.bytesTotal) })}</small>}
      </div>
    </Shell>
  );
}

function ResultLines({ result }: { result: ImportResult }) {
  const { t } = useUiText();
  const lines: string[] = [];
  if (result.booksAdded > 0) lines.push(t("readestImport.done.books", { count: result.booksAdded }));
  const marks = result.notesAdded + result.bookmarksAdded;
  if (marks > 0) lines.push(t("readestImport.done.records", { notes: result.notesAdded, bookmarks: result.bookmarksAdded }));
  if (result.progressWritten > 0) lines.push(t("readestImport.done.progress", { count: result.progressWritten }));
  if (result.booksClassified > 0) lines.push(t("readestImport.done.classified", { count: result.booksClassified }));
  if (result.booksAlready > 0) lines.push(t("readestImport.done.already", { count: result.booksAlready }));
  if (result.skippedExisting > 0) lines.push(t("readestImport.done.skipped", { count: result.skippedExisting }));
  if (lines.length === 0) lines.push(t("readestImport.done.nothing"));
  return <ul className="readest-summary">{lines.map((line) => <li key={line}>{line}</li>)}</ul>;
}

function DoneStep({ state, onCancel }: { state: Of<"done">; onCancel(): void }) {
  const { t } = useUiText();
  const { result } = state;
  const [showFailed, setShowFailed] = useState(false);
  const [showUnplaced, setShowUnplaced] = useState(false);
  const [showApproximate, setShowApproximate] = useState(false);
  return (
    <Shell subtitle={t("readestImport.list.source", { source: state.sourceLabel })}
      actions={<button type="button" className="primary" onClick={onCancel}>{t("readestImport.finish")}</button>}>
      <ResultLines result={result} />
      {result.error && <p className="readest-bad" role="alert">{result.error}</p>}
      {(result.stopped || result.error) && result.notReached > 0 && (
        <p className="readest-warn">{t(result.stopped ? "readestImport.done.stopped" : "readestImport.done.notReached", { count: result.notReached })}</p>
      )}
      {result.failed.length > 0 && (
        <div className="readest-group">
          <button type="button" className="readest-fold" aria-expanded={showFailed} onClick={() => setShowFailed(!showFailed)}>
            {t("readestImport.done.failed", { count: result.failed.length })}
          </button>
          {showFailed && result.failed.map((book, index) => (
            <div className="readest-row readest-static" key={`${book.title}:${index}`}>
              <span className="readest-row-text"><b>{book.title}</b><span>{book.reason}</span></span>
            </div>
          ))}
        </div>
      )}
      {result.approximate.length > 0 && <div className="readest-group">
        <button type="button" className="readest-fold" aria-expanded={showApproximate} onClick={() => setShowApproximate(!showApproximate)}>
          {t("readestImport.done.approximate", { count: result.approximate.length })}
        </button>
        {showApproximate && result.approximate.map((record, index) => <div className="readest-row readest-static" key={index}>
          <span className="readest-row-text"><b>{record.title}</b>
            <span>{t(`readestImport.unplaced.${record.kind}`)} · {record.reasons.map((reason) => t(`readestImport.reason.${reason}`)).join(" · ")}</span>
          </span>
        </div>)}
      </div>}
      {result.unplaced.length > 0 && (
        <div className="readest-group">
          <button type="button" className="readest-fold" aria-expanded={showUnplaced} onClick={() => setShowUnplaced(!showUnplaced)}>
            {t("readestImport.done.unplaced", { count: result.unplaced.length })}
          </button>
          {showUnplaced && result.unplaced.map((record, index) => (
            <div className="readest-row readest-static" key={index}>
              <span className="readest-row-text">
                <b>{record.title}</b>
                <span>{t(`readestImport.unplaced.${record.kind}`)}{record.text ? ` · ${record.text}` : ""}</span>
                <span>{t(`readestImport.reason.${record.reason}`)}</span>
                <details><summary>{t("readestImport.done.original")}</summary>
                  <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(record, null, 2)}</pre>
                </details>
              </span>
            </div>
          ))}
        </div>
      )}
      {result.unsupported > 0 && <p className="save-file-muted">{t("readestImport.done.unsupported", { count: result.unsupported })}</p>}
    </Shell>
  );
}

export function ReadestImportDialog(props: ReadestImportDialogProps) {
  const { state } = props;
  switch (state.kind) {
    case "idle": return null;
    case "source": return <SourceStep {...props} state={state} />;
    case "working": return <WorkingStep state={state} onCancel={props.onCancel} />;
    case "list": return <ListStep {...props} state={state} />;
    case "importing": return <ImportingStep state={state} onStop={props.onStop} />;
    case "done": return <DoneStep state={state} onCancel={props.onCancel} />;
  }
}
