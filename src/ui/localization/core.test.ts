import { describe, expect, it, vi } from "vitest";
import { createUiLanguageStore, readUiLanguagePreference, resolveUiLocale, translate } from "./core";
import { en } from "./messages";

describe("UI language core", () => {
  it("preserves Chinese on upgrade and follows the primary system language only when requested", () => {
    expect(readUiLanguagePreference(null)).toBe("zh-CN");
    expect(readUiLanguagePreference("future-language")).toBe("zh-CN");
    expect(resolveUiLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveUiLocale("system", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveUiLocale("system", ["zh-TW", "en-US"])).toBe("zh-CN");
  });

  it("returns readable text and interpolates 0 without treating user text as HTML", () => {
    expect(translate("en", "folder.name.too-long", { limit: 40 })).toBe("Use no more than 40 characters");
    expect(translate("zh-CN", "folder.name.count", { count: 0, limit: 40 })).toBe("0/40");
    expect(translate("en", "folder.name.count", { count: "<b>0</b>", limit: 40 })).toBe("<b>0</b>/40");
    const previous = en["common.cancel"];
    try {
      en["common.cancel"] = "";
      expect(translate("en", "common.cancel")).toBe("取消");
    } finally {
      en["common.cancel"] = previous;
    }
  });

  it("keeps stable snapshots, notifies changes, and does not overwrite an unknown stored preference", () => {
    const write = vi.fn();
    let languages = ["en-US"];
    const store = createUiLanguageStore({ read: () => "future-language", write, systemLanguages: () => languages });
    const first = store.getSnapshot();
    store.refreshSystemLanguages();
    expect(store.getSnapshot()).toBe(first);
    expect(write).not.toHaveBeenCalled();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setPreference("system");
    expect(store.getSnapshot()).toEqual({ preference: "system", locale: "en" });
    languages = ["zh-CN"];
    store.refreshSystemLanguages();
    expect(store.getSnapshot().locale).toBe("zh-CN");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.setPreference("en");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(write.mock.calls).toEqual([["system"], ["en"]]);
  });

  it("does not announce a saved choice when preference persistence fails", () => {
    const store = createUiLanguageStore({
      read: () => null,
      write: () => { throw new Error("storage blocked"); },
      systemLanguages: () => ["en"],
    });
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() => store.setPreference("en")).toThrow("storage blocked");
    expect(store.getSnapshot()).toEqual({ preference: "zh-CN", locale: "zh-CN" });
    expect(listener).not.toHaveBeenCalled();
  });
});
