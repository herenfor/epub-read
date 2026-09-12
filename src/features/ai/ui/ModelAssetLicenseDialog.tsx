import type { ModelPackageRecord } from "../models/modelAssets";

export interface ModelAssetLicenseDialogProps {
  packageRecord: ModelPackageRecord;
  busy: boolean;
  onCancel: () => void;
  onAccept: (packageId: string) => void;
}

/** A deliberately explicit gate: accepting a license is separate from loading or running a model. */
export function ModelAssetLicenseDialog({ packageRecord, busy, onCancel, onAccept }: ModelAssetLicenseDialogProps) {
  return (
    <dialog open className="model-assets-license-dialog">
      <h4>接受模型许可证</h4>
      <p>{packageRecord.displayName}</p>
      <pre>{packageRecord.license}</pre>
      <p>来源：{packageRecord.originalSource}</p>
      <div>
        <button disabled={busy} onClick={onCancel}>取消</button>
        <button disabled={busy} onClick={() => onAccept(packageRecord.packageId)}>接受并继续</button>
      </div>
    </dialog>
  );
}
