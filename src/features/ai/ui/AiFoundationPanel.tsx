import {
  AI_CAPABILITIES,
  getCapability,
  type AiCapability,
} from "../contracts/capabilities";
import type { AiRuntimeSnapshot } from "../lifecycle/runtime";
import { ModelAssetsDevelopmentSection } from "./ModelAssetsDevelopmentSection";
import "./ai.css";
import { isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";

const CAPABILITY_LABELS: Record<AiCapability, string> = {
  embedding: "向量嵌入",
  generation: "文本生成",
  reranking: "重排",
};

function capabilityState(snapshot: AiRuntimeSnapshot, capability: AiCapability): string {
  if (snapshot.status === "disabled") return "未启用";
  if (snapshot.status === "initializing") return "准备中";
  if (snapshot.status === "error") return "异常";
  const descriptor = snapshot.manifest && getCapability(snapshot.manifest, capability);
  return descriptor?.availability === "available" ? "可用" : "不可用";
}

export interface AiFoundationPanelProps {
  snapshot: AiRuntimeSnapshot;
  onEnable: () => void;
  onDisable: () => void;
  onClose: () => void;
}

/** Development-only status surface. It intentionally has no indexing controls yet. */
export function AiFoundationPanel({ snapshot, onEnable, onDisable, onClose }: AiFoundationPanelProps) {
  const developmentActionsAllowed = isAiDevelopmentActionsAllowed();
  const health = snapshot.status === "disabled"
    ? "未检查"
    : snapshot.health?.status === "healthy"
      ? "健康"
      : snapshot.health?.status === "checking"
        ? "检查中"
        : snapshot.health?.status === "degraded"
          ? "降级"
          : snapshot.health?.status === "unhealthy"
            ? "不健康"
            : snapshot.status === "error" ? "异常" : "未知";

  return (
    <aside className="ai-foundation-panel" role="dialog" aria-label="AI 与模型（开发）">
      <div className="ai-foundation-head">
        <div>
          <h2>AI 与模型（开发）</h2>
          <p>开发模式能力检查</p>
        </div>
        <button className="panel-close" onClick={onClose} aria-label="关闭 AI 与模型（开发）">×</button>
      </div>
      <div className="ai-foundation-note">
        {developmentActionsAllowed
          ? "仅 mock Provider：无真实模型、无网络请求、不会调用 Rust 或 SQLite。"
          : "当前发行版只管理模型文件与下载元数据；未启用 Provider，不加载模型、不读取正文、不建向量、不执行推理。"}
      </div>
      <div className="ai-foundation-health">
        <div className="ai-foundation-row ai-foundation-row-health">
          <span>Provider 健康</span><strong>{health}</strong>
        </div>
        {AI_CAPABILITIES.map((capability) => (
          <div className="ai-foundation-row" key={capability}>
            <span>{CAPABILITY_LABELS[capability]}</span>
            <strong>{capabilityState(snapshot, capability)}</strong>
          </div>
        ))}
      </div>
      {snapshot.error && <div className="ai-foundation-error" role="alert">{snapshot.error}</div>}
      {developmentActionsAllowed && <div className="ai-foundation-actions">
        {snapshot.status === "disabled" || snapshot.status === "error" ? (
          <button className="ai-foundation-primary" onClick={() => void onEnable()}>
            启用 mock
          </button>
        ) : (
          <button className="ai-foundation-secondary" onClick={() => void onDisable()}>
            禁用并释放
          </button>
        )}
      </div>}
      <ModelAssetsDevelopmentSection allowDevelopmentActions={developmentActionsAllowed} />
    </aside>
  );
}
