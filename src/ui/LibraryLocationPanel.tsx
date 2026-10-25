import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  cancelLibraryLocation,
  LibraryLocationError,
  planLibraryLocation,
  recoverLibraryLocation,
  startLibraryLocation,
  type LibraryLocationMode,
  type LibraryLocationPlan,
  type LibraryLocationProgress,
  type LibraryLocationResult,
} from "../platform/libraryLocationBridge";
import { formatBytes } from "./CacheStoragePanel";
import { displayPath, refreshLibrarySettings, type LibrarySettingsView } from "./librarySettings";
import { uiText, useUiText } from "./localization/UiLanguageProvider";
import type { PlainMessageKey } from "./localization/core";
import "./cacheStoragePanel.css";
import "./libraryLocationPanel.css";

export interface LibraryLocationPanelProps {
  open: boolean;
  library: LibrarySettingsView;
  /** A book is open or another task runs: nothing may start (the backend refuses too). */
  blocked: boolean;
  /** After anything that may have moved books: the host re-reads the shelf. */
  onChanged(): void;
  /** True while a change runs: the host's Esc/back then does nothing (and never closes this). */
  onRunningChange?(running: boolean): void;
  onClose(): void;
}

/** What the confirmation is for: a chosen folder, or null for the default location. */
interface Target {
  readonly baseDirectory: string | null;
  readonly mode: LibraryLocationMode;
}

type Step =
  | { readonly kind: "idle" }
  | { readonly kind: "planning"; readonly target: Target }
  | { readonly kind: "confirm"; readonly target: Target; readonly plan: LibraryLocationPlan }
  | {
    readonly kind: "running";
    readonly target: Target | null;
    readonly jobId: string | null;
    readonly progress: LibraryLocationProgress | null;
    readonly cancel: "none" | "requested" | "too-late";
  }
  | { readonly kind: "done"; readonly target: Target | null; readonly result: LibraryLocationResult };

const ERROR_KEYS: Record<string, PlainMessageKey> = {
  busy: "libraryLocation.error.busy",
  "unsupported-platform": "libraryLocation.error.unsupported-platform",
  "invalid-request": "libraryLocation.error.invalid-request",
  "library-folder-unavailable": "libraryLocation.error.library-folder-unavailable",
  "library-target-overlap": "libraryLocation.error.library-target-overlap",
  "library-target-not-empty": "libraryLocation.error.library-target-not-empty",
  "library-insufficient-space": "libraryLocation.error.library-insufficient-space",
  "library-verification-failed": "libraryLocation.error.library-verification-failed",
  "library-recovery-required": "libraryLocation.error.library-recovery-required",
};

function errorText(error: unknown): string {
  if (error instanceof LibraryLocationError && ERROR_KEYS[error.code]) return uiText(ERROR_KEYS[error.code]);
  return uiText("libraryLocation.error.other", { error: error instanceof Error ? error.message : String(error) });
}

function resultText(target: Target | null, result: LibraryLocationResult): string {
  const dir = displayPath(result.libraryDirectory);
  if (result.status === "cancelled") return uiText("libraryLocation.done.cancelled");
  if (result.status === "cleanup-pending") return uiText("libraryLocation.done.cleanup", { dir });
  if (!target) return uiText("libraryLocation.done.recover");
  return target.mode === "reconnect" ? uiText("libraryLocation.done.reconnect", { dir }) : uiText("libraryLocation.done.move", { dir });
}

const PHASE_KEYS = {
  copying: "libraryLocation.phase.copying",
  verifying: "libraryLocation.phase.verifying",
  committing: "libraryLocation.phase.committing",
  cleaning: "libraryLocation.phase.cleaning",
} as const satisfies Record<LibraryLocationProgress["phase"], PlainMessageKey>;

/**
 * A34 P2: move the library's EPUB copies, reconnect an existing library, or
 * finish a change that was cut short. Native code redoes every check at
 * start and owns the single switch point; this panel only shows the plan,
 * the progress and the outcome, and re-reads settings after every attempt
 * (an error does not prove nothing switched).
 */
