import { useEffect, useRef, useState } from "react";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { assessMemoryBudget } from "../hardware/budget";
import type { HardwareReport, PreviewScenario } from "../hardware/contracts";
import { requestHardwareReport } from "../hardware/native";
import { previewHardware } from "../hardware/preview";

const mib = (value: number | null) => value === null ? "未知" : `${(value / 1024 ** 2).toFixed(1)} MiB`;
export function HardwareSection() {
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
    <section className="model-assets-development" aria-label="硬件与资源探测">
      <h3>硬件与资源探测</h3>
      <p className="model-assets-note">{desktop
        ? "主动检查 Windows 设备能力与当前进程的显存预算。模型运行时尚未接入，不加载模型或执行推理。"
        : "以下为可切换的预览数据，不代表本机 GPU。真实设备和预算需在 Windows 点击探测。"}</p>
      {!desktop && <label>预览场景 <select aria-label="硬件预览场景" disabled={busy} value={scenario} onChange={(e) => { setScenario(e.target.value as PreviewScenario); setReport(null); setMessage(""); }}>
        <option value="candidate">正常候选</option><option value="unsupported">设备不支持</option><option value="unknown-budget">预算未知</option><option value="low-budget">预算不足</option><option value="failure">探测失败</option>
      </select></label>}
      <div className="model-assets-actions">
        <button disabled={busy} onClick={() => void check()}>{desktop ? "探测本机硬件" : "查看硬件预览"}</button>
        {busy && <button onClick={() => active.current?.abort()}>取消等待</button>}
      </div>
      <label>测试预留（MiB） <input aria-label="测试预留 MiB" type="number" min="1" max="1048576" value={requested} onChange={(e) => setRequested(e.target.value)} style={{ width: "6rem" }} /></label>
      <p className="model-assets-muted">只评估预算，不实际分配显存；候选设备可用不等于模型后端已就绪。</p>
      {message && <p role="status">{message}</p>}
      {report && <div className="model-assets-list">
        <p role="status">{report.source === "preview" ? "预览结果" : "本机探测结果"} · {report.platform} · {new Date(report.measuredAtMs).toLocaleTimeString()}{report.reason && ` · ${report.reason}`}</p>
        {report.devices.map((device) => {
          const assessment = assessMemoryBudget(device.memory.budgetBytes, device.memory.usageBytes, Number(requested) * 1024 ** 2);
          const label = assessment.status === "fits" ? "可满足测试预留" : assessment.status === "insufficient" ? "可用预算不足" : assessment.status === "unknown" ? "预算未知，拒绝准入" : "预算或预留值无效，拒绝准入";
          return <article className="model-assets-card" key={device.id}>
            <strong>{device.name}</strong>
            <div className="model-assets-meta">
              <span>{device.candidate.name}：{device.candidate.available ? "可用候选" : "不可用"}</span>
              {device.candidate.reason && <span>{device.candidate.reason}</span>}
              <span>进程预算：{mib(device.memory.budgetBytes)}；当前使用：{mib(device.memory.usageBytes)}</span>
              <span>可用差额：{mib(assessment.availableBytes)}（动态快照）</span>
              <span>来源：{device.memory.source}</span>
              {device.memory.reason && <span>{device.memory.reason}</span>}
              <span>预算评估：{label}</span>
              <span>运行准入：{device.candidate.available ? "尚未接入模型运行时" : "候选不可用，拒绝准入"}</span>
            </div>
          </article>;
        })}
      </div>}
    </section>
  );
}
