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

const PHASE_LABEL: Record<DirectoryProgress["phase"], string> = {
  scanning: "正在扫描",
  preparing: "正在读取书籍",
  committing: "正在保存当前批次",
  cleaning: "正在清理",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function FolderImportPanel(props: FolderImportPanelProps) {
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
  const folderLabel = (folder: ActiveFolder) => `放入已有「${folder.name}」（${folderBookCounts.get(folder.folderId) ?? 0} 本）`;
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
      set({ kind: "error", message: `扫描失败：${errorText(error)}` });
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
        set({ kind: "error", message: `导入失败：${errorText(error)}。已完成的书仍保留在书架。` });
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
      <section className="save-file-dialog folder-import-dialog" role="dialog" aria-modal="true" aria-label="导入文件夹">
        <header className="save-file-dialog-head">
          <h2>导入文件夹</h2>
          <p>选择一个系统文件夹，自动找出其中的 EPUB，并按目录整理到书架文件夹。只读取，不改动原文件。</p>
        </header>

        {phase.kind === "intro" && (
          <div className="save-file-dialog-body">
            {props.directorySelectionSupported === false ? (
              <p className="save-file-muted">当前环境不支持选择文件夹。可以用「导入图书」一次多选文件，但不会保留目录关系。</p>
            ) : (
              <p className="save-file-muted">扫描只读取文件名和目录，不读正文；确认一次后开始导入，可随时停止，已完成的书会保留。</p>
            )}
          </div>
        )}

        {phase.kind === "scanning" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-status">正在扫描文件夹…{phase.found > 0 ? `已发现 ${phase.found} 本` : ""}</p>
          </div>
        )}

        {phase.kind === "listing" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-status">正在整理清单 {phase.loaded} / {phase.scan.inputCount}</p>
          </div>
        )}

        {phase.kind === "empty" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-status">「{phase.scan.root.name}」中未找到 EPUB。</p>
            <ScanNotes scan={phase.scan} />
          </div>
        )}

        {phase.kind === "preview" && plan && (
          <div className="save-file-dialog-body">
            <dl className="save-file-summary">
              <div><dt>EPUB 候选</dt><dd>{items.length} 本</dd></div>
              <div><dt>书架文件夹</dt><dd>{plan.groups.length} 个</dd></div>
            </dl>
            <ScanNotes scan={phase.scan} />
            {plan.flattened && (
              <p className="save-file-muted">深层目录已展开：书架只保留一层，文件夹名带上级目录，例如「分类 · 子分类」。</p>
            )}

            <fieldset className="save-file-fieldset">
              <legend>整理方式</legend>
              {([
                ["auto", "按目录整理", "每个目录对应一个书架文件夹"],
                ["singleFolder", `统一放入「${rootName}」`, "所有书放进一个同名文件夹"],
                ["none", "不自动分类", "只导入书籍，不创建文件夹"],
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
                <legend>「{rootName}」直属的书</legend>
                <label className="save-file-radio">
                  <input
                    type="radio"
                    name="folder-import-loose"
                    checked={options.looseRootBooks === "root"}
                    onChange={() => setOptions({ ...options, looseRootBooks: "root" })}
                  />
                  <span>留在未分类</span>
                </label>
                <label className="save-file-radio">
                  <input
                    type="radio"
                    name="folder-import-loose"
                    checked={options.looseRootBooks === "namedFolder"}
                    onChange={() => setOptions({ ...options, looseRootBooks: "namedFolder" })}
                  />
                  <span>放入「{rootName}」文件夹</span>
                </label>
              </fieldset>
            )}

            {options.grouping !== "none" && (
              <fieldset className="save-file-fieldset">
                <legend>书架里已有的书</legend>
                {([
                  ["fillUnclassified", "只整理未分类的已有书", "已在文件夹里的书保持不动（推荐）"],
                  ["preserveAll", "保留已有归属", "已有的书一律不移动"],
                  ["replace", "按此次目录调整", "已有的书也按目录移动"],
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
                  <span>文件夹</span>
                  {groupCounts.loose > 0 && <span className="folder-import-hint">另有 {groupCounts.loose} 本留在未分类</span>}
                </div>
                {unresolved.length > 0 && (
                  <p className="folder-import-warning">有 {unresolved.length} 个文件夹与书架上多个同名文件夹对应，请为它们选择目标。</p>
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
                            {[rootName, ...group.sourceSegments].join(" / ")} · {groupCounts.counts.get(group.groupKey) ?? 0} 本
                          </span>
                        </div>
                        <select
                          aria-label={`${group.suggestedName} 的目标文件夹`}
                          value={value}
                          onChange={(event) => setChoice(group.groupKey, event.target.value)}
                        >
                          {!choice && <option value="" disabled>请选择…</option>}
                          {candidates.map((folder) => (
                            <option key={folder.folderId} value={folder.folderId}>{folderLabel(folder)}</option>
                          ))}
                          <option value="__create">
                            {resolution.kind === "create" ? `新建「${createName}」` : `新建同名「${createName}」`}
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
                    显示更多（还有 {plan.groups.length - visibleRows} 个）
                  </button>
                )}
              </div>
            )}
            <p className="save-file-muted">书数为候选数量；重复的书会在导入时按内容识别，进度、笔记、书签和收藏都会保留。</p>
          </div>
        )}

        {phase.kind === "importing" && (
          <div className="save-file-dialog-body">
            <ImportProgress progress={phase.progress} />
            {phase.cancel === "settling" && <p className="folder-import-warning">正在完成当前批次，之后停止。已完成的书会保留。</p>}
            {phase.cancel === "requested" && <p className="save-file-muted">正在停止，已完成的书会保留。</p>}
          </div>
        )}

        {phase.kind === "done" && (
          <div className="save-file-dialog-body">
            <p className="folder-import-status">
              {phase.result.status === "cancelled" ? "已停止导入，已完成的书保留在书架。" : phase.result.status === "failed" ? "导入未全部完成，已完成的书保留在书架。" : "导入完成。"}
            </p>
            <dl className="save-file-summary">
              <div><dt>新增</dt><dd>{phase.result.counts.imported}</dd></div>
              <div><dt>重复</dt><dd>{phase.result.counts.duplicates}</dd></div>
              <div><dt>失败</dt><dd>{phase.result.counts.failed}</dd></div>
              <div><dt>未归档</dt><dd>{phase.result.counts.placementSkipped}</dd></div>
              <div><dt>新建文件夹</dt><dd>{phase.result.counts.createdFolders}</dd></div>
              <div><dt>已处理</dt><dd>{phase.result.counts.completed}</dd></div>
            </dl>
            {phase.result.issueCount > 0 && (
              issues === null ? (
                <button type="button" className="folder-import-more" onClick={() => void loadIssues()}>
                  查看问题（{phase.result.issueCount}）
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
                      {issues.loading ? "正在加载…" : "加载更多"}
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
            <button type="button" disabled={phase.cancel !== "none"} onClick={() => void cancelImport()}>停止导入</button>
          ) : phase.kind === "scanning" || phase.kind === "listing" ? (
            <button type="button" onClick={close}>取消</button>
          ) : phase.kind === "preview" ? (
            <>
              <button type="button" onClick={close}>取消</button>
              <button type="button" onClick={() => void pickAndScan()}>重新选择</button>
              <button type="button" className="primary" disabled={unresolved.length > 0} onClick={startImport}>
                开始导入
              </button>
            </>
          ) : phase.kind === "done" ? (
            <button type="button" className="primary" onClick={close}>完成</button>
          ) : (
            <>
              <button type="button" onClick={close}>关闭</button>
              {props.directorySelectionSupported === false ? (
                props.onUseFileImport && (
                  <button type="button" className="primary" onClick={async () => { await close(); props.onUseFileImport?.(); }}>
                    多选文件导入
                  </button>
                )
              ) : (
                <button type="button" className="primary" onClick={() => void pickAndScan()}>
                  {phase.kind === "intro" ? "选择文件夹" : "重新选择"}
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
  if (scan.skippedDirectoryCount === 0 && scan.unreadableDirectoryCount === 0) return null;
  return (
    <p className="save-file-muted">
      {scan.unreadableDirectoryCount > 0 && `${scan.unreadableDirectoryCount} 个目录无法读取，预览只包含已访问的部分。`}
      {scan.skippedDirectoryCount > 0 && `已跳过 ${scan.skippedDirectoryCount} 个链接目录。`}
    </p>
  );
}

function ImportProgress({ progress }: { progress: DirectoryProgress | null }) {
  if (!progress) return <p className="folder-import-status">正在准备…</p>;
  const total = progress.totalInputs;
  const pct = total !== null && total > 0 ? Math.min(100, Math.round((progress.counts.completed / total) * 100)) : null;
  const { counts } = progress;
  return (
    <div className="folder-import-progress">
      <p className="folder-import-status">
        {PHASE_LABEL[progress.phase]}
        {total !== null ? ` · ${counts.completed} / ${total}` : ` · 已处理 ${counts.completed}`}
      </p>
      {pct !== null && (
        <div className="folder-import-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="save-file-muted">
        新增 {counts.imported} · 重复 {counts.duplicates} · 失败 {counts.failed}
        {counts.placementSkipped > 0 ? ` · 未归档 ${counts.placementSkipped}` : ""}
      </p>
    </div>
  );
}
