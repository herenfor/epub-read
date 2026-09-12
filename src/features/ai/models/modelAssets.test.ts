import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTauriModelAssetPort,
  findAvailableModelPackages,
  resolveDefaultModelPackage,
  type ModelPackageRecord,
} from "./modelAssets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

function packageRecord(overrides: Partial<ModelPackageRecord> = {}): ModelPackageRecord {
  return {
    packageId: "default",
    modelId: "model",
    version: "1",
    displayName: "Default",
    capabilities: ["generation"],
    format: "gguf",
    dimensions: null,
    maxInput: null,
    recommendedBatch: null,
    minMemoryBytes: null,
    recommendedMemoryBytes: null,
    platform: null,
    arch: null,
    license: "Apache-2.0",
    originalSource: "local",
    homepage: null,
    requiresAcceptance: false,
    providerKind: null,
    storageKind: "managed",
    packageDir: "default",
    linkedExternalPath: null,
    state: "installed",
    files: [],
    sources: [],
    ...overrides,
  };
}

describe("model asset adapter", () => {
  beforeEach(() => invokeMock.mockReset());

  it("forwards model library commands without exposing a model UI", async () => {
    invokeMock.mockResolvedValue({ path: "D:/models", exists: true, isDirectory: true });
    const port = createTauriModelAssetPort();
    await port.setLibraryPath("D:/models");
    await port.scan();
    await port.listPackages();
    await port.registerPackage("default");
    await port.registerLinkedPackage("D:/external-model");
    await port.relocatePackage("default", "D:/external-model-2");
    await port.removePackage("default", false);
    await port.verifyPackage("default");
    await port.registerDevelopmentCatalog();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_model_library_path_set", { path: "D:/models" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "ai_model_scan");
    expect(invokeMock).toHaveBeenNthCalledWith(3, "ai_model_packages");
    expect(invokeMock).toHaveBeenNthCalledWith(4, "ai_model_package_register", { packageDir: "default" });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "ai_model_package_register_linked", { externalPath: "D:/external-model" });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "ai_model_package_relocate", { packageId: "default", externalPath: "D:/external-model-2" });
    expect(invokeMock).toHaveBeenNthCalledWith(7, "ai_model_package_remove", { packageId: "default", deleteManagedFiles: false });
    expect(invokeMock).toHaveBeenNthCalledWith(8, "ai_model_package_verify", { packageId: "default" });
    expect(invokeMock).toHaveBeenNthCalledWith(9, "ai_model_dev_catalog_register");
  });

  it("resolves no invented default package", () => {
    expect(resolveDefaultModelPackage([packageRecord({ packageId: "other" })])).toBeUndefined();
    expect(resolveDefaultModelPackage([packageRecord({ state: "missing" })])).toBeUndefined();
    expect(resolveDefaultModelPackage([packageRecord()])?.modelId).toBe("model");
  });

  it("only exposes verified installed metadata to future registries", () => {
    const available = packageRecord({
      files: [{ relativePath: "weights.gguf", sizeBytes: 1, sha256: "a".repeat(64), purpose: "weights", verificationState: "verified", actualSizeBytes: 1, actualSha256: "a".repeat(64), downloadedBytes: 1, installedAtMs: 1 }],
    });
    expect(findAvailableModelPackages([available, packageRecord({ packageId: "missing", state: "missing", files: available.files })], "generation")).toHaveLength(1);
    expect(findAvailableModelPackages([packageRecord({ format: "text-fixture", files: available.files }), packageRecord({ packageId: "mock", providerKind: "mock", files: available.files })], "generation")).toHaveLength(0);
  });
});