export function LibraryLocationPanel(props: LibraryLocationPanelProps) {
  const { t, tn } = useUiText();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const running = step.kind === "running";
  useEffect(() => {
    if (!props.open) {
      setStep({ kind: "idle" });
      setError(null);
    }
  }, [props.open]);
  // Esc and Android back come from the host's level dispatch, which asks this first.
  useEffect(() => {
    callbacksRef.current.onRunningChange?.(running);
  }, [running]);

  const settle = () => {
    void refreshLibrarySettings();
    callbacksRef.current.onChanged();
  };
  const show = (next: Step) => { if (mountedRef.current) setStep(next); };

  const plan = async (target: Target) => {
    setError(null);
    setStep({ kind: "planning", target });
    try {
      show({ kind: "confirm", target, plan: await planLibraryLocation(target.baseDirectory, target.mode) });
    } catch (reason) {
      show({ kind: "idle" });
      if (mountedRef.current) setError(errorText(reason));
    }
  };

  const pickAndPlan = async (mode: LibraryLocationMode) => {
    setError(null);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: uiText(mode === "move" ? "libraryLocation.pick.move" : "libraryLocation.pick.reconnect"),
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (path) await plan({ baseDirectory: path, mode });
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const run = async (target: Target | null) => {
    setError(null);
    const jobId = target ? crypto.randomUUID() : null;
    setStep({ kind: "running", target, jobId, progress: null, cancel: "none" });
    try {
      const result = target
        ? await startLibraryLocation(jobId!, target.baseDirectory, target.mode, (progress) => {
          if (mountedRef.current) setStep((current) => current.kind === "running" ? { ...current, progress } : current);
        })
        : await recoverLibraryLocation();
      show({ kind: "done", target, result });
    } catch (reason) {
      show({ kind: "idle" });
      if (mountedRef.current) setError(errorText(reason));
    } finally {
      settle();
    }
  };

  const cancel = async () => {
    if (step.kind !== "running" || !step.jobId || step.cancel !== "none") return;
    const status = await cancelLibraryLocation(step.jobId).catch(() => "not-running" as const);
    // The start result stays the outcome; this only says whether the request was taken.
    if (status === "not-running" || !mountedRef.current) return;
    setStep((current) => current.kind === "running" ? { ...current, cancel: status === "too-late" ? "too-late" : "requested" } : current);
  };

  if (!props.open) return null;
  const { library } = props;
  const idleDisabled = props.blocked || step.kind !== "idle";
  const confirmTitle = (target: Target) => target.mode === "reconnect" ? t("libraryLocation.confirm.reconnect")
    : target.baseDirectory === null ? t("libraryLocation.confirm.default") : t("libraryLocation.confirm.move");

  return (
    <div className="cache-storage-layer" role="presentation">
      <div className="cache-storage-backdrop" aria-hidden="true" onClick={running ? undefined : props.onClose} />
      <section className="cache-storage-panel library-location-panel" role="dialog" aria-modal="true" aria-label={t("libraryLocation.title")}>
        <header className="cache-storage-head">
          <div>
            <h2>{t("libraryLocation.title")}</h2>
            <p>{t("libraryLocation.subtitle")}</p>
          </div>
          <button type="button" className="tb-btn" onClick={props.onClose} disabled={running}>{t("libraryLocation.close")}</button>
        </header>

        {error && <div className="cache-storage-alert is-error" role="alert">{error}</div>}
        {!library.available && library.customBaseDirectory !== null && (
          <div className="cache-storage-alert is-warn" role="status">{t("libraryLocation.unavailable")}</div>
        )}
        {library.recoveryPending && (step.kind === "idle" || step.kind === "planning") && (
          <div className="cache-storage-alert is-warn library-location-recovery" role="status">
            <span>{t("libraryLocation.recovery")}</span>
            <button type="button" className="tb-btn" disabled={idleDisabled} onClick={() => void run(null)}>{t("libraryLocation.recover")}</button>
          </div>
        )}

        <dl className="cache-storage-paths">
          <div>
            <dt>{t("libraryLocation.current")}</dt>
            <dd className="cache-storage-path" title={displayPath(library.libraryDirectory)}>{displayPath(library.libraryDirectory) || "—"}</dd>
          </div>
        </dl>
        {library.customBaseDirectory === null && <p className="cache-storage-hint">{t("libraryLocation.default")}</p>}

        {(step.kind === "idle" || step.kind === "planning") && (
          <>
            {props.blocked && <div className="cache-storage-alert is-notice" role="status">{t("libraryLocation.blocked")}</div>}
            <div className="cache-storage-actions">
              <button type="button" className="tb-btn" disabled={idleDisabled} onClick={() => void pickAndPlan("move")}>{t("libraryLocation.move")}</button>
              <button type="button" className="tb-btn" disabled={idleDisabled} onClick={() => void pickAndPlan("reconnect")}>{t("libraryLocation.reconnect")}</button>
              <button type="button" className="tb-btn" disabled={idleDisabled || library.customBaseDirectory === null}
                onClick={() => void plan({ baseDirectory: null, mode: "move" })}>{t("libraryLocation.restoreDefault")}</button>
            </div>
            {step.kind === "planning" && <div className="cache-storage-loading">{t("libraryLocation.planning")}</div>}
            <p className="cache-storage-hint">{t("libraryLocation.actions.hint")}</p>
          </>
        )}

        {step.kind === "confirm" && (
          <div className="cache-storage-category library-location-confirm">
            <h3>{confirmTitle(step.target)}</h3>
            <dl className="cache-storage-paths">
              <div><dt>{t("libraryLocation.from")}</dt><dd className="cache-storage-path" title={displayPath(step.plan.sourceDirectory)}>{displayPath(step.plan.sourceDirectory)}</dd></div>
              <div><dt>{t("libraryLocation.to")}</dt><dd className="cache-storage-path" title={displayPath(step.plan.targetDirectory)}>{displayPath(step.plan.targetDirectory)}</dd></div>
              <div><dt>{t("libraryLocation.books")}</dt><dd>{tn("libraryLocation.books.count", step.plan.bookCount, { count: step.plan.bookCount })}</dd></div>
              <div><dt>{t("libraryLocation.size")}</dt><dd>{formatBytes(step.plan.totalBytes)}</dd></div>
              {step.target.mode === "move" && (
                <div><dt>{t("libraryLocation.free")}</dt><dd>{formatBytes(step.plan.availableBytes)}</dd></div>
              )}
            </dl>
            <p className="cache-storage-hint">{t(step.target.mode === "reconnect" ? "libraryLocation.hint.reconnect" : "libraryLocation.hint.move")}</p>
            {step.target.baseDirectory !== null && <p className="cache-storage-hint">{t("libraryLocation.hint.offline")}</p>}
            <div className="cache-storage-actions">
              <button type="button" className="tb-btn" disabled={props.blocked} onClick={() => void run(step.target)}>{t("libraryLocation.start")}</button>
              <button type="button" className="tb-btn" onClick={() => setStep({ kind: "idle" })}>{t("libraryLocation.back")}</button>
            </div>
          </div>
        )}

        {step.kind === "running" && (
          <div className="cache-storage-category library-location-running" role="status">
            <h3>{step.target ? t(PHASE_KEYS[step.progress?.phase ?? "copying"]) : t("libraryLocation.recovering")}</h3>
            {step.progress && (
              <>
                <progress max={Math.max(step.progress.totalBytes, 1)} value={step.progress.completedBytes} />
                <p className="library-location-muted">{t("libraryLocation.progress", {
                  done: step.progress.completedBooks,
                  total: step.progress.totalBooks,
                  bytes: `${formatBytes(step.progress.completedBytes)} / ${formatBytes(step.progress.totalBytes)}`,
                })}</p>
              </>
            )}
            <p className="cache-storage-hint">{step.cancel === "too-late" ? t("libraryLocation.tooLate") : t("libraryLocation.running")}</p>
            {step.jobId && (
              <div className="cache-storage-actions">
                <button type="button" className="tb-btn" disabled={step.cancel !== "none"} onClick={() => void cancel()}>
                  {step.cancel === "requested" ? t("libraryLocation.cancelling") : t("libraryLocation.cancel")}
                </button>
              </div>
            )}
          </div>
        )}

        {step.kind === "done" && (
          <>
            <div className={`cache-storage-alert ${step.result.status === "completed" ? "is-notice" : "is-warn"}`} role="status">
              {resultText(step.target, step.result)}
            </div>
            <div className="cache-storage-actions">
              {step.result.status === "cleanup-pending" && library.recoveryPending && (
                <button type="button" className="tb-btn" disabled={props.blocked} onClick={() => void run(null)}>{t("libraryLocation.cleanup")}</button>
              )}
              <button type="button" className="tb-btn" onClick={() => setStep({ kind: "idle" })}>{t("libraryLocation.back")}</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
