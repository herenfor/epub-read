import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DirectoryImportPort,
  DirectoryImportResult,
  DirectoryProgress,
  FolderTarget,
  ImportIssue,
  ScanResult,
} from "../../core/folderImport/contract";
import {
  planDirectoryImport,
  resolveGroups,
  type ActiveFolder,
  type DirectoryBinding,
  type GroupResolution,
  type ImportOptions,
  type PlannedGroup,
  type ScannedEpub,
} from "../../core/folderImport/planner";
import { effectiveFolderId, type LibraryOrganization } from "../libraryOrganization";
import { FolderImportJobOwner } from "./jobOwner";
import "../saveFileDialogs.css";
import "./folderImportPanel.css";
import { uiText, useUiText } from "../localization/UiLanguageProvider";
import type { PlainMessageKey } from "../localization/core";

export interface FolderImportPanelProps {
  /** Native bridge or Web port; the panel never touches files or bytes. */
  readonly port: DirectoryImportPort;
  /** Current organization, read once for the preview; writes are re-checked by the backend. */
  readonly organization: LibraryOrganization;
  /** False when neither a native picker nor webkitdirectory is available. */
  readonly directorySelectionSupported?: boolean;
  /**
   * Exactly once after an import that was started settles — completed,
   * cancelled or failed, even after the panel is gone. Books may have landed
   * before a failure, so the caller refreshes the active data source (list +
   * organization) once here. Scan/preview cancel writes nothing and never calls it.
   */
  onSettled(): void;
  /** The real result, for callers that want it; failures carry none. */
  onImported?(result: DirectoryImportResult): void;
  onClose(): void;
  /** Fallback entry for environments without directory selection. */
  onUseFileImport?(): void;
  /** Incremented by the host (Android Back) to request the same close as 取消/关闭; ignored while importing. */
  closeSignal?: number;
}

export const DEFAULT_FOLDER_IMPORT_OPTIONS: ImportOptions = {
  grouping: "auto",
  looseRootBooks: "root",
  existingPlacement: "fillUnclassified",
};

/** Per-group target choice: reuse a given folder, or create a new one. */
export type GroupChoice = { readonly kind: "reuse"; readonly folderId: string } | { readonly kind: "create" };

/** Default choice from the planner resolution; `choose` has none and blocks start. */
export function defaultGroupChoice(resolution: GroupResolution): GroupChoice | null {
  if (resolution.kind === "reuse") return { kind: "reuse", folderId: resolution.folderId };
  if (resolution.kind === "create") return { kind: "create" };
  return null;
}

/**
 * Final start targets: exactly the plan's groups, never a `choose`. New folder
 * UUIDs are allocated here; the backend creates them only on the first book
 * that is really placed there.
 */
export function buildFolderTargets(
  groups: readonly PlannedGroup[],
  resolutions: readonly GroupResolution[],
  choices: Readonly<Record<string, GroupChoice | undefined>>,
  newFolderId: () => string = () => crypto.randomUUID(),
): FolderTarget[] | null {
  const byKey = new Map(resolutions.map((resolution) => [resolution.groupKey, resolution]));
  const targets: FolderTarget[] = [];
  for (const group of groups) {
    const resolution = byKey.get(group.groupKey);
    if (!resolution) return null;
    const choice = choices[group.groupKey] ?? defaultGroupChoice(resolution);
    if (!choice) return null;
    if (choice.kind === "reuse") {
      targets.push({ groupKey: group.groupKey, kind: "reuse", folderId: choice.folderId });
    } else {
      const name = resolution.kind === "create" ? resolution.name : group.suggestedName;
      targets.push({ groupKey: group.groupKey, kind: "create", folderId: newFolderId(), name });
    }
  }
  return targets;
}

function activeFoldersOf(organization: LibraryOrganization): ActiveFolder[] {
  return Object.entries(organization.folders)
    .filter(([, folder]) => !folder.deleted)
    .map(([folderId, folder]) => ({ folderId, name: folder.name.value }));
}

