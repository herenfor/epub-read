export interface HardwareDevice {
  id: string;
  name: string;
  /** Hardware/API compatibility is separate from an integrated model runtime. */
  candidate: { id: string; name: string; available: boolean; reason: string | null };
  memory: { budgetBytes: number | null; usageBytes: number | null; source: string; reason: string | null };
}
export interface HardwareReport {
  source: "preview" | "native";
  measuredAtMs: number;
  platform: string;
  devices: readonly HardwareDevice[];
  reason: string | null;
}
export type PreviewScenario = "candidate" | "unsupported" | "unknown-budget" | "low-budget" | "failure";
