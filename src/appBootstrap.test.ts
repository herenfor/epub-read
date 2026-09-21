import { beforeEach, describe, expect, it } from "vitest";
import { APP_EDITION } from "./config/edition";
import { clearAppBuildSession, getAppBuildSession } from "./config/appBuildSession";
import { bootstrapApp, type AppBootstrapDependencies } from "./appBootstrap";

const root = {} as HTMLElement;
const buildInfo = {
  version: "0.2.1",
  edition: APP_EDITION,
  protocolVersion: 1 as const,
  target: "test-target",
  profile: "test",
  debug: true,
};

function dependencies(overrides: Partial<AppBootstrapDependencies> = {}): AppBootstrapDependencies {
  return {
    isDesktop: () => false,
    readBuildInfo: async () => buildInfo,
    loadApp: async () => ({ default: () => null }),
    mountApp: () => undefined,
    mountFailure: () => undefined,
    ...overrides,
  };
}

describe("application bootstrap", () => {
  beforeEach(() => {
    clearAppBuildSession();
  });

  it("skips IPC in browser mode and loads App", async () => {
    let reads = 0;
    let loads = 0;
    let mounts = 0;
    const result = await bootstrapApp(root, dependencies({
      readBuildInfo: async () => { reads++; return buildInfo; },
      loadApp: async () => { loads++; return { default: () => null }; },
      mountApp: () => { mounts++; },
    }));
    expect(result).toBe("mounted");
    expect(reads).toBe(0);
    expect(loads).toBe(1);
    expect(mounts).toBe(1);
    expect(getAppBuildSession()).toMatchObject({
      source: "browser",
      edition: APP_EDITION,
    });
  });

  it("fails closed before importing App on a desktop mismatch", async () => {
    let loads = 0;
    let failures = 0;
    const result = await bootstrapApp(root, dependencies({
      isDesktop: () => true,
      readBuildInfo: async () => ({ ...buildInfo, edition: APP_EDITION === "core" ? "ai" : "core" }),
      loadApp: async () => { loads++; return { default: () => null }; },
      mountFailure: () => { failures++; },
    }));
    expect(result).toBe("failed");
    expect(loads).toBe(0);
    expect(failures).toBe(1);
    expect(getAppBuildSession()).toBeNull();
  });

  it("fails closed before importing App when the handshake rejects", async () => {
    let loads = 0;
    let failures = 0;
    const result = await bootstrapApp(root, dependencies({
      isDesktop: () => true,
      readBuildInfo: async () => { throw new Error("IPC unavailable"); },
      loadApp: async () => { loads++; return { default: () => null }; },
      mountFailure: () => { failures++; },
    }));
    expect(result).toBe("failed");
    expect(loads).toBe(0);
    expect(failures).toBe(1);
    expect(getAppBuildSession()).toBeNull();
  });

  it("keeps the App module import behind the bootstrap boundary", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readFile } = await import("node:fs/promises");
    const main = await readFile(new URL("./main.tsx", import.meta.url), "utf8");
    expect(main).toContain("bootstrapApp(root)");
    expect(main).not.toContain('from "./App"');
  });
});
