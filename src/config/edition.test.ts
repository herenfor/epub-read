import { describe, expect, it } from "vitest";
import { APP_EDITION, normalizeAppEdition } from "./edition";

describe("application edition", () => {
  it("accepts core/ai and defaults to core when unset", () => {
    expect(normalizeAppEdition("ai")).toBe("ai");
    expect(normalizeAppEdition(" AI ")).toBe("ai");
    expect(normalizeAppEdition("core")).toBe("core");
    expect(normalizeAppEdition(undefined)).toBe("core");
  });

  it("rejects invalid explicit editions instead of silently selecting core", () => {
    expect(() => normalizeAppEdition("")).toThrow(/Expected core or ai/);
    expect(() => normalizeAppEdition("preview")).toThrow(/Expected core or ai/);
  });

  it("is injected as a compile-time edition constant", () => {
    expect(["core", "ai"]).toContain(APP_EDITION);
  });
});
