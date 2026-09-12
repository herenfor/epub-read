import { invoke } from "@tauri-apps/api/core";

export const MODEL_PACKAGE_STATES = [
  "uninstalled",
  "queued",
  "downloading",
  "paused",
  "verifying",
  "installed",
  "missing",
  "corrupt",
  "failed",
] as const;

export type ModelPackageState = (typeof MODEL_PACKAGE_STATES)[number];
export type ModelCapability = "embedding" | "generation" | "reranking";

export interface ModelManifestFile {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  purpose: string;
}

export interface ModelDownloadMirror {
  url: string;
  kind: string | null;
}

export interface ModelPackageManifest {
  schemaVersion: number;
  packageId: string;
  modelId: string;
  version: string;
  displayName: string;
  capabilities: ModelCapability[];
  format: string;
  files: ModelManifestFile[];
  dimensions: number | null;
  maxInput: number | null;
  recommendedBatch: number | null;
  minMemoryBytes: number | null;
  recommendedMemoryBytes: number | null;
  platform: string | null;
  arch: string | null;
  license: string;
  originalSource: string;
  homepage: string | null;
  requiresAcceptance: boolean;
  downloadMirrors: ModelDownloadMirror[];
  providerKind: string | null;
}

export interface ModelPackageIssue {
  code: string;
  message: string;
}

export interface ModelPackageScanStatus {
  packageDir: string;
  packageId: string | null;
  modelId: string | null;
  state: "ready" | "invalid";
  manifest: ModelPackageManifest | null;
  issues: ModelPackageIssue[];
}

export interface ModelLibraryRootInfo {
  path: string | null;
  exists: boolean;
  isDirectory: boolean;
}

export interface ModelPackageScanResult {
  root: ModelLibraryRootInfo;
  packages: ModelPackageScanStatus[];
  defaultPackageId: string | null;
  scanError: string | null;
}

export interface ModelPackageFileRecord extends ModelManifestFile {
  verificationState: "pending" | "verified" | "missing" | "size-mismatch" | "hash-mismatch" | "invalid-path" | "io-error";
  actualSizeBytes: number | null;
  actualSha256: string | null;
  downloadedBytes: number;
  installedAtMs: number | null;
}

export interface ModelPackageSourceRecord {
  url: string;
  kind: string | null;
}

export interface ModelPackageRecord {
  packageId: string;
  modelId: string;
  version: string;
  displayName: string;
  capabilities: ModelCapability[];
  format: string;
  dimensions: number | null;
  maxInput: number | null;
  recommendedBatch: number | null;
  minMemoryBytes: number | null;
  recommendedMemoryBytes: number | null;
  platform: string | null;
  arch: string | null;
  license: string;
  originalSource: string;
  homepage: string | null;
  requiresAcceptance: boolean;
  providerKind: string | null;
  storageKind: "managed" | "linked";
  packageDir: string;
  linkedExternalPath: string | null;
  state: ModelPackageState;
  files: ModelPackageFileRecord[];
  sources: ModelPackageSourceRecord[];
}

export interface ModelLibraryPathSetting extends ModelLibraryRootInfo {
  path: string | null;
}

export interface ModelAssetPort {
  getLibraryPath(): Promise<ModelLibraryPathSetting>;
  setLibraryPath(path: string): Promise<ModelLibraryPathSetting>;
  scan(): Promise<ModelPackageScanResult>;
  listPackages(): Promise<ModelPackageRecord[]>;
  registerPackage(packageDir: string): Promise<ModelPackageRecord>;
  registerLinkedPackage(externalPath: string): Promise<ModelPackageRecord>;
  relocatePackage(packageId: string, externalPath: string): Promise<ModelPackageRecord>;
  removePackage(packageId: string, deleteManagedFiles: boolean): Promise<void>;
  registerDevelopmentCatalog(): Promise<ModelPackageRecord>;
  verifyPackage(packageId: string): Promise<ModelPackageRecord>;
}

export function createTauriModelAssetPort(): ModelAssetPort {
  return {
    getLibraryPath: () => invoke<ModelLibraryPathSetting>("ai_model_library_path_get"),
    setLibraryPath: (path) => invoke<ModelLibraryPathSetting>("ai_model_library_path_set", { path }),
    scan: () => invoke<ModelPackageScanResult>("ai_model_scan"),
    listPackages: () => invoke<ModelPackageRecord[]>("ai_model_packages"),
    registerPackage: (packageDir) => invoke<ModelPackageRecord>("ai_model_package_register", { packageDir }),
    registerLinkedPackage: (externalPath) => invoke<ModelPackageRecord>("ai_model_package_register_linked", { externalPath }),
    relocatePackage: (packageId, externalPath) => invoke<ModelPackageRecord>("ai_model_package_relocate", { packageId, externalPath }),
    removePackage: (packageId, deleteManagedFiles) => invoke<void>("ai_model_package_remove", { packageId, deleteManagedFiles }),
    registerDevelopmentCatalog: () => invoke<ModelPackageRecord>("ai_model_dev_catalog_register"),
    verifyPackage: (packageId) => invoke<ModelPackageRecord>("ai_model_package_verify", { packageId }),
  };
}

/** The default is a project-owned package named `default`, if one is installed. */
export function resolveDefaultModelPackage(
  packages: readonly ModelPackageRecord[],
): ModelPackageRecord | undefined {
  return packages.find((packageRecord) => packageRecord.packageId === "default" && packageRecord.state === "installed");
}

/** Metadata-only lookup for a future provider registry; it never loads code. */
export function findAvailableModelPackages(
  packages: readonly ModelPackageRecord[],
  capability: ModelCapability,
): ModelPackageRecord[] {
  return packages.filter(
    (packageRecord) =>
      packageRecord.state === "installed" &&
      packageRecord.format !== "text-fixture" &&
      packageRecord.providerKind !== "mock" &&
      packageRecord.files.length > 0 &&
      packageRecord.files.every((file) => file.verificationState === "verified") &&
      packageRecord.capabilities.includes(capability),
  );
}