type Phase =
  | { readonly kind: "intro" }
  | { readonly kind: "scanning"; readonly found: number }
  | { readonly kind: "listing"; readonly scan: ScanResult; readonly loaded: number }
  | { readonly kind: "empty"; readonly scan: ScanResult }
  | { readonly kind: "preview"; readonly scan: ScanResult }
  | { readonly kind: "importing"; readonly progress: DirectoryProgress | null; readonly cancel: "none" | "requested" | "settling" }
  | { readonly kind: "done"; readonly result: DirectoryImportResult }
  | { readonly kind: "error"; readonly message: string };

const INITIAL_GROUP_ROWS = 20;
const MORE_GROUP_ROWS = 50;

const PHASE_LABEL: Record<DirectoryProgress["phase"], PlainMessageKey> = {
  scanning: "folderImport.phase.scanning",
  preparing: "folderImport.phase.preparing",
  committing: "folderImport.phase.committing",
  cleaning: "folderImport.phase.cleaning",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function FolderImportPanel(props: FolderImportPanelProps) {
  const { t, tn } = useUiText();
  const { port } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [items, setItems] = useState<readonly ScannedEpub[]>([]);
  const [bindings, setBindings] = useState<readonly DirectoryBinding[]>([]);
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_FOLDER_IMPORT_OPTIONS);
  const [choices, setChoices] = useState<Record<string, GroupChoice | undefined>>({});
  const [visibleRows, setVisibleRows] = useState(INITIAL_GROUP_ROWS);
  const [issues, setIssues] = useState<{ items: ImportIssue[]; next: string | null; loading: boolean } | null>(null);
  /** One owner per mount; created in the effect so a remount gets a fresh one. */
  const ownerRef = useRef<FolderImportJobOwner | null>(null);
  const [importing, setImporting] = useState(false);
  const mountedRef = useRef(true);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  useEffect(() => {
    mountedRef.current = true;
    const owner = new FolderImportJobOwner(port);
    ownerRef.current = owner;
    return () => {
      mountedRef.current = false;
      // Scan/preview: cancel + dispose now. Import: request cancel, release after it settles.
      void owner.close();
    };
  }, [port]);

  const set = (next: Phase) => {
    if (mountedRef.current) setPhase(next);
  };

  const scan = phase.kind === "preview" || phase.kind === "listing" || phase.kind === "empty" ? phase.scan : null;
  const activeFolders = useMemo(() => activeFoldersOf(props.organization), [props.organization]);
  /** Book counts tell same-name folders apart in the target list. */
  const folderBookCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hash of Object.keys(props.organization.books)) {
      const folderId = effectiveFolderId(props.organization, hash);
      if (folderId) counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
    return counts;
  }, [props.organization]);
  const folderLabel = (folder: ActiveFolder) => {
    const count = folderBookCounts.get(folder.folderId) ?? 0;
    return tn("folderImport.target.existing", count, { name: folder.name, count });
  };
  const plan = useMemo(
    () => (scan ? planDirectoryImport(scan.root, items, options) : null),
    [scan, items, options],
  );
  const resolutions = useMemo(
    () => (plan ? resolveGroups(plan.groups, activeFolders, bindings) : []),
    [plan, activeFolders, bindings],
  );
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let loose = 0;
    for (const input of plan?.inputs ?? []) {
      if (input.groupKey === null) loose++;
      else counts.set(input.groupKey, (counts.get(input.groupKey) ?? 0) + 1);
    }
    return { counts, loose };
  }, [plan]);
  const hasLooseAndCategories = useMemo(
    () => items.some((item) => item.relativeParentSegments.length > 0)
      && items.some((item) => item.relativeParentSegments.length === 0),
    [items],
  );
  const unresolved = plan
    ? plan.groups.filter((group, index) => !(choices[group.groupKey] ?? defaultGroupChoice(resolutions[index])))
    : [];
  /** Rows that still need a choice come first, so folding never hides them. */
  const groupRows = useMemo(() => {
    if (!plan) return [];
    const rows = plan.groups.map((group, index) => ({ group, resolution: resolutions[index] }));
    const needsChoice = (row: (typeof rows)[number]) => row.resolution.kind === "choose";
    return [...rows.filter(needsChoice), ...rows.filter((row) => !needsChoice(row))];
  }, [plan, resolutions]);

  const pickAndScan = async () => {
    const owner = ownerRef.current;
    if (!owner || owner.isImporting) return;
    setItems([]);
    setBindings([]);
    setChoices({});
    setVisibleRows(INITIAL_GROUP_ROWS);
    setIssues(null);
    set({ kind: "scanning", found: 0 });
    let token: number | undefined;
    try {
      token = await owner.beginScan();
      if (!owner.isLive(token)) return;
      const scanToken = token;
      const result = await port.scan((event) => {
        // The first event already names the job, so closing mid-scan can cancel it.
        if (owner.adopt(scanToken, event.jobId)) set({ kind: "scanning", found: event.scannedInputs });
      });
      if (!result) {
        if (owner.isLive(token)) set({ kind: "intro" });
        return;
      }
      // A superseded or closed scan's job is only cleaned up.
      if (!owner.adopt(token, result.jobId)) return;
      if (result.inputCount === 0) {
        set({ kind: "empty", scan: result });
        return;
      }
      set({ kind: "listing", scan: result, loaded: 0 });
      const collected: ScannedEpub[] = [];
      const bound = new Map<string, DirectoryBinding>();
      let cursor: string | undefined;
      do {
        const page = await port.page(result.jobId, cursor);
        collected.push(...page.items);
        for (const binding of page.bindings) bound.set(binding.groupKey, binding);
        cursor = page.nextCursor ?? undefined;
        set({ kind: "listing", scan: result, loaded: collected.length });
      } while (cursor !== undefined && owner.isLive(token, result.jobId));
      if (!owner.isLive(token, result.jobId)) return;
      setItems(collected);
      setBindings([...bound.values()]);
      set(collected.length === 0 ? { kind: "empty", scan: result } : { kind: "preview", scan: result });
    } catch (error) {
      if (token === undefined || !owner.isLive(token)) return;
      void owner.releaseCurrent();
      set({ kind: "error", message: uiText("folderImport.scanFailed", { error: errorText(error) }) });
    }
  };

  const startImport = () => {
    const owner = ownerRef.current;
    if (!owner || !plan) return;
    const targets = buildFolderTargets(plan.groups, resolutions, choices);
    if (!targets) return;
    const started = owner.run({ options, targets }, {
      onProgress: (event) => {
        if (!mountedRef.current) return;
        setPhase((current) => (current.kind === "importing" ? { ...current, progress: event } : current));
      },
      onResult: (result) => {
        callbacksRef.current.onImported?.(result);
        set({ kind: "done", result });
      },
      onError: (error) => {
        set({ kind: "error", message: uiText("folderImport.importFailed", { error: errorText(error) }) });
      },
      onSettled: () => {
        if (mountedRef.current) setImporting(false);
        callbacksRef.current.onSettled();
      },
    });
    if (!started) return;
    setImporting(true);
    set({ kind: "importing", progress: null, cancel: "none" });
  };

  const cancelImport = async () => {
    const owner = ownerRef.current;
    if (!owner) return;
    const status = await owner.cancel();
    if (!mountedRef.current) return;
    setPhase((current) => current.kind === "importing"
      ? { ...current, cancel: status === "settling" ? "settling" : status === "requested" ? "requested" : current.cancel }
      : current);
  };

  const loadIssues = async () => {
    const jobId = ownerRef.current?.currentJobId;
    if (!jobId) return;
    const cursor = issues?.next ?? undefined;
    setIssues((current) => ({ items: current?.items ?? [], next: current?.next ?? null, loading: true }));
    try {
      const page = await port.issues(jobId, cursor);
      if (!mountedRef.current) return;
      setIssues((current) => ({ items: [...(current?.items ?? []), ...page.items], next: page.nextCursor, loading: false }));
    } catch {
      if (mountedRef.current) setIssues((current) => current && { ...current, loading: false });
    }
  };

  const close = async () => {
    if (importing) return;
    await ownerRef.current?.close();
    props.onClose();
  };

  const closeRef = useRef(close);
  closeRef.current = close;
  const initialCloseSignal = useRef(props.closeSignal);
  useEffect(() => {
    if (props.closeSignal === initialCloseSignal.current) return;
    initialCloseSignal.current = props.closeSignal;
    closeRef.current();
  }, [props.closeSignal]);

  const setChoice = (groupKey: string, value: string) => {
    setChoices((current) => ({
      ...current,
      [groupKey]: value === "__create" ? { kind: "create" } : { kind: "reuse", folderId: value },
    }));
  };

  const rootName = scan?.root.name ?? "";

  return (
    <div className="save-file-backdrop" role="presentation">
      <section className="save-file-dialog folder-import-dialog" role="dialog" aria-modal="true" aria-label={t("folderImport.dialog")}>
        <header className="save-file-dialog-head">
          <h2>{t("folderImport.title")}</h2>
          <p>{t("folderImport.subtitle")}</p>
        </header>

        {phase.kind === "intro" && (
          <div className="save-file-dialog-body">
            {props.directorySelectionSupported === false ? (
              <p className="save-file-muted">{t("folderImport.unsupported")}</p>
            ) : (
              <p className="save-file-muted">{t("folderImport.intro")}</p>
            )}
          </div>
        )}

        {phase.kind === "scanning" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-status">{phase.found > 0 ? tn("folderImport.scanning.found", phase.found, { count: phase.found }) : t("folderImport.scanning")}</p>
          </div>
        )}

        {phase.kind === "listing" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-status">{t("folderImport.listing", { loaded: phase.loaded, total: phase.scan.inputCount })}</p>
          </div>
        )}

        {phase.kind === "empty" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-status">{t("folderImport.empty", { name: phase.scan.root.name })}</p>
            <ScanNotes scan={phase.scan} />
          </div>
        )}

        {phase.kind === "preview" && plan && (
          <div className="save-file-dialog-body">
            <dl className="save-file-summary">
              <div><dt>{t("folderImport.candidates")}</dt><dd>{tn("folderImport.candidates.count", items.length, { count: items.length })}</dd></div>
              <div><dt>{t("folderImport.shelfFolders")}</dt><dd>{tn("folderImport.shelfFolders.count", plan.groups.length, { count: plan.groups.length })}</dd></div>
            </dl>
            <ScanNotes scan={phase.scan} />
            {plan.flattened && (
              <p className="save-file-muted">{t("folderImport.flattened")}</p>
            )}

            <fieldset className="save-file-fieldset">
              <legend>{t("folderImport.grouping")}</legend>
              {([
                ["auto", t("folderImport.grouping.auto"), t("folderImport.grouping.auto.hint")],
                ["singleFolder", t("folderImport.grouping.single", { name: rootName }), t("folderImport.grouping.single.hint")],
                ["none", t("folderImport.grouping.none"), t("folderImport.grouping.none.hint")],
              ] as const).map(([value, label, hint]) => (
                <label key={value} className="save-file-radio">
                  <input
                    type="radio"
                    name="folder-import-grouping"
                    checked={options.grouping === value}
                    onChange={() => setOptions({ ...options, grouping: value })}
                  />
                  <span>{label}<span className="folder-import-hint">{hint}</span></span>
                </label>
              ))}
            </fieldset>

            {options.grouping === "auto" && hasLooseAndCategories && (
              <fieldset className="save-file-fieldset">
                <legend>{t("folderImport.loose", { name: rootName })}</legend>
                <label className="save-file-radio">
                  <input
                    type="radio"
                    name="folder-import-loose"
                    checked={options.looseRootBooks === "root"}
                    onChange={() => setOptions({ ...options, looseRootBooks: "root" })}
                  />
                  <span>{t("folderImport.loose.unclassified")}</span>
                </label>
                <label className="save-file-radio">
                  <input
                    type="radio"
                    name="folder-import-loose"
                    checked={options.looseRootBooks === "namedFolder"}
                    onChange={() => setOptions({ ...options, looseRootBooks: "namedFolder" })}
                  />
                  <span>{t("folderImport.loose.namedFolder", { name: rootName })}</span>
                </label>
              </fieldset>
            )}

            {options.grouping !== "none" && (
              <fieldset className="save-file-fieldset">
                <legend>{t("folderImport.existing")}</legend>
                {([
                  ["fillUnclassified", t("folderImport.existing.fill"), t("folderImport.existing.fill.hint")],
                  ["preserveAll", t("folderImport.existing.preserve"), t("folderImport.existing.preserve.hint")],
                  ["replace", t("folderImport.existing.replace"), t("folderImport.existing.replace.hint")],
                ] as const).map(([value, label, hint]) => (
                  <label key={value} className="save-file-radio">
                    <input
                      type="radio"
                      name="folder-import-existing"
                      checked={options.existingPlacement === value}
                      onChange={() => setOptions({ ...options, existingPlacement: value })}
                    />
                    <span>{label}<span className="folder-import-hint">{hint}</span></span>
                  </label>
                ))}
              </fieldset>
            )}

            {plan.groups.length > 0 && (
              <div className="folder-import-groups">
                <div className="folder-import-groups-head">
                  <span>{t("folderImport.folders")}</span>
                  {groupCounts.loose > 0 && <span className="folder-import-hint">{tn("folderImport.looseCount", groupCounts.loose, { count: groupCounts.loose })}</span>}
                </div>
                {unresolved.length > 0 && (
                  <p className="folder-import-warning">{tn("folderImport.unresolved", unresolved.length, { count: unresolved.length })}</p>
                )}
                <ul>
                  {groupRows.slice(0, visibleRows).map(({ group, resolution }) => {
                    const choice = choices[group.groupKey] ?? defaultGroupChoice(resolution);
                    const value = !choice ? "" : choice.kind === "create" ? "__create" : choice.folderId;
                    const createName = resolution.kind === "create" ? resolution.name : group.suggestedName;
                    const candidates = resolution.kind === "choose" ? resolution.candidates : [];
                    const others = activeFolders.filter((folder) => !candidates.some((c) => c.folderId === folder.folderId));
                    return (
                      <li key={group.groupKey} className={choice ? "" : "is-unresolved"}>
                        <div className="folder-import-group-name">
                          <strong>{group.suggestedName}</strong>
                          <span className="folder-import-hint" title={[rootName, ...group.sourceSegments].join(" / ")}>
                            {tn("folderImport.groupPath", groupCounts.counts.get(group.groupKey) ?? 0, { path: [rootName, ...group.sourceSegments].join(" / "), count: groupCounts.counts.get(group.groupKey) ?? 0 })}
                          </span>
                        </div>
                        <select
                          aria-label={t("folderImport.groupTarget", { name: group.suggestedName })}
                          value={value}
                          onChange={(event) => setChoice(group.groupKey, event.target.value)}
                        >
                          {!choice && <option value="" disabled>{t("folderImport.choose")}</option>}
                          {candidates.map((folder) => (
                            <option key={folder.folderId} value={folder.folderId}>{folderLabel(folder)}</option>
                          ))}
                          <option value="__create">
                            {resolution.kind === "create" ? t("folderImport.create", { name: createName }) : t("folderImport.createSameName", { name: createName })}
                          </option>
                          {others.map((folder) => (
                            <option key={folder.folderId} value={folder.folderId}>{folderLabel(folder)}</option>
                          ))}
                        </select>
                      </li>
                    );
                  })}
                </ul>
                {plan.groups.length > visibleRows && (
                  <button type="button" className="folder-import-more" onClick={() => setVisibleRows(visibleRows + MORE_GROUP_ROWS)}>
                    {t("folderImport.showMore", { count: plan.groups.length - visibleRows })}
                  </button>
                )}
              </div>
            )}
            <p className="save-file-muted">{t("folderImport.duplicatesNote")}</p>
          </div>
        )}

        {phase.kind === "importing" && (
          <div className="save-file-dialog-body">
            <ImportProgress progress={phase.progress} />
            {phase.cancel === "settling" && <p className="folder-import-warning">{t("folderImport.settling")}</p>}
            {phase.cancel === "requested" && <p className="save-file-muted">{t("folderImport.stopping")}</p>}
          </div>
        )}

        {phase.kind === "done" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-status">
              {phase.result.status === "cancelled" ? t("folderImport.done.cancelled") : phase.result.status === "failed" ? t("folderImport.done.failed") : t("folderImport.done.ok")}
            </p>
            <dl className="save-file-summary">
              <div><dt>{t("folderImport.result.imported")}</dt><dd>{phase.result.counts.imported}</dd></div>
              <div><dt>{t("folderImport.result.duplicates")}</dt><dd>{phase.result.counts.duplicates}</dd></div>
              <div><dt>{t("folderImport.result.failed")}</dt><dd>{phase.result.counts.failed}</dd></div>
              <div><dt>{t("folderImport.result.unplaced")}</dt><dd>{phase.result.counts.placementSkipped}</dd></div>
              <div><dt>{t("folderImport.result.createdFolders")}</dt><dd>{phase.result.counts.createdFolders}</dd></div>
              <div><dt>{t("folderImport.result.completed")}</dt><dd>{phase.result.counts.completed}</dd></div>
            </dl>
            {phase.result.issueCount > 0 && (
              issues === null ? (
                <button type="button" className="folder-import-more" onClick={() => void loadIssues()}>
                  {t("folderImport.issues", { count: phase.result.issueCount })}
                </button>
              ) : (
                <div className="folder-import-issues">
                  <ul>
                    {issues.items.map((item, index) => (
                      <li key={`${item.inputId}-${index}`}>{item.message}</li>
                    ))}
                  </ul>
                  {issues.next !== null && (
                    <button type="button" className="folder-import-more" disabled={issues.loading} onClick={() => void loadIssues()}>
                      {issues.loading ? t("folderImport.loading") : t("folderImport.loadMore")}
                    </button>
                  )}
                </div>
              )
            )}
          </div>
        )}

        {phase.kind === "error" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-warning">{phase.message}</p>
          </div>
        )}

        <footer className="save-file-dialog-actions">
          {phase.kind === "importing" ? (
            <button type="button" disabled={phase.cancel !== "none"} onClick={() => void cancelImport()}>{t("folderImport.stop")}</button>
          ) : phase.kind === "scanning" || phase.kind === "listing" ? (
            <button type="button" onClick={close}>{t("folderImport.cancel")}</button>
          ) : phase.kind === "preview" ? (
            <>
              <button type="button" onClick={close}>{t("folderImport.cancel")}</button>
              <button type="button" onClick={() => void pickAndScan()}>{t("folderImport.rechoose")}</button>
              <button type="button" className="primary" disabled={unresolved.length > 0} onClick={startImport}>
                {t("folderImport.start")}
              </button>
            </>
          ) : phase.kind === "done" ? (
            <button type="button" className="primary" onClick={close}>{t("folderImport.done")}</button>
          ) : (
            <>
              <button type="button" onClick={close}>{t("folderImport.close")}</button>
              {props.directorySelectionSupported === false ? (
                props.onUseFileImport && (
                  <button type="button" className="primary" onClick={async () => { await close(); props.onUseFileImport?.(); }}>
                    {t("folderImport.useFiles")}
                  </button>
                )
              ) : (
                <button type="button" className="primary" onClick={() => void pickAndScan()}>
                  {phase.kind === "intro" ? t("folderImport.chooseFolder") : t("folderImport.rechoose")}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function ScanNotes({ scan }: { scan: ScanResult }) {
  const { t } = useUiText();
  if (scan.skippedDirectoryCount === 0 && scan.unreadableDirectoryCount === 0) return null;
  return (
    <p className="save-file-muted">
      {scan.unreadableDirectoryCount > 0 && t("folderImport.unreadable", { count: scan.unreadableDirectoryCount })}
      {scan.skippedDirectoryCount > 0 && t("folderImport.skippedLinks", { count: scan.skippedDirectoryCount })}
    </p>
  );
}

function ImportProgress({ progress }: { progress: DirectoryProgress | null }) {
  const { t } = useUiText();
  if (!progress) return <p className="folder-import-status">{t("folderImport.preparing")}</p>;
  const total = progress.totalInputs;
  const pct = total !== null && total > 0 ? Math.min(100, Math.round((progress.counts.completed / total) * 100)) : null;
  const { counts } = progress;
  return (
    <div className="folder-import-progress">
      <p className="folder-import-status">
        {t(PHASE_LABEL[progress.phase])}
        {total !== null ? t("folderImport.progress.of", { completed: counts.completed, total }) : t("folderImport.progress.processed", { completed: counts.completed })}
      </p>
      {pct !== null && (
        <div className="folder-import-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="save-file-muted">
        {t("folderImport.progress.counts", { imported: counts.imported, duplicates: counts.duplicates, failed: counts.failed })}
        {counts.placementSkipped > 0 ? t("folderImport.progress.unplaced", { count: counts.placementSkipped }) : ""}
      </p>
    </div>
  );
}
