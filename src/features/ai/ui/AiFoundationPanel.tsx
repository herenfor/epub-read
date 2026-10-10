import {
  AI_CAPABILITIES,
  getCapability,
  type AiCapability,
} from "../contracts/capabilities";
import type { AiRuntimeSnapshot } from "../lifecycle/runtime";
import { PreparationSection, type PreparationSectionProps } from "./PreparationSection";
import { SemanticSection, type SemanticSectionProps } from "./SemanticSection";
import { ModelAssetsDevelopmentSection } from "./ModelAssetsDevelopmentSection";
import { ModelLockSection } from "./ModelLockSection";
import { HardwareSection } from "./HardwareSection";
import "./ai.css";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import { CloseIcon } from "../../../ui/readerIcons";
import { useUiText, type Translate } from "../../../ui/localization/UiLanguageProvider";
import type { PlainMessageKey } from "../../../ui/localization/core";

const CAPABILITY_LABELS: Record<AiCapability, PlainMessageKey> = {
  embedding: "ai.capability.embedding",
  generation: "ai.capability.generation",
  reranking: "ai.capability.reranking",
};

function capabilityState(t: Translate, snapshot: AiRuntimeSnapshot, capability: AiCapability): string {
  if (snapshot.status === "disabled") return t("ai.state.disabled");
  if (snapshot.status === "initializing") return t("ai.state.initializing");
  if (snapshot.status === "error") return t("ai.state.error");
  const descriptor = snapshot.manifest && getCapability(snapshot.manifest, capability);
  return t(descriptor?.availability === "available" ? "ai.state.available" : "ai.state.unavailable");
}

export interface AiFoundationPanelProps {
  snapshot: AiRuntimeSnapshot;
  onEnable: () => void;
  onDisable: () => void;
  onClose: () => void;
  preparation?: PreparationSectionProps;
  semantic?: SemanticSectionProps;
}

/** AI assets and explicitly gated mock diagnostics. */
export function AiFoundationPanel({ snapshot, onEnable, onDisable, onClose, preparation, semantic }: AiFoundationPanelProps) {
  const { t } = useUiText();
  const developmentActionsAllowed = isAiDevelopmentActionsAllowed();
  const desktopDevelopmentActionsAllowed = developmentActionsAllowed && getAppBuildSession()?.source === "desktop";
  const health = t(snapshot.status === "disabled"
    ? "ai.health.unchecked"
    : snapshot.health?.status === "healthy"
      ? "ai.health.healthy"
      : snapshot.health?.status === "checking"
        ? "ai.health.checking"
        : snapshot.health?.status === "degraded"
          ? "ai.health.degraded"
          : snapshot.health?.status === "unhealthy"
            ? "ai.health.unhealthy"
            : snapshot.status === "error" ? "ai.state.error" : "ai.unknown");

  return (
    <aside className="ai-foundation-panel" role="dialog" aria-label={t("ai.panel.title")}>
      <div className="drawer-drag-handle" aria-hidden="true" />
      <div className="ai-foundation-head">
        <div>
          <h2>{t("ai.panel.title")}</h2>
          <p>{t("ai.panel.subtitle")}</p>
        </div>
        <button className="tb-btn tb-close panel-close" onClick={onClose} aria-label={t("ai.panel.close")} title={t("common.close")}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="ai-foundation-note">
        {developmentActionsAllowed
          ? desktopDevelopmentActionsAllowed
            ? t("ai.panel.note.desktop")
            : t("ai.panel.note.browser")
          : t("ai.panel.note.release")}
      </div>
      {developmentActionsAllowed && <HardwareSection />}
      {developmentActionsAllowed && preparation && <PreparationSection key={`preparation:${preparation.fingerprint}`} {...preparation} />}
      {developmentActionsAllowed && semantic && <SemanticSection key={`semantic:${semantic.fingerprint}`} {...semantic} />}
      {developmentActionsAllowed && <ModelLockSection />}
      <div className="ai-foundation-health">
        <div className="ai-foundation-row ai-foundation-row-health">
          <span>{t("ai.panel.providerHealth")}</span><strong>{health}</strong>
        </div>
        {AI_CAPABILITIES.map((capability) => (
          <div className="ai-foundation-row" key={capability}>
            <span>{t(CAPABILITY_LABELS[capability])}</span>
            <strong>{capabilityState(t, snapshot, capability)}</strong>
          </div>
        ))}
      </div>
      {snapshot.error && <div className="ai-foundation-error" role="alert">{snapshot.error}</div>}
      {developmentActionsAllowed && <div className="ai-foundation-actions">
        {snapshot.status === "disabled" || snapshot.status === "error" ? (
          <button className="ai-foundation-primary" onClick={() => void onEnable()}>
            {t("ai.panel.enableMock")}
          </button>
        ) : (
          <button className="ai-foundation-secondary" onClick={() => void onDisable()}>
            {t("ai.panel.disable")}
          </button>
        )}
      </div>}
      <ModelAssetsDevelopmentSection allowDevelopmentActions={developmentActionsAllowed} />
    </aside>
  );
}
