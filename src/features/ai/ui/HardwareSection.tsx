import { useEffect, useRef, useState } from "react";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { assessMemoryBudget } from "../hardware/budget";
import type { HardwareReport, PreviewScenario } from "../hardware/contracts";
import { requestHardwareReport } from "../hardware/native";
import { previewHardware } from "../hardware/preview";
import { useUiText } from "../../../ui/localization/UiLanguageProvider";

const mib = (value: number | null, unknown: string) => value === null ? unknown : `${(value / 1024 ** 2).toFixed(1)} MiB`;
export function HardwareSection() {
  const { t, locale } = useUiText();
  const desktop = getAppBuildSession()?.source === "desktop";
  const [scenario, setScenario] = useState<PreviewScenario>("candidate");
  const [requested, setRequested] = useState("128");
  const [report, setReport] = useState<HardwareReport | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  const check = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setMessage(""); setReport(null);
    try {
      const next = desktop ? await requestHardwareReport(controller.signal) : previewHardware(scenario);
      if (active.current === controller) setReport(next);
    } catch (error) {
      if (active.current === controller) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  };
  return (
    <section className="model-assets-development" aria-label={t("ai.hw.title")}>
      <h3>{t("ai.hw.title")}</h3>
      <p className="model-assets-note">{desktop
        ? t("ai.hw.note.desktop")
        : t("ai.hw.note.preview")}</p>
      {!desktop && <label>{t("ai.hw.scenario")} <select aria-label={t("ai.hw.scenario.label")} disabled={busy} value={scenario} onChange={(e) => { setScenario(e.target.value as PreviewScenario); setReport(null); setMessage(""); }}>
        <option value="candidate">{t("ai.hw.scenario.candidate")}</option><option value="unsupported">{t("ai.hw.scenario.unsupported")}</option><option value="unknown-budget">{t("ai.hw.scenario.unknownBudget")}</option><option value="low-budget">{t("ai.hw.scenario.lowBudget")}</option><option value="failure">{t("ai.hw.scenario.failure")}</option>
      </select></label>}
      <div className="model-assets-actions">
        <button disabled={busy} onClick={() => void check()}>{desktop ? t("ai.hw.probe") : t("ai.hw.preview")}</button>
        {busy && <button onClick={() => active.current?.abort()}>{t("ai.hw.cancel")}</button>}
      </div>
      <label>{t("ai.hw.reserve")} <input aria-label={t("ai.hw.reserve.label")} type="number" min="1" max="1048576" value={requested} onChange={(e) => setRequested(e.target.value)} style={{ width: "6rem" }} /></label>
      <p className="model-assets-muted">{t("ai.hw.reserveNote")}</p>
      {message && <p role="status">{message}</p>}
      {report && <div className="model-assets-list">
        <p role="status">{report.source === "preview" ? t("ai.hw.result.preview") : t("ai.hw.result.native")} · {report.platform} · {new Date(report.measuredAtMs).toLocaleTimeString(locale)}{report.reason && ` · ${report.reason}`}</p>
        {report.devices.map((device) => {
          const assessment = assessMemoryBudget(device.memory.budgetBytes, device.memory.usageBytes, Number(requested) * 1024 ** 2);
          const label = t(assessment.status === "fits" ? "ai.hw.fit.fits" : assessment.status === "insufficient" ? "ai.hw.fit.insufficient" : assessment.status === "unknown" ? "ai.hw.fit.unknown" : "ai.hw.fit.invalid");
          const unknown = t("ai.unknown");
          return <article className="model-assets-card" key={device.id}>
            <strong>{device.name}</strong>
            <div className="model-assets-meta">
              <span>{t(device.candidate.available ? "ai.hw.candidate.available" : "ai.hw.candidate.unavailable", { name: device.candidate.name })}</span>
              {device.candidate.reason && <span>{device.candidate.reason}</span>}
              <span>{t("ai.hw.budget", { budget: mib(device.memory.budgetBytes, unknown), usage: mib(device.memory.usageBytes, unknown) })}</span>
              <span>{t("ai.hw.headroom", { amount: mib(assessment.availableBytes, unknown) })}</span>
              <span>{t("ai.hw.source", { source: device.memory.source })}</span>
              {device.memory.reason && <span>{device.memory.reason}</span>}
              <span>{t("ai.hw.assessment", { label })}</span>
              <span>{t(device.candidate.available ? "ai.hw.admission.pending" : "ai.hw.admission.denied")}</span>
            </div>
          </article>;
        })}
      </div>}
    </section>
  );
}
