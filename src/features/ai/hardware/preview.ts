import type { HardwareReport, PreviewScenario } from "./contracts";

/** Explicit UI fixtures; never inspect or make claims about the host GPU. */
export function previewHardware(scenario: PreviewScenario): HardwareReport {
  const report: HardwareReport = { source: "preview", measuredAtMs: Date.now(), platform: "浏览器预览数据", devices: [], reason: null };
  if (scenario === "failure") return { ...report, reason: "预览：设备查询失败，可重新检查；没有启用 CPU 回退。" };
  return { ...report, devices: [{
    id: "preview-device", name: "示例 GPU（非本机设备）",
    candidate: { id: "preview-gpu", name: "GPU 后端候选（预览）", available: scenario !== "unsupported", reason: scenario === "unsupported" ? "预览：设备不满足候选后端要求" : null },
    memory: {
      budgetBytes: scenario === "unknown-budget" ? null : scenario === "low-budget" ? 64 * 1024 ** 2 : 2 * 1024 ** 3,
      usageBytes: scenario === "unknown-budget" ? null : 32 * 1024 ** 2,
      source: "预览固定值，非实际显存", reason: scenario === "unknown-budget" ? "预览：系统未提供预算信息" : null,
    },
  }] };
}
