import { useRef, useState } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { useModelAssetsDevelopmentController } from "../models/modelAssetsController";
import type { ModelPackageRecord } from "../models/modelAssets";
import { formatModelDownloadProgress, getModelAssetActionState } from "../models/modelAssetsViewModel";
import { ModelAssetLicenseDialog } from "./ModelAssetLicenseDialog";

const explanation = "这里只管理模型文件与下载元数据；不会创建或启用 Provider，不加载模型、不读取正文、不建向量、不执行推理。";

function chooseDirectory(): Promise<string | null> {
  return pickDirectory({ directory: true, multiple: false, title: "选择模型目录" });
}

function packageLabel(packageRecord: ModelPackageRecord): string {
  return `${packageRecord.displayName} · ${packageRecord.packageId}`;
}

export function ModelAssetsDevelopmentSection({ allowDevelopmentActions }: { allowDevelopmentActions: boolean }) {
  const [state, controller] = useModelAssetsDevelopmentController();
  const [licensePackage, setLicensePackage] = useState<ModelPackageRecord | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const pickingDirectoryRef = useRef(false);
  const tasksByPackage = new Map(state.tasks.map((task) => [task.packageId, task]));
  if (!state.supported) {
    return (
      <section className="model-assets-development" aria-label="模型资产">
        <h3>模型资产</h3>
        <p className="model-assets-note">浏览器预览需要桌面开发构建才能管理模型资产；当前不会调用 Tauri。</p>
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
    <section className="model-assets-development" aria-label="模型资产">
      <div className="model-assets-title-row">
        <h3>模型资产</h3>
        {state.loading && <span className="model-assets-muted">读取中…</span>}
      </div>
      <p className="model-assets-note">{explanation}</p>
      {state.error && <div className="model-assets-error" role="alert">{state.error}</div>}
      <div className="model-assets-actions">
        <button disabled={controlsDisabled} onClick={() => void controller.start()}>刷新元数据</button>
        <button disabled={controlsDisabled} onClick={() => void execute(async () => { const path = await pickDirectorySafely(); if (path) await controller.setLibraryPath(path); })}>选择模型库</button>
        <button disabled={controlsDisabled} onClick={() => void execute(async () => { const path = await pickDirectorySafely(); if (path) await controller.registerLinked(path); })}>导入 linked 目录</button>
        {allowDevelopmentActions && <button disabled={controlsDisabled} onClick={() => void controller.registerDevelopmentCatalog()}>登记测试包</button>}
      </div>
      <div className="model-assets-root">模型库：{state.library?.path ?? "未设置"}</div>
      <div className="model-assets-list">
        {state.packages.length === 0 && <div className="model-assets-muted">暂无已登记模型资产</div>}
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
                <span>{packageRecord.format === "text-fixture" ? "测试声明能力：" : "能力："}{packageRecord.capabilities.map((capability) => <em key={capability}>{capability}</em>)}</span>
                <span>{packageRecord.storageKind === "linked" ? `linked：${packageRecord.linkedExternalPath ?? "未知"}` : `受管理目录：${packageRecord.packageDir}`}</span>
                <span>许可证：{packageRecord.license}</span>
              </div>
              {task && <div className="model-assets-task">下载：{task.state} · {formatModelDownloadProgress(task)}{task.error && ` · ${task.error}`}</div>}
              <div className="model-assets-card-actions">
                {actions.canVerify && <button disabled={actions.disabled} onClick={() => void controller.verify(packageRecord.packageId)}>校验</button>}
                {actions.canRelocate && <button disabled={actions.disabled} onClick={() => void execute(async () => { const path = await pickDirectorySafely(); if (path) await controller.relocate(packageRecord.packageId, path); })}>重新定位</button>}
                {actions.canPause && task ? <button disabled={actions.disabled} onClick={() => void controller.pause(task.id)}>暂停</button> : null}
                {actions.canResume && task ? <button disabled={actions.disabled} onClick={() => void controller.resume(task.id)}>继续</button> : null}
                {actions.canCancel && task ? <button disabled={actions.disabled} onClick={() => void controller.cancel(task.id)}>取消</button> : null}
                {actions.canEnqueue ? (
                  <button disabled={actions.disabled} onClick={() => {
                    if (needsLicense) setLicensePackage(packageRecord);
                    else void controller.enqueue(packageRecord.packageId);
                  }}>{task?.state === "failed" || task?.state === "cancelled" ? "重试" : "下载"}</button>
                ) : null}
                {actions.canRemove && <button disabled={actions.disabled} onClick={() => {
                  const deleteFiles = packageRecord.storageKind === "managed";
                  const text = deleteFiles ? "确认删除登记记录及受管理模型文件？" : "确认只删除 linked 登记记录？外部文件不会被删除。";
                  if (window.confirm(text)) void controller.remove(packageRecord.packageId, deleteFiles);
                }}>{packageRecord.storageKind === "managed" ? "删除文件与记录" : "删除记录"}</button>}
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
