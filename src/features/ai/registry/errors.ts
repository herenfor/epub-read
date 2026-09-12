export type ProviderRegistryErrorCode =
  | "disposed"
  | "duplicate-provider"
  | "invalid-manifest"
  | "not-found"
  | "unsupported-capability";

export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;

  constructor(code: ProviderRegistryErrorCode, message: string) {
    super(message);
    this.name = "ProviderRegistryError";
    this.code = code;
  }
}
