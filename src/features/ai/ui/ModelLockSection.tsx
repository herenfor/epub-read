import { useState } from "react";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { probeModelLocks } from "../models/modelLockProbe";
import { uiText, useUiText } from "../../../ui/localization/UiLanguageProvider";

export function ModelLockSection() {
  const { t } = useUiText();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const desktop = getAppBuildSession()?.source === "desktop";
  const check = async () => {
    setBusy(true);
    setMessage(uiText("ai.lock.checking"));
    try { setMessage(await probeModelLocks()); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <section className="model-assets-development" aria-label={t("ai.lock.title")}>
      <h3>{t("ai.lock.title")}</h3>
      <p className="model-assets-note">{desktop
        ? t("ai.lock.note.desktop")
        : t("ai.lock.note.browser")}</p>
      <div className="model-assets-actions">
        <button disabled={busy} onClick={() => void check()}>{desktop ? t("ai.lock.checkFile") : t("ai.lock.checkBrowser")}</button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
