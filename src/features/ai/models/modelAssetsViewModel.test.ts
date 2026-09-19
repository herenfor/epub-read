import { describe, expect, it } from "vitest";
import type { ModelPackageRecord } from "./modelAssets";
import type { ModelDownloadTask } from "./modelDownloads";
import { formatModelDownloadProgress, getModelAssetActionState } from "./modelAssetsViewModel";

const packageRecord = (overrides: Partial<ModelPackageRecord> = {}): ModelPackageRecord => ({
  packageId: "probe", modelId: "probe", version: "1", displayName: "Probe", capabilities: ["embedding"],
  format: "gguf", dimensions: null, maxInput: null, recommendedBatch: null, minMemoryBytes: null,
  recommendedMemoryBytes: null, platform: null, arch: null, license: "Apache-2.0", originalSource: "local",
  homepage: null, requiresAcceptance: false, providerKind: null, storageKind: "managed", packageDir: "probe",
  linkedExternalPath: null, state: "uninstalled", files: [], sources: [], ...overrides,
});

const task = (state: ModelDownloadTask["state"]): ModelDownloadTask => ({
  id: "task", packageId: "probe", state, bytesDownloaded: 12, totalBytes: 100, currentFilePath: "weights.gguf",
  currentFileIndex: 0, packageTotalBytes: 100, currentSourceUrl: null, sourceIndex: null, error: null,
  startedAtMs: null, completedAtMs: null, createdAtMs: 1, updatedAtMs: 1,
});

describe("model assets action view model", () => {
  it("keeps the download matrix safe for managed and linked packages", () => {
    expect(getModelAssetActionState(packageRecord(), undefined, false).canEnqueue).toBe(true);
    expect(getModelAssetActionState(packageRecord({ state: "installed" }), undefined, false).canEnqueue).toBe(false);
    expect(getModelAssetActionState(packageRecord(), task("queued"), false)).toMatchObject({ canPause: true, canCancel: true, canEnqueue: false });
    expect(getModelAssetActionState(packageRecord(), task("paused"), false)).toMatchObject({ canResume: true, canCancel: true });
    expect(getModelAssetActionState(packageRecord(), task("downloading"), false)).toMatchObject({ canVerify: false, canRelocate: false, canRemove: false });
    expect(getModelAssetActionState(packageRecord(), task("failed"), false)).toMatchObject({ canVerify: true, canRemove: true, canCancel: true });
    expect(getModelAssetActionState(packageRecord({ storageKind: "linked", linkedExternalPath: "/tmp/probe" }), undefined, false)).toMatchObject({ canEnqueue: false, canRelocate: true });
  });

  it("disables every action while a controller operation is busy and reports bytes", () => {
    const actions = getModelAssetActionState(packageRecord(), undefined, true);
    expect(actions.disabled).toBe(true);
    expect(formatModelDownloadProgress(task("downloading"))).toBe("12/100 bytes · 当前文件：weights.gguf");
  });
});
