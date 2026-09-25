import { beforeEach, describe, expect, it } from "vitest";
import {
  canUseAiDevelopmentActions,
  clearAppBuildSession,
  getAppBuildSession,
  isAiDevelopmentActionsAllowed,
  setAppBuildSession,
} from "./appBuildSession";

describe("application build session and AI development policy", () => {
  beforeEach(() => clearAppBuildSession());

  it("allows development actions only for a debug AI session", () => {
    expect(canUseAiDevelopmentActions(null)).toBe(false);
    expect(canUseAiDevelopmentActions({ edition: "core", debug: true })).toBe(false);
    expect(canUseAiDevelopmentActions({ edition: "ai", debug: false })).toBe(false);
    expect(canUseAiDevelopmentActions({ edition: "ai", debug: true })).toBe(true);
  });

  it("stores an immutable desktop build projection", () => {
    const buildInfo = {
      version: "0.2.2",
      edition: "ai" as const,
      protocolVersion: 1 as const,
      target: "test",
      profile: "debug",
      debug: true,
    };
    const session = setAppBuildSession({ source: "desktop", buildInfo });
    expect(session).toEqual({ source: "desktop", edition: "ai", debug: true, buildInfo });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.buildInfo)).toBe(true);
    expect(getAppBuildSession()).toBe(session);
    expect(isAiDevelopmentActionsAllowed()).toBe(true);
  });

  it("does not retain session policy after reset", () => {
    setAppBuildSession({ source: "browser", edition: "ai", debug: true });
    expect(isAiDevelopmentActionsAllowed()).toBe(true);
    clearAppBuildSession();
    expect(getAppBuildSession()).toBeNull();
    expect(isAiDevelopmentActionsAllowed()).toBe(false);
  });
});
