import type { ModelPackageRecord } from "../models/modelAssets";
import { useUiText } from "../../../ui/localization/UiLanguageProvider";

export interface ModelAssetLicenseDialogProps {
  packageRecord: ModelPackageRecord;
  busy: boolean;
  onCancel: () => void;
  onAccept: (packageId: string) => void;
}

/** A deliberately explicit gate: accepting a license is separate from loading or running a model. */
export function ModelAssetLicenseDialog({ packageRecord, busy, onCancel, onAccept }: ModelAssetLicenseDialogProps) {
  const { t } = useUiText();
  return (
    <dialog open className="model-assets-license-dialog">
      <h4>{t("ai.license.title")}</h4>
      <p>{packageRecord.displayName}</p>
      <pre>{packageRecord.license}</pre>
      <p>{t("ai.license.source", { source: packageRecord.originalSource })}</p>
      <div>
        <button disabled={busy} onClick={onCancel}>{t("ai.cancel")}</button>
        <button disabled={busy} onClick={() => onAccept(packageRecord.packageId)}>{t("ai.license.accept")}</button>
      </div>
    </dialog>
  );
}
