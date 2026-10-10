import { useRef, useState } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { useModelAssetsDevelopmentController } from "../models/modelAssetsController";
import type { ModelPackageRecord } from "../models/modelAssets";
import { formatModelDownloadProgress, getModelAssetActionState } from "../models/modelAssetsViewModel";
import { ModelAssetLicenseDialog } from "./ModelAssetLicenseDialog";
import { uiText, useUiText } from "../../../ui/localization/UiLanguageProvider";

function chooseDirectory(): Promise<string | null> {
  return pickDirectory({ directory: true, multiple: false, title: uiText("ai.assets.pickDirectory") });
}

function packageLabel(packageRecord: ModelPackageRecord): string {
  return `${packageRecord.displayName} · ${packageRecord.packageId}`;
}

export function ModelAssetsDevelopmentSection({ allowDevelopmentActions }: { allowDevelopmentActions: boolean }) {
  const { t } = useUiText();
  const [state, controller] = useModelAssetsDevelopmentController();
  const [licensePackage, setLicensePackage] = useState<ModelPackageRecord | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const pickingDirectoryRef = useRef(false);
  const tasksByPackage = new Map(state.tasks.map((task) => [task.packageId, task]));
  if (!state.supported) {
    return (
      <section className="model-assets-development" aria-label={t("ai.assets.title")}>
        <h3>{t("ai.assets.title")}</h3>
        <p className="model-assets-note">{t("ai.assets.browserOnly")}</p>
      </section>
    );
  }
  const execute = async (action: () => Promise<void>) => { await action(); };
  const pickDirectorySafely = async () => {
    if (pickingDirectoryRef.current) return null;
    pickingDirectoryRef.current = true;
    setPickingDirectory(true);
    try {
      return await chooseDirectory();
    } finally {
      pickingDirectoryRef.current = false;
      setPickingDirectory(false);
    }
  };
  const controlsDisabled = state.busy || pickingDirectory;
  return (
    <section className="model-assets-development" aria-label={t("ai.assets.title")}>
      <div className="model-assets-title-row">
        <h3>{t("ai.assets.title")}</h3>
        {state.loading && <span className="model-assets-muted">{t("ai.assets.loading")}</span>}
      </div>
      <p className="model-assets-note">{t("ai.assets.explanation")}</p>
      {state.error && <div className="model-assets-error" role="alert">{state.error}</div>}
      <div className="model-assets-actions">
        <button disabled={controlsDisabled} onClick={() => void controller.refresh()}>{t("ai.assets.refresh")}</button>
        <button disabled={controlsDisabled} onClick={() => void execute(async () => { const path = await pickDirectorySafely(); if (path) await controller.setLibraryPath(path); })}>{t("ai.assets.chooseLibrary")}</button>
        <button disabled={controlsDisabled} onClick={() => void execute(async () => { const path = await pickDirectorySafely(); if (path) await controller.registerLinked(path); })}>{t("ai.assets.importLinked")}</button>
        {allowDevelopmentActions && <button disabled={controlsDisabled} onClick={() => void controller.registerDevelopmentCatalog()}>{t("ai.assets.registerTest")}</button>}
      </div>
      <div className="model-assets-root">{t("ai.assets.library", { path: state.library?.path ?? t("ai.assets.notSet") })}</div>
      <div className="model-assets-list">
        {state.packages.length === 0 && <div className="model-assets-muted">{t("ai.assets.empty")}</div>}
        {state.packages.map((packageRecord) => {
          const task = tasksByPackage.get(packageRecord.packageId);
          const actions = getModelAssetActionState(packageRecord, task, state.busy);
          const needsLicense = actions.canEnqueue && packageRecord.requiresAcceptance;
          return (
            <article className="model-assets-card" key={packageRecord.packageId}>
              <div className="model-assets-card-head">
                <strong>{packageLabel(packageRecord)}</strong>
                <span className={`model-assets-state state-${packageRecord.state}`}>{packageRecord.state}</span>
              </div>
              <div className="model-assets-meta">
                <span>{packageRecord.format === "text-fixture" ? t("ai.assets.capabilities.test") : t("ai.assets.capabilities")}{packageRecord.capabilities.map((capability) => <em key={capability}>{capability}</em>)}</span>
                <span>{packageRecord.storageKind === "linked" ? t("ai.assets.linked", { path: packageRecord.linkedExternalPath ?? t("ai.unknown") }) : t("ai.assets.managed", { path: packageRecord.packageDir })}</span>
                <span>{t("ai.assets.license", { license: packageRecord.license })}</span>
              </div>
              {task && <div className="model-assets-task">{t("ai.assets.download", { state: task.state, progress: formatModelDownloadProgress(task) })}{task.error && ` · ${task.error}`}</div>}
              <div className="model-assets-card-actions">
                {actions.canVerify && <button disabled={actions.disabled} onClick={() => void controller.verify(packageRecord.packageId)}>{t("ai.assets.verify")}</button>}
                {actions.canRelocate && <button disabled={actions.disabled} onClick={() => void execute(async () => { const path = await pickDirectorySafely(); if (path) await controller.relocate(packageRecord.packageId, path); })}>{t("ai.assets.relocate")}</button>}
                {actions.canPause && task ? <button disabled={actions.disabled} onClick={() => void controller.pause(task.id)}>{t("ai.assets.pause")}</button> : null}
                {actions.canResume && task ? <button disabled={actions.disabled} onClick={() => void controller.resume(task.id)}>{t("ai.assets.resume")}</button> : null}
                {actions.canCancel && task ? <button disabled={actions.disabled} onClick={() => void controller.cancel(task.id)}>{t("ai.cancel")}</button> : null}
                {actions.canEnqueue ? (
                  <button disabled={actions.disabled} onClick={() => {
                    if (needsLicense) setLicensePackage(packageRecord);
                    else void controller.enqueue(packageRecord.packageId);
                  }}>{task?.state === "failed" || task?.state === "cancelled" ? t("ai.assets.retry") : t("ai.assets.downloadAction")}</button>
                ) : null}
                {actions.canRemove && <button disabled={actions.disabled} onClick={() => {
                  const deleteFiles = packageRecord.storageKind === "managed";
                  const text = deleteFiles ? t("ai.assets.confirmDeleteManaged") : t("ai.assets.confirmDeleteLinked");
                  if (window.confirm(text)) void controller.remove(packageRecord.packageId, deleteFiles);
                }}>{packageRecord.storageKind === "managed" ? t("ai.assets.deleteFiles") : t("ai.assets.deleteRecord")}</button>}
              </div>
            </article>
          );
        })}
      </div>
      {licensePackage && (
        <ModelAssetLicenseDialog
          packageRecord={licensePackage}
          busy={state.busy}
          onCancel={() => setLicensePackage(null)}
          onAccept={(packageId) => {
            void controller.acceptLicenseAndEnqueue(packageId);
            setLicensePackage(null);
          }}
        />
      )}
    </section>
  );
}
