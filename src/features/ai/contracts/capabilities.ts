/** Capabilities understood by the AI feature. Keep this list small and explicit. */
export const AI_CAPABILITIES = ["embedding", "generation", "reranking"] as const;

export type AiCapability = (typeof AI_CAPABILITIES)[number];

/** A provider can be installed but temporarily unable to serve one capability. */
export type CapabilityAvailability = "available" | "unavailable";

export interface CapabilityDescriptor {
  capability: AiCapability;
  availability: CapabilityAvailability;
  /** A human-readable explanation for an unavailable capability. */
  reason?: string;
}

export type ProviderAvailability = "enabled" | "disabled" | "initializing" | "ready" | "error";
export type ProviderHealthStatus = "unknown" | "checking" | "healthy" | "degraded" | "unhealthy";

export type ProviderTransport = "builtin" | "sidecar" | "http" | "mock";

export interface ProviderModelManifest {
  id: string;
  digest?: string;
  format?: string;
  dimensions?: number;
  contextWindow?: number;
}

export interface ProviderManifest {
  id: string;
  version: string;
  displayName: string;
  transport: ProviderTransport;
  /** Whether the provider sends book text outside the reader process. */
  local: boolean;
  availability: ProviderAvailability;
  capabilities: readonly CapabilityDescriptor[];
  models?: readonly ProviderModelManifest[];
  privacyNotice?: string;
}

export interface ProviderHealth {
  status: ProviderHealthStatus;
  checkedAt: number;
  message?: string;
  capabilities?: Partial<Record<AiCapability, CapabilityAvailability>>;
}

export function isAiCapability(value: string): value is AiCapability {
  return (AI_CAPABILITIES as readonly string[]).includes(value);
}

export function getCapability(
  manifest: ProviderManifest,
  capability: AiCapability,
): CapabilityDescriptor | undefined {
  return manifest.capabilities.find((entry) => entry.capability === capability);
}

export function supportsCapability(
  manifest: ProviderManifest,
  capability: AiCapability,
): boolean {
  return manifest.availability === "ready" && getCapability(manifest, capability)?.availability === "available";
}
